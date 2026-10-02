import { checkRequest, requestContext } from '../request-context';
import { execute } from '../execute';
import { shellFromHints } from '../runtime';
import { uniqueMatch } from '../runtime';
// Adapted from GentlemanHu/Tabby-MCP, MIT, copyright 2026 GentlemanHu.
// Revision 86a52fdfadb724959929f052c1fc89a45c9f1b0f; see THIRD_PARTY_NOTICES.md.
import { Injectable } from '@angular/core';
import { AppService, BaseTabComponent, ConfigService, SplitTabComponent } from 'tabby-core';
import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal';
import { SerializeAddon } from '@xterm/addon-serialize';
import stripAnsi from 'strip-ansi';
import { BehaviorSubject } from 'rxjs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { BaseToolCategory } from './base-tool-category';
import { McpLoggerService } from '../services/mcpLogger.service';
import { DialogService } from '../services/dialog.service';
import { McpTool, ActiveCommand, CommandResult, EnhancedTerminalSession, SessionLocator } from '../types/types';

/**
 * Terminal session with stable ID for tracking
 * Enhanced to support split pane identification
 */
export interface TerminalSessionWithTab {
    sessionId: string;        // Stable UUID (unique per pane)
    tabIndex: number;         // Global index across all panes
    tabParent: BaseTabComponent;  // The actual tab (may be SplitTabComponent)
    tab: BaseTerminalTabComponent;  // The terminal component

    // Split pane information
    isSplit: boolean;         // Is this pane inside a SplitTabComponent?
    splitTabIndex?: number;   // Index of the parent SplitTabComponent in app.tabs
    paneIndex?: number;       // Index within the SplitTabComponent (0, 1, 2, ...)
    totalPanes?: number;      // Total panes in the split
    isFocusedPane?: boolean;  // Is this the focused pane in the split?
}

/**
 * Terminal Tools Category - Commands for terminal control
 * Enhanced with stable session IDs and flexible session targeting
 */
@Injectable({ providedIn: 'root' })
export class TerminalToolCategory extends BaseToolCategory {
    name = 'terminal';

    // Session registry for stable IDs (UUID per tab)
    private tabToSessionId = new WeakMap<BaseTerminalTabComponent, string>();

    // Active commands tracked by sessionId
    private _activeCommands = new Map<string, ActiveCommand>();
    private _activeCommandsSubject = new BehaviorSubject<Map<string, ActiveCommand>>(new Map());

    // Shell type cache per session (avoids repeated detection)
    private shellTypeCache = new Map<string, 'bash' | 'zsh' | 'fish' | 'sh' | 'powershell' | 'cmd'>();

    public readonly activeCommands$ = this._activeCommandsSubject.asObservable();

    constructor(
        private app: AppService,
        logger: McpLoggerService,
        private config: ConfigService,
        private dialogService: DialogService
    ) {
        super(logger);
        this.initializeTools();
    }

    /**
     * Initialize all terminal tools
     */
    private initializeTools(): void {
        this.registerTool(this.createGetSessionListTool());
        this.registerTool(this.createExecCommandTool());
        this.registerTool(this.createSendInputTool());
        this.registerTool(this.createSubmitKeyboardInteractiveResponseTool());
        this.registerTool(this.createGetTerminalBufferTool());
        this.registerTool(this.createAbortCommandTool());
        this.registerTool(this.createGetCommandStatusTool());
        this.registerTool(this.createFocusPaneTool());
        this.registerTool(this.createGetSessionEnvironmentTool());

        this.logger.info('Terminal tools initialized');
    }

    /**
     * Get or create a stable session ID for a tab
     * Made public for cross-category access (e.g., from TabManagementToolCategory)
     */
    public getOrCreateSessionId(tab: BaseTerminalTabComponent): string {
        let sessionId = this.tabToSessionId.get(tab);
        if (!sessionId) {
            sessionId = randomUUID();
            this.tabToSessionId.set(tab, sessionId);
        }
        return sessionId;
    }

