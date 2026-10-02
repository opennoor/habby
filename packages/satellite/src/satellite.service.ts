import { Injectable, Inject, OnDestroy, NgZone } from '@angular/core';
import { AppService, BOOTSTRAP_DATA, ConfigService, type BootstrapData } from 'tabby-core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Subscription } from 'rxjs';
import { authorize, TOOL_BY_NAME } from '../../../shared/catalog';
import { defaultStateDir } from '../../../shared/paths';
import { HubError, type Principal, type SatelliteTrust, type Snapshot } from '../../../shared/protocol';
import { SatelliteClient, type SatelliteAdapter } from './client';
import { requestContext } from './request-context';
import { OutputRings } from './runtime';
import { TerminalToolCategory } from './tools/terminal';
import { TabManagementToolCategory } from './tools/tabManagement';
import { SFTPToolCategory } from './tools/sftp';

function payload(result: any) {
    const text = result?.content?.find((item: any) => item.type === 'text')?.text;
    return text ? JSON.parse(text) : result;
}
@Injectable({ providedIn: 'root' })
export class SatelliteService implements SatelliteAdapter, OnDestroy {
    readonly client: SatelliteClient;
    private output = new OutputRings();
    private streams = new Map<string, { source: unknown; subscription: Subscription; destroyed?: Subscription }>();
    private tools;
    constructor(private app: AppService, private config: ConfigService, private zone: NgZone,
        private terminal: TerminalToolCategory, private tabs: TabManagementToolCategory, private sftp: SFTPToolCategory,
        @Inject(BOOTSTRAP_DATA) private bootstrap: BootstrapData) {
        this.tools = new Map([...terminal.mcpTools, ...tabs.mcpTools, ...sftp.mcpTools].map(tool => [tool.name, tool]));
        this.client = new SatelliteClient(() => JSON.parse(readFileSync(join(this.stateDir(), 'satellite.json'), 'utf8')) as SatelliteTrust,
            this, { nativeWindowId: bootstrap.windowID, platform: process.platform, pluginVersion: '0.1.0' });
    }
    private stateDir() {
        if (this.config.store.hubSatellite?.stateDir) return this.config.store.hubSatellite.stateDir;
        try { return JSON.parse(readFileSync(join(dirname(__dirname), 'hub-state.json'), 'utf8')).stateDir ?? defaultStateDir(); }
        catch { return defaultStateDir(); }
    }
    start() { if (this.config.store.hubSatellite?.enabled !== false) this.client.start(); }
    capabilities() {
        return [...this.tools.keys(), 'read_terminal_output'].filter(name =>
            (!name.startsWith('sftp_') || (this.sftp.isAvailable() && this.config.store.mcp?.sftp?.enabled !== false)) &&
            (name !== 'get_session_environment' || this.config.store.mcp?.environmentDetection?.enabled === true));
    }
    async snapshot(): Promise<Snapshot> {
        this.trackStreams();
        const profiles = payload(await this.tools.get('list_profiles')!.handler({}, {})).profiles ?? [];
        return {
            tabs: this.app.tabs.map((tab, index) => ({ id: this.tabs.getOrCreateTabId(tab), title: tab.title ?? '', tabIndex: index, active: tab.hasFocus })),
            sessions: this.terminal.findTerminalSessions().map(session => ({ id: session.sessionId, tabId: this.tabs.getOrCreateTabId(session.tabParent), title: session.tab.title ?? '', tabIndex: session.tabIndex, paneIndex: session.paneIndex, isFocusedPane: session.isFocusedPane, profileId: (session.tab as any).profile?.id })),
            profiles: profiles.map((profile: any) => ({ ...profile, id: profile.profileId, title: profile.name })),
            transfers: this.sftp.getTransfers().map(task => ({ id: task.id, status: task.status, sessionId: task.sessionId, progress: task.progress })),
        };
    }
    private trackStreams() {
        const sessions = this.terminal.findTerminalSessions();
        const live = new Set(sessions.map(session => session.sessionId));
        for (const [id, stream] of this.streams) {
            if (!live.has(id)) { stream.subscription.unsubscribe(); stream.destroyed?.unsubscribe(); this.streams.delete(id); this.output.close(id); }
        }
        for (const session of sessions) {
            const source = (session.tab as any).session?.binaryOutput$ ?? (session.tab as any).session?.output$;
            const existing = this.streams.get(session.sessionId);
            if (existing?.source === source) continue;
            existing?.subscription.unsubscribe(); existing?.destroyed?.unsubscribe();
            if (!source?.subscribe) continue;
            const subscription = source.subscribe((data: string | Buffer) => this.output.append(session.sessionId, data));
            const destroyed = (session.tab as any).destroyed?.subscribe(() => { this.output.close(session.sessionId); subscription.unsubscribe(); });
            this.streams.set(session.sessionId, { source, subscription, destroyed });
        }
    }
    async run(operation: string, rawParams: Record<string, unknown>, principal: Principal, signal: AbortSignal) {
        // Node WebSocket callbacks run outside Angular. ES2016 async lowering keeps
        // continuations on Zone-patched promises so newly created tabs initialize.
        return this.zone.run(async () => {
            const definition = TOOL_BY_NAME.get(operation);
            if (!definition || operation === 'list_windows') throw new HubError('UNKNOWN_TOOL', 'Window does not expose this operation.');
            const params = definition.schema.parse(rawParams) as Record<string, any>;
            if (params.windowId && params.windowId !== this.client.windowId) throw new HubError('WRONG_WINDOW', 'Target belongs to another window.');
            delete params.windowId;
            authorize(principal, operation, params, this.client.windowId);
            if (operation === 'get_session_environment') {
                // Read-only grants always use passive analysis, even with local active-probe mode selected.
                params.activeProbe = (params.activeProbe === true || (params.activeProbe !== false && this.config.store.mcp?.environmentDetection?.mode === 'active')) && principal.scopes.includes('terminal:write');
            }
            authorize(principal, operation, params, this.client.windowId);
            if (!this.capabilities().includes(operation)) throw new HubError('DISABLED_TOOL', 'Operation is disabled in this window settings.');
            if (signal.aborted) throw new HubError('CANCELLED', 'Request cancelled.');
            this.trackStreams();
            const sessionOperation = operation.startsWith('sftp_') || ['exec_command', 'send_input', 'submit_keyboard_interactive_response', 'get_session_environment', 'get_terminal_buffer', 'abort_command', 'focus_pane', 'read_terminal_output'].includes(operation);
            const requiresActiveTab = ['move_tab_left', 'move_tab_right', 'split_tab', 'next_tab', 'previous_tab'].includes(operation);
            if (params.tabId) {
                const tab = this.tabs.findTabByLocator({ tabId: params.tabId });
                if (!tab) throw new HubError('TARGET_GONE', 'Tab ID no longer exists.');
                if (sessionOperation) {
                    const sessions = this.terminal.findTerminalSessions().filter(session => session.tabParent === tab);
                    const session = (params.sessionId ? sessions.find(item => item.sessionId === params.sessionId) : sessions.find(item => item.isFocusedPane)) ?? (sessions.length === 1 ? sessions[0] : undefined);
                    if (!session) throw new HubError('AMBIGUOUS_TARGET', 'Tab contains several panes; choose a session ID.');
                    if (params.sessionId && params.sessionId !== session.sessionId) throw new HubError('TARGET_CONFLICT', 'Session does not match focused tab pane.');
                    params.sessionId = session.sessionId;
                } else {
                    params.tabIndex = this.app.tabs.indexOf(tab);
                    if (requiresActiveTab) this.app.selectTab(tab);
                }
            }
            if (params.sessionId) {
                const session = this.terminal.findSessionByLocator({ sessionId: params.sessionId });
                if (!session) throw new HubError('TARGET_GONE', 'Session ID no longer exists.');
                if (!sessionOperation) {
                    params.tabIndex = this.app.tabs.indexOf(session.tabParent);
                    if (requiresActiveTab) {
                        this.app.selectTab(session.tabParent);
                        if (session.isSplit) (session.tabParent as any).focus(session.tab);
                    }
                }
            }
            if (operation === 'read_terminal_output') {
                const session = this.terminal.findSessionByLocator(params);
                if (!session) throw new HubError('TARGET_GONE', 'Terminal target no longer exists.');
                if (!this.streams.has(session.sessionId)) throw new HubError('UNSUPPORTED_STREAM', 'Terminal output stream unavailable.');
                return { content: [{ type: 'text', text: JSON.stringify({ sessionId: session.sessionId, ...await this.output.read(session.sessionId, params.cursor, params.maxBytes, params.waitMs, signal) }) }] };
            }
            const result = await requestContext.run(signal, () => this.tools.get(operation)!.handler(params, { signal }));
            return result;
        });
    }
    disconnect() { /* Socket cancellation aborts pending reads. PTY output continues across Hub restarts. */ }
    ngOnDestroy() {
        this.client.stop();
        for (const stream of this.streams.values()) { stream.subscription.unsubscribe(); stream.destroyed?.unsubscribe(); }
        this.streams.clear(); this.output.dispose();
    }
}
