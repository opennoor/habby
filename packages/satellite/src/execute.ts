import { commandWrapper, CommandCapture, shellFromHints } from './runtime';
import { StringDecoder } from 'node:string_decoder';
import type { Subscription } from 'rxjs';
import { HubError } from '../../../shared/protocol';

/** Executes in Tabby's existing PTY; no local process is launched here. */
export async function execute(category: any, params: any, context: { signal?: AbortSignal } = {}) {
    const session = category.findSessionByLocator(params);
    if (!session) throw new HubError('TARGET_GONE', 'Terminal target no longer exists.');
    category.ensureSessionValid(session);
    if (category._activeCommands.has(session.sessionId)) throw new HubError('SESSION_BUSY', 'One monitored command per pane.');
    const pair = category.config.store.mcp?.pairProgrammingMode;
    if (pair?.enabled && pair?.showConfirmationDialog && !await category.dialogService.showCommandConfirmation(params.command, session.tabIndex)) {
        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Command rejected by user' }) }] };
    }
    if (category._activeCommands.has(session.sessionId)) throw new HubError('SESSION_BUSY', 'One monitored command per pane.');
    if (context.signal?.aborted) throw new HubError('CANCELLED', 'Request cancelled.');
    if (!category.config.store.mcp?.backgroundExecution?.enabled && pair?.autoFocusTerminal !== false) {
        category.app.selectTab(session.tabParent);
        if (session.isSplit) session.tabParent.focus(session.tab);
    }
    if (params.waitForOutput === false) {
        session.tab.sendInput(params.command + '\r');
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: session.sessionId, monitored: false, message: 'Input sent; completion is not tracked.' }) }] };
    }
    const tab = session.tab;
    const hints = [tab.profile?.options?.command, tab.profile?.options?.shell, tab.profile?.name, tab.session?.command, tab.session?.shell, tab.title].filter(Boolean).join(' ');
    const parsed = category.parseEnvironmentFromBuffer(session, category.getTerminalBufferText(session), true);
    if (!parsed.isShell) throw new HubError('UNSUPPORTED_SHELL', 'Terminal appears to be a REPL; use send_input.');
    const posixPrompt = /[$#%]\s*$/.test(parsed.promptClean);
    const inferred = parsed.environment === 'shell' && posixPrompt ? category.detectShellType(session) : parsed.environment;
    const shell = shellFromHints(hints + ' ' + inferred);
    const wrapper = commandWrapper(params.command, shell);
    const output$ = tab.session?.binaryOutput$ ?? tab.session?.output$;
    if (!output$?.subscribe) throw new HubError('UNSUPPORTED_STREAM', 'Output stream unavailable; use send_input.');
    return await new Promise((resolve, reject) => {
        const capture = new CommandCapture(wrapper.start, wrapper.end);
        const decoder = new StringDecoder('utf8');
        let subscription: Subscription | undefined, destroyed: Subscription | undefined;
        let ended = false, responded = false;
        const finish = (result: any, release: boolean) => {
            if (release && !ended) {
                ended = true; clearTimeout(timer); subscription?.unsubscribe(); destroyed?.unsubscribe();
                context.signal?.removeEventListener('abort', cancelled);
                category._activeCommands.delete(session.sessionId); category._activeCommandsSubject.next(new Map(category._activeCommands));
            }
            if (!responded) { responded = true; resolve({ content: [{ type: 'text', text: JSON.stringify({ ...result, sessionId: session.sessionId }) }] }); }
        };
        const cancelled = () => finish({ success: false, error: 'CANCELLED', output: capture.partial(), outcomeUnknown: true }, false);
        const timer = setTimeout(() => finish({ success: false, error: 'TIMEOUT', output: capture.partial(), outcomeUnknown: true, stillMonitored: true }, false), Math.max(1, Math.min(params.timeout ?? 30000, 300000)));
        category._activeCommands.set(session.sessionId, { command: params.command, tabId: session.tabIndex, timestamp: Date.now(), startMarker: wrapper.start, endMarker: wrapper.end,
            abort: () => finish({ success: false, error: 'ABORTED', output: capture.partial() }, true) });
        category._activeCommandsSubject.next(new Map(category._activeCommands));
        subscription = output$.subscribe({ next: (chunk: string | Buffer) => {
            const result = capture.feed(Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk);
            if (result) finish({ ...result, success: result.exitCode === 0 }, true);
        }, complete: () => finish({ success: false, error: 'SESSION_CLOSED', output: capture.partial(), outcomeUnknown: true }, true) });
        destroyed = tab.destroyed?.subscribe(() => finish({ success: false, error: 'SESSION_CLOSED', output: capture.partial(), outcomeUnknown: true }, true));
        context.signal?.addEventListener('abort', cancelled, { once: true });
        try { session.tab.sendInput(wrapper.text + '\r'); }
        catch (error) { finish({ success: false, error: 'INPUT_FAILED' }, true); reject(error); }
    });
}