    /**
     * Detect shell type from terminal session info
     * Used to generate shell-compatible command wrappers
     *
     * Detection priority:
     * 1. Cached result (if previously detected)
     * 2. Terminal buffer analysis (most accurate for active sessions)
     * 3. Profile type/name hints
     * 4. Terminal title hints
     * 5. Default to 'sh' (POSIX fallback)
     */
    private detectShellType(session: TerminalSessionWithTab): 'bash' | 'zsh' | 'fish' | 'sh' | 'powershell' | 'cmd' {
        // Step 1: Check cache first
        const cached = this.shellTypeCache.get(session.sessionId);
        if (cached) {
            this.logger.debug(`Shell type from cache: ${cached} for session ${session.sessionId}`);
            return cached;
        }

        const tabAny = session.tab as any;
        const executable = [tabAny.profile?.options?.command, tabAny.profile?.options?.shell, tabAny.profile?.name].filter(Boolean).join(' ');
        if (/\b(powershell|pwsh|cmd)(\.exe)?\b/i.test(executable)) return shellFromHints(executable) as 'powershell' | 'cmd';

        // Step 2: Analyze terminal buffer for shell-specific patterns
        // This is the most reliable method for connected sessions
        try {
            const buffer = this.getTerminalBufferText(session);
            if (buffer && buffer.length > 0) {
                // Fish-specific patterns
                // - Welcome message: "Welcome to fish"
                // - Error message when using $?: "fish: $? is not the exit status"
                // - Fish version info: "fish, version X.Y.Z"
                // - Fish default prompts: ❯, ⏎, or specific fish greeting
                const fishBufferPatterns = [
                    /Welcome to fish/i,
                    /fish:.*\$\? is not the exit status/i,
                    /fish,?\s*version/i,
                    /In fish, please use \$status/i,
                ];

                for (const pattern of fishBufferPatterns) {
                    if (pattern.test(buffer)) {
                        this.logger.info(`Detected fish shell from buffer pattern: ${pattern}`);
                        this.shellTypeCache.set(session.sessionId, 'fish');
                        return 'fish';
                    }
                }

                // Bash-specific patterns
                const bashBufferPatterns = [
                    /bash.*version/i,
                    /GNU bash/i,
                ];
                for (const pattern of bashBufferPatterns) {
                    if (pattern.test(buffer)) {
                        this.logger.info(`Detected bash shell from buffer pattern`);
                        this.shellTypeCache.set(session.sessionId, 'bash');
                        return 'bash';
                    }
                }

                // Zsh-specific patterns
                const zshBufferPatterns = [
                    /zsh.*version/i,
                    /oh-my-zsh/i,
                ];
                for (const pattern of zshBufferPatterns) {
                    if (pattern.test(buffer)) {
                        this.logger.info(`Detected zsh shell from buffer pattern`);
                        this.shellTypeCache.set(session.sessionId, 'zsh');
                        return 'zsh';
                    }
                }
            }
        } catch (e) {
            this.logger.debug(`Buffer analysis failed, falling back to profile/title hints`);
        }

        // Step 3: Check profile info (fallback)
        const profileName = tabAny.profile?.name || '';
        const profileType = tabAny.profile?.type || '';
        const profileOptions = tabAny.profile?.options || {};
        const shellPath = profileOptions.shell || profileOptions.command || '';
        const allProfileText = `${profileName} ${profileType} ${shellPath}`.toLowerCase();

        const fishPatterns = [/\bfish\b/i, /fish$/i];
        const zshPatterns = [/\bzsh\b/i, /zsh$/i];
        const bashPatterns = [/\bbash\b/i, /bash$/i];

        if (fishPatterns.some(p => p.test(allProfileText))) {
            this.logger.debug(`Detected fish shell from profile: ${profileName}`);
            this.shellTypeCache.set(session.sessionId, 'fish');
            return 'fish';
        }
        if (zshPatterns.some(p => p.test(allProfileText))) {
            this.logger.debug(`Detected zsh shell from profile: ${profileName}`);
            this.shellTypeCache.set(session.sessionId, 'zsh');
            return 'zsh';
        }
        if (bashPatterns.some(p => p.test(allProfileText))) {
            this.logger.debug(`Detected bash shell from profile: ${profileName}`);
            this.shellTypeCache.set(session.sessionId, 'bash');
            return 'bash';
        }

        // Step 4: Check terminal title (last resort)
        const title = session.tab.title || '';
        if (fishPatterns.some(p => p.test(title))) {
            this.logger.debug(`Detected fish shell from title: ${title}`);
            this.shellTypeCache.set(session.sessionId, 'fish');
            return 'fish';
        }
        if (zshPatterns.some(p => p.test(title))) {
            this.logger.debug(`Detected zsh shell from title: ${title}`);
            this.shellTypeCache.set(session.sessionId, 'zsh');
            return 'zsh';
        }
        if (bashPatterns.some(p => p.test(title))) {
            this.logger.debug(`Detected bash shell from title: ${title}`);
            this.shellTypeCache.set(session.sessionId, 'bash');
            return 'bash';
        }

        // Step 5: Default to 'sh' (POSIX compatible - safest fallback)
        this.logger.debug(`Shell type unknown, defaulting to sh (POSIX) for session ${session.sessionId}`);
        // Don't cache unknown - allow re-detection on next command
        return 'sh';
    }



    /**
     * Generate shell-compatible wrapped command for output capture
     *
     * CRITICAL: Commands are wrapped in `eval` to ensure that syntax errors
     * in the user command do NOT prevent the end marker from being printed.
     * Without eval, a syntax error causes the shell to reject the entire line,
     * including our end marker, causing the MCP server to hang until timeout.
     *
     * Different shells use different syntax:
     * - bash/zsh/sh: eval '...' with single-quote escaping, $? for exit code
     * - fish: eval "..." with backslash escaping, $status for exit code
     */
    /**
     * Find session by flexible locator
     * Priority: sessionId > tabIndex > title > profileName
     * If no locator is provided, returns the currently active/focused session
     */
    public findSessionByLocator(locator: SessionLocator): TerminalSessionWithTab | null {
        const sessions = this.findTerminalSessions();
        if (locator.sessionId) return sessions.find(s => s.sessionId === locator.sessionId) ?? null;
        if (locator.tabIndex !== undefined) return sessions.find(s => s.tabIndex === locator.tabIndex) ?? null;
        if (locator.title) return uniqueMatch(sessions, s => !!s.tab.title?.toLowerCase().includes(locator.title!.toLowerCase()));
        if (locator.profileName) return uniqueMatch(sessions, s => !!(s.tab as any).profile?.name?.toLowerCase().includes(locator.profileName!.toLowerCase()));
        return sessions.find(s => s.tabParent.hasFocus && (!s.isSplit || s.isFocusedPane)) ?? null;
    }

    private getKeyboardInteractivePrompt(session: TerminalSessionWithTab): any | null {
        return (session.tab as any).activeKIPrompt ?? null;
    }

    private describeKeyboardInteractivePrompt(prompt: any): any | undefined {
        if (!prompt) {
            return undefined;
        }

        return {
            name: prompt.name ?? '',
            instruction: prompt.instruction ?? '',
            prompts: Array.isArray(prompt.prompts)
                ? prompt.prompts.map((entry: any, index: number) => {
                    // Current Tabby uses strings; older releases exposed prompt objects.
                    const text = typeof entry === 'string'
                        ? entry
                        : String(entry?.prompt ?? '');
                    return {
                        index,
                        prompt: text,
                        echo: typeof entry === 'object' && entry !== null
                            ? entry.echo !== false
                            : true,
                        isPassword: /password/i.test(text)
                    };
                })
                : [],
            responseCount: Array.isArray(prompt.responses) ? prompt.responses.length : 0
        };
    }

    /**
     * Tool: Get list of terminal sessions with enhanced metadata
     * Now includes detailed split pane information
     */
    private createGetSessionListTool(): McpTool {
        return {
            name: 'get_session_list',
            description: `Get list of all terminal sessions with stable IDs and metadata.
Use sessionId (stable UUID) for reliable session targeting.

For split panes:
- isSplit: true if this session is inside a split tab
- splitTabIndex: Index of parent tab (use for grouping panes)
- paneIndex: Position within the split (0, 1, 2, ...)
- totalPanes: Number of panes in the split
- isFocusedPane: Whether this is the currently focused pane`,
            schema: z.object({}),
            handler: async () => {
                const sessions = this.findTerminalSessions();
                const tracking = this.config.store.mcp?.sessionTracking;
                const result = sessions.map(s => {
                    const tabAny = s.tab as any;
                    const keyboardInteractivePrompt = this.getKeyboardInteractivePrompt(s);
                    return {
                        sessionId: s.sessionId,
                        tabIndex: s.tabIndex,
                        title: s.tab.title || `Terminal ${s.tabIndex}`,
                        type: s.tab.constructor.name,
                        isActive: this.app.activeTab === s.tabParent,
                        hasActiveCommand: this._activeCommands.has(s.sessionId),
                        sshConnected: tabAny.sshSession?.open === true,
                        keyboardInteractivePending: Boolean(keyboardInteractivePrompt),
                        keyboardInteractivePrompt: this.describeKeyboardInteractivePrompt(keyboardInteractivePrompt),
                        profile: tracking?.includeProfileInfo !== false && tabAny.profile ? {
                            id: tabAny.profile.id,
                            name: tabAny.profile.name,
                            type: tabAny.profile.type
                        } : undefined,
                        pid: tracking?.includePid !== false ? tabAny.session?.pty?.pid : undefined,
                        cwd: tracking?.includeCwd !== false ? tabAny.session?.cwd : undefined,
                        // Split pane information
                        isSplit: s.isSplit,
                        splitTabIndex: s.splitTabIndex,
                        paneIndex: s.paneIndex,
                        totalPanes: s.totalPanes,
                        isFocusedPane: s.isFocusedPane
                    };
                });

                this.logger.info(`Found ${result.length} terminal sessions`);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
        };
    }

    /**
     * Tool: Execute command in terminal
     * Enhanced with flexible session targeting
     */
    private createExecCommandTool(): McpTool {
        return { name: 'exec_command', description: 'Execute in the target PTY.', schema: z.object({}), handler: (params, context) => execute(this, params, context) };
    }

    /**
     * Check if a session is valid (tab exists and is connected)
     * Returns true if valid, throws error if invalid
     */
    private ensureSessionValid(session: TerminalSessionWithTab): void {
        if (!this.findTerminalSessions().some(s => s.tab === session.tab) || (session.tab as any).session?.open === false) throw new Error('SESSION_CLOSED');
    }

    /**
     * Tool: Send raw input to terminal (for interactive commands)
     */
    private createSendInputTool(): McpTool {
        return {
            name: 'send_input',
            description: `Send raw input to a terminal. Use this for interactive commands like vim, less, top, etc.
Session targeting: sessionId (recommended) > tabIndex > title > profileName
Special keys: \\x03 (Ctrl+C), \\x04 (Ctrl+D), \\x1b (Escape), \\r (Enter)`,
            schema: z.object({
                input: z.string().describe('Input to send (can include special characters like \\n, \\x03 for Ctrl+C)'),
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            }),
            handler: async (params: { input: string; sessionId?: string; tabIndex?: number; title?: string; profileName?: string }) => {
                const { input, sessionId, tabIndex, title, profileName } = params;

                const session = this.findSessionByLocator({ sessionId, tabIndex, title, profileName });

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found',
                                hint: 'Use get_session_list to see available sessions'
                            })
                        }]
                    };
                }

                try {
                    this.ensureSessionValid(session);
                } catch (error: any) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }

                const processedInput = input
                    .replace(/\\n/g, '\n')
                    .replace(/\\r/g, '\r')
                    .replace(/\\t/g, '\t')
                    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

                // Raw input can execute commands through Enter/newline, so command
                // confirmation must not be disabled by the separate SFTP approval option.
                const pairMode = this.config.store.mcp?.pairProgrammingMode;
                if (pairMode?.enabled && pairMode?.showConfirmationDialog) {
                    const confirmed = await this.dialogService.showOperationConfirmation(
                        'send_input',
                        session.tab.title || `Terminal ${session.tabIndex}`,
                        `Terminal input after escape decoding:\n${JSON.stringify(processedInput)}`
                    );
                    if (!confirmed) {
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Input rejected by user' }) }]
                        };
                    }
                }

                try {
                    checkRequest();
                session.tab.sendInput(processedInput);
                    this.logger.info(`Sent input to session ${session.sessionId}`);

                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: session.sessionId, message: 'Input sent' }) }]
                    };
                } catch (error: any) {
                    this.logger.error(`Error sending input to session ${session.sessionId}:`, error);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: `Failed to send input: ${error.message}. Session might be disconnected.`,
                                sessionId: session.sessionId
                            })
                        }]
                    };
                }
            }
        };
    }

    /**
     * Tool: Submit response to Tabby's SSH keyboard-interactive auth panel
     */
    private createSubmitKeyboardInteractiveResponseTool(): McpTool {
        return {
            name: 'submit_keyboard_interactive_response',
            description: `Submit response(s) to an active SSH keyboard-interactive authentication prompt.
Use this for MFA/TOTP prompts shown by Tabby's SSH authentication panel, such as Jumpserver MFA.

This tool targets Tabby's activeKIPrompt object directly; it is different from send_input,
which writes to the terminal pty and cannot answer Tabby's auth form.

Session targeting: sessionId (recommended) > tabIndex > title > profileName`,
            schema: z.object({
                response: z.string().optional().describe('Single response for prompts with one field, such as a 6-digit TOTP code'),
                responses: z.array(z.string()).optional().describe('Responses for multi-prompt keyboard-interactive auth, in prompt order'),
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            }),
            handler: async (params: {
                response?: string;
                responses?: string[];
                sessionId?: string;
                tabIndex?: number;
                title?: string;
                profileName?: string;
            }) => {
                const { response, responses, sessionId, tabIndex, title, profileName } = params;
                const session = this.findSessionByLocator({ sessionId, tabIndex, title, profileName });

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found',
                                hint: 'Use get_session_list to see available sessions'
                            })
                        }]
                    };
                }

                const prompt = this.getKeyboardInteractivePrompt(session);
                if (!prompt) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                keyboardInteractivePending: false,
                                error: 'No active keyboard-interactive prompt on this session'
                            })
                        }]
                    };
                }

                const providedResponses = responses ?? (response !== undefined ? [response] : undefined);
                if (!providedResponses || providedResponses.length === 0) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                keyboardInteractivePending: true,
                                keyboardInteractivePrompt: this.describeKeyboardInteractivePrompt(prompt),
                                error: 'Provide response or responses'
                            })
                        }]
                    };
                }

                if (!Array.isArray(prompt.responses) || !Array.isArray(prompt.prompts)) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                error: 'Active keyboard-interactive prompt has an unexpected shape',
                                keyboardInteractivePrompt: this.describeKeyboardInteractivePrompt(prompt)
                            })
                        }]
                    };
                }

                if (providedResponses.length !== prompt.prompts.length) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                error: `Expected ${prompt.prompts.length} response(s), got ${providedResponses.length}`,
                                keyboardInteractivePrompt: this.describeKeyboardInteractivePrompt(prompt)
                            })
                        }]
                    };
                }

                if (typeof prompt.respond !== 'function') {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                error: 'Keyboard-interactive prompt does not expose respond()'
                            })
                        }]
                    };
                }

                const pairMode = this.config.store.mcp?.pairProgrammingMode;
                if (pairMode?.enabled && pairMode?.showConfirmationDialog) {
                    const confirmed = await this.dialogService.showOperationConfirmation(
                        'submit_keyboard_interactive_response',
                        session.tab.title || `Terminal ${session.tabIndex}`,
                        `${providedResponses.length} keyboard-interactive response(s)`
                    );
                    if (!confirmed) {
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: false,
                                    sessionId: session.sessionId,
                                    error: 'Keyboard-interactive response rejected by user'
                                })
                            }]
                        };
                    }
                }

                const previousResponses = [...prompt.responses];
                try {
                    providedResponses.forEach((value, index) => {
                        prompt.responses[index] = value;
                    });

                    checkRequest();
                    prompt.respond();
                    (session.tab as any).activeKIPrompt = null;
                    (session.tab as any).frontend?.focus?.();

                    this.logger.info(`Submitted keyboard-interactive response for session ${session.sessionId}`);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true,
                                sessionId: session.sessionId,
                                submitted: true,
                                responseCount: providedResponses.length,
                                message: 'Keyboard-interactive response submitted'
                            })
                        }]
                    };
                } catch (error: any) {
                    prompt.responses.splice(0, prompt.responses.length, ...previousResponses);
                    this.logger.error(`Error submitting keyboard-interactive response for session ${session.sessionId}:`, error);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                sessionId: session.sessionId,
                                error: `Failed to submit keyboard-interactive response: ${error.message || error}`
                            })
                        }]
                    };
                }
            }
        };
    }

    private parseEnvironmentFromBuffer(
        session: TerminalSessionWithTab,
        bufferContent: string,
        useEnhancedHeuristics: boolean
    ): { environment: string; isShell: boolean; promptRaw: string; promptClean: string } {
        const normalizedLines = bufferContent
            .split('\n')
            .map(line => {
                const raw = line.trimEnd();
                const clean = useEnhancedHeuristics
                    ? stripAnsi(raw).replace(/\[[0-9;?]*[a-zA-Z]/g, '').trim()
                    : raw.trim();
                return { raw, clean };
            })
            .filter(line => line.raw.length > 0 || line.clean.length > 0);

        const replMatchers: Array<{ environment: string; pattern: RegExp }> = [
            { environment: 'python', pattern: /^>>>$/ },
            { environment: 'ruby', pattern: /^(irb>|irb\(main\):.*)$/ },
            { environment: 'mysql', pattern: /^mysql>$/ },
            { environment: 'postgres', pattern: /^(postgres[=#>-]?|\w+=>|\w+=#)$/ },
            { environment: 'sqlite', pattern: /^sqlite>$/ },
            { environment: 'mongodb', pattern: /^(mongo>|mongosh>|Enterprise\s.+>)$/ },
            { environment: 'redis', pattern: /^127\.0\.0\.1:\d+>$/ },
            { environment: 'node', pattern: /^>$/ },
        ];

        let environment = 'unknown';
        let isShell = false;
        let promptRaw = '';
        let promptClean = '';
        const fallbackLine = normalizedLines.length > 0 ? normalizedLines[normalizedLines.length - 1] : { raw: '', clean: '' };

        for (let i = normalizedLines.length - 1; i >= Math.max(0, normalizedLines.length - 1); i--) {
            const candidate = normalizedLines[i];
            if (!candidate.clean) {
                continue;
            }

            const replMatch = replMatchers.find(m => m.pattern.test(candidate.clean));
            if (replMatch) {
                environment = replMatch.environment;
                promptRaw = candidate.raw;
                promptClean = candidate.clean;
                break;
            }

            if (/[$#%❯➜]\s*$/.test(candidate.clean)) {
                isShell = true;
                const detectedShell = this.detectShellType(session);
                environment = detectedShell === 'sh' ? 'shell' : detectedShell;
                promptRaw = candidate.raw;
                promptClean = candidate.clean;
                break;
            }
        }

        if (!promptRaw) {
            isShell = true;
            const detectedShell = this.detectShellType(session);
            environment = detectedShell === 'sh' ? 'shell' : detectedShell;
            promptRaw = fallbackLine.raw;
            promptClean = fallbackLine.clean;
        }

        return { environment, isShell, promptRaw, promptClean };
    }

    /**
     * Tool: Get the current environment context of a session
     */
    private createGetSessionEnvironmentTool(): McpTool {
        return {
            name: 'get_session_environment',
            description: `Get the environment context of a terminal session (e.g., bash, python, node, database REPL).
Use this before sending complex commands to ensure the session is in the expected state.
Session targeting: sessionId (recommended) > tabIndex > title > profileName`,
            schema: z.object({
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            }),
            handler: async (params: { sessionId?: string; tabIndex?: number; title?: string; profileName?: string }) => {
                const environmentDetectionConfig = this.config.store.mcp?.environmentDetection;
                if (environmentDetectionConfig?.enabled === false) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                enabled: false,
                                error: 'Environment detection is disabled in Settings → MCP',
                                hint: 'Enable Environment Detection in the MCP settings page before using get_session_environment.'
                            })
                        }]
                    };
                }

                const session = this.findSessionByLocator(params);

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found',
                                hint: 'Use get_session_list to see available sessions'
                            })
                        }]
                    };
                }

                try {
                    this.ensureSessionValid(session);
                } catch (error: any) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }

                const useEnhancedHeuristics = environmentDetectionConfig?.useEnhancedHeuristics !== false;
                const detectionMode = (params as any).activeProbe === true ? 'active' : 'heuristic';
                const bufferContent = this.getTerminalBufferText(session);
                const parsed = this.parseEnvironmentFromBuffer(session, bufferContent, useEnhancedHeuristics);
                let environment = parsed.environment;
                let isShell = parsed.isShell;
                const promptRaw = parsed.promptRaw;
                const promptClean = parsed.promptClean;

                const tabAny = session.tab as any;
                const profile = tabAny.profile ? {
                    id: tabAny.profile.id,
                    name: tabAny.profile.name,
                    type: tabAny.profile.type
                } : undefined;

                if (detectionMode === 'active' && isShell) {
                    const activeEnvironment = await this.detectActiveShellEnvironment(session);
                    if (activeEnvironment) {
                        environment = activeEnvironment.environment;
                        isShell = activeEnvironment.isShell;
                    }
                }

                const shell = isShell ? (['bash', 'zsh', 'fish', 'sh', 'powershell', 'cmd', 'shell'].includes(environment) ? environment : this.detectShellType(session)) : undefined;

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            sessionId: session.sessionId,
                            environment,
                            shell,
                            isShell,
                            lastPrompt: promptRaw,
                            normalizedPrompt: promptClean || undefined,
                            cwd: tabAny.session?.cwd,
                            pid: tabAny.session?.pty?.pid,
                            profile
                        }, null, 2)
                    }]
                };
            }
        };
    }

    private async detectActiveShellEnvironment(session: TerminalSessionWithTab): Promise<{ environment: string; isShell: boolean } | null> {
        const tab: any = session.tab;
        const hints = [tab.profile?.options?.command, tab.profile?.options?.shell, tab.profile?.name, tab.title].filter(Boolean).join(' ');
        const parsed = this.parseEnvironmentFromBuffer(session, this.getTerminalBufferText(session), true);
        const inferred = parsed.environment === 'shell' && /[$#%]\s*$/.test(parsed.promptClean) ? this.detectShellType(session) : parsed.environment;
        const shell = shellFromHints(hints + ' ' + inferred);
        const command = shell === 'powershell' ? "if ($env:VIRTUAL_ENV) {'python-venv'} elseif ($env:CONDA_DEFAULT_ENV) {'python-conda'} elseif ($env:IN_NIX_SHELL) {'nix-shell'} else {'shell'}"
            : shell === 'cmd' ? 'if defined VIRTUAL_ENV (echo python-venv) else (if defined CONDA_DEFAULT_ENV (echo python-conda) else (echo shell))'
            : shell === 'fish' ? 'if test -n "$VIRTUAL_ENV"; echo python-venv; else if test -n "$CONDA_DEFAULT_ENV"; echo python-conda; else; echo shell; end'
            : 'if [ -n "$VIRTUAL_ENV" ]; then echo python-venv; elif [ -n "$CONDA_DEFAULT_ENV" ]; then echo python-conda; elif [ -n "$IN_NIX_SHELL" ]; then echo nix-shell; else echo shell; fi';
        const response: any = await execute(this, { command, sessionId: session.sessionId, timeout: 3000 }, { signal: requestContext.getStore() });
        const result = JSON.parse(response.content[0].text);
        if (!result.success) return null;
        const environment = result.output.trim();
        return { environment, isShell: environment === 'shell' };
    }

    /**
     * Tool: Get terminal buffer content
     */
    private createGetTerminalBufferTool(): McpTool {
        return {
            name: 'get_terminal_buffer',
            description: `Get the content of a terminal buffer. Use this to check command output after using send_input or async exec_command.
Session targeting: sessionId (recommended) > tabIndex > title > profileName`,
            schema: z.object({
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name'),
                lastNLines: z.number().optional().describe('Get only the last N lines (default: all)'),
                startLine: z.number().optional().describe('Start line (0-indexed)'),
                endLine: z.number().optional().describe('End line (exclusive)')
            }),
            handler: async (params: {
                sessionId?: string;
                tabIndex?: number;
                title?: string;
                profileName?: string;
                lastNLines?: number;
                startLine?: number;
                endLine?: number;
            }) => {
                const { sessionId, tabIndex, title, profileName, lastNLines, startLine, endLine } = params;

                const session = this.findSessionByLocator({ sessionId, tabIndex, title, profileName });

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found',
                                hint: 'Use get_session_list to see available sessions'
                            })
                        }]
                    };
                }

                try {
                    this.ensureSessionValid(session);
                } catch (error: any) {
                    return {
                        content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }]
                    };
                }

                const bufferContent = this.getTerminalBufferText(session);
                const lines = bufferContent.split('\n');

                let selectedLines: string[];
                if (lastNLines !== undefined) {
                    selectedLines = lines.slice(-lastNLines);
                } else {
                    const start = startLine ?? 0;
                    const end = endLine ?? lines.length;
                    selectedLines = lines.slice(start, end);
                }

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            sessionId: session.sessionId,
                            tabIndex: session.tabIndex,
                            totalLines: lines.length,
                            returnedLines: selectedLines.length,
                            content: selectedLines.join('\n')
                        })
                    }]
                };
            }
        };
    }

    /**
     * Tool: Abort running command
     */
    private createAbortCommandTool(): McpTool {
        return {
            name: 'abort_command',
            description: `Abort a running command by sending Ctrl+C.
Session targeting: sessionId (recommended) > tabIndex > title > profileName`,
            schema: z.object({
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            }),
            handler: async (params: { sessionId?: string; tabIndex?: number; title?: string; profileName?: string }) => {
                const { sessionId, tabIndex, title, profileName } = params;

                const session = this.findSessionByLocator({ sessionId, tabIndex, title, profileName });

                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching terminal session found'
                            })
                        }]
                    };
                }

                const activeCommand = this._activeCommands.get(session.sessionId);
                if (activeCommand) {
                    activeCommand.abort();
                    this._activeCommands.delete(session.sessionId);
                    this._activeCommandsSubject.next(new Map(this._activeCommands));
                }

                // Send Ctrl+C
                checkRequest();
                session.tab.sendInput('\x03');

                this.logger.info(`Aborted command in session ${session.sessionId}`);
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: session.sessionId, message: 'Ctrl+C sent' }) }] };
            }
        };
    }

    /**
     * Tool: Get status of active commands
     */
    private createGetCommandStatusTool(): McpTool {
        return {
            name: 'get_command_status',
            description: 'Get the status of active/running commands across all terminals',
            schema: z.object({}),
            handler: async () => {
                const activeCommands = Array.from(this._activeCommands.entries()).map(([sessionId, cmd]) => ({
                    sessionId,
                    tabIndex: cmd.tabId,
                    command: cmd.command,
                    startedAt: new Date(cmd.timestamp).toISOString(),
                    runningFor: `${Math.round((Date.now() - cmd.timestamp) / 1000)}s`
                }));

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            activeCommands,
                            count: activeCommands.length
                        }, null, 2)
                    }]
                };
            }
        };
    }

    /**
     * Tool: Focus a specific pane in a split tab
     */
    private createFocusPaneTool(): McpTool {
        return {
            name: 'focus_pane',
            description: `Focus a specific pane in a split terminal tab.
Use sessionId to identify the exact pane to focus.
After focusing, commands sent to that split tab will go to the focused pane.`,
            schema: z.object({
                sessionId: z.string().describe('Session ID of the pane to focus (from get_session_list)')
            }),
            handler: async (params: { sessionId: string }) => {
                const { sessionId } = params;

                const session = this.findSessionByLocator({ sessionId });
                if (!session) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: 'No matching session found'
                            })
                        }]
                    };
                }

                // Check if the session is in a split tab
                if (session.isSplit && session.tabParent instanceof SplitTabComponent) {
                    const splitTab = session.tabParent as SplitTabComponent;
                    splitTab.focus(session.tab);

                    this.logger.info(`Focused pane ${session.paneIndex} in split tab`);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true,
                                message: `Focused pane ${session.paneIndex} of ${session.totalPanes}`,
                                sessionId: session.sessionId,
                                paneIndex: session.paneIndex,
                                title: session.tab.title
                            })
                        }]
                    };
                } else {
                    // Not in a split, just select the tab
                    this.app.selectTab(session.tabParent);

                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true,
                                message: 'Selected tab (not a split pane)',
                                sessionId: session.sessionId
                            })
                        }]
                    };
                }
            }
        };
    }

    /**
     * Find all terminal sessions with stable IDs
     * Enhanced to include split pane information
     */
    public findTerminalSessions(): TerminalSessionWithTab[] {
        const sessions: TerminalSessionWithTab[] = [];
        let globalIndex = 0;

        this.app.tabs.forEach((tab: BaseTabComponent, appTabIndex: number) => {
            if (tab instanceof BaseTerminalTabComponent) {
                // Single terminal tab (not in a split)
                const sessionId = this.getOrCreateSessionId(tab);
                sessions.push({
                    sessionId,
                    tabIndex: globalIndex++,
                    tabParent: tab,
                    tab: tab as BaseTerminalTabComponent,
                    isSplit: false
                });
            } else if (tab instanceof SplitTabComponent) {
                // Split tab containing multiple panes
                const splitTab = tab as SplitTabComponent;
                const childTabs = splitTab.getAllTabs().filter(
                    (childTab: BaseTabComponent) => childTab instanceof BaseTerminalTabComponent
                );
                const focusedTab = splitTab.getFocusedTab();
                const totalPanes = childTabs.length;

                childTabs.forEach((childTab: BaseTabComponent, paneIdx: number) => {
                    const termTab = childTab as BaseTerminalTabComponent;
                    const sessionId = this.getOrCreateSessionId(termTab);
                    sessions.push({
                        sessionId,
                        tabIndex: globalIndex++,
                        tabParent: tab,
                        tab: termTab,
                        isSplit: true,
                        splitTabIndex: appTabIndex,
                        paneIndex: paneIdx,
                        totalPanes: totalPanes,
                        isFocusedPane: childTab === focusedTab
                    });
                });
            }
        });

        return sessions;
    }

    /**
     * Get terminal buffer as text
     */
    private getTerminalBufferText(session: TerminalSessionWithTab): string {
        try {
            const frontend = session.tab.frontend as XTermFrontend;
            if (!frontend) {
                return '';
            }

            // Access xterm through type assertion since it may be private
            const xtermInstance = (frontend as any).xterm;
            if (!xtermInstance) {
                return '';
            }

            // Check if serialize addon is already registered
            let serializeAddon = (xtermInstance as any)._addonManager?._addons?.find(
                (addon: any) => addon.instance instanceof SerializeAddon
            )?.instance;

            if (!serializeAddon) {
                serializeAddon = new SerializeAddon();
                xtermInstance.loadAddon(serializeAddon);
            }

            return serializeAddon.serialize();
        } catch (err) {
            this.logger.error('Error getting terminal buffer:', err);
            return '';
        }
    }

}
