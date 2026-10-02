import { uniqueMatch } from '../runtime';
import { requestContext, checkRequest } from '../request-context';
// Adapted from GentlemanHu/Tabby-MCP, MIT, copyright 2026 GentlemanHu.
// Revision 86a52fdfadb724959929f052c1fc89a45c9f1b0f; see THIRD_PARTY_NOTICES.md.
import { Injectable } from '@angular/core';
import { AppService, SplitTabComponent, ConfigService } from 'tabby-core';
import { z } from 'zod';
import { BehaviorSubject } from 'rxjs';
import { BaseToolCategory } from './base-tool-category';
import { McpLoggerService } from '../services/mcpLogger.service';
import { DialogService } from '../services/dialog.service';
import { McpTool, SFTPFileInfo } from '../types/types';
import { TerminalToolCategory } from './terminal';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// Try to import tabby-ssh (optional dependency)
let SSHTabComponent: any;
let sftpAvailable = false;

try {
    const sshModule = require('tabby-ssh');
    SSHTabComponent = sshModule.SSHTabComponent;
    sftpAvailable = true;
} catch {
    // tabby-ssh not installed, SFTP features will be disabled
}

/**
 * Transfer task status
 */
interface TransferTask {
    id: string;
    type: 'upload' | 'download';
    localPath: string;
    remotePath: string;
    sessionId: string;
    connectionName: string;    // SSH connection title for display
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
    progress: number;          // 0-100
    bytesTransferred: number;
    totalBytes: number;
    startTime: number;
    endTime?: number;
    error?: string;
    speed?: number;            // bytes/sec
    cancelRequested: boolean;
    cancelCallback?: () => void;
}

/**
 * SFTP Tools Category - File transfer operations for SSH sessions
 * Uses Tabby's real SFTP API: SSHSession.openSFTP() -> SFTPSession
 *
 * PARAMETER NAMING CONVENTION:
 * - path: Remote path for single operations
 * - localPath/remotePath: For upload/download
 * - sourcePath/destPath: For rename/move
 *
 * TRANSFER MODES:
 * - sync=true (default): Wait for completion
 * - sync=false: Return immediately with transferId, use sftp_get_transfer_status
 */
@Injectable({ providedIn: 'root' })
export class SFTPToolCategory extends BaseToolCategory {
    name = 'sftp';

    // Cache SFTP sessions with TTL and SSH session reference
    // Key: sshSession object (using Map because we need to iterate for cleanup)
    // Value: { sftpSession, createdAt } - createdAt for TTL expiration
    private sftpSessionCache = new Map<any, { sftpSession: any; createdAt: number }>();
    private readonly SFTP_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL
    // Note: Session IDs are now managed by TerminalToolCategory for consistency

    // Transfer task queue
    private transferTasks = new Map<string, TransferTask>();
    private _transferTasksSubject = new BehaviorSubject<TransferTask[]>([]);
    public readonly transferTasks$ = this._transferTasksSubject.asObservable();
    private maxTransferHistory = 100;

    constructor(
        private app: AppService,
        private config: ConfigService,
        logger: McpLoggerService,
        private terminalTools: TerminalToolCategory,
        private dialogService: DialogService
    ) {
        super(logger);
        if (sftpAvailable) {
            this.initializeTools();
            this.logger.info('SFTP tools initialized (using Tabby SFTPSession API with shared session registry)');
        } else {
            this.logger.warn('SFTP tools not available (tabby-ssh not installed)');
        }
    }

    /**
     * Pair programming gate for state-changing/sensitive SFTP operations (Issue #9).
     * Returns true when the operation may proceed.
     */
    private async confirmSftpOperation(operation: string, connectionName: string, detail: string): Promise<boolean> {
        const pairMode = this.config.store.mcp?.pairProgrammingMode;
        if (!pairMode?.enabled || !pairMode?.showConfirmationDialog || pairMode?.confirmFileOperations === false) {
            return true;
        }
        return this.dialogService.showOperationConfirmation(operation, connectionName, detail);
    }

    /** Standard rejection response when the user denies an SFTP operation */
    private rejectedResponse(operation: string): any {
        return {
            content: [{
                type: 'text', text: JSON.stringify({
                    success: false,
                    error: `${operation} rejected by user`
                })
            }]
        };
    }

    public isAvailable(): boolean {
        return sftpAvailable;
    }

    private initializeTools(): void {
        // Basic SFTP operations
        this.registerTool(this.createListFilesTool());
        this.registerTool(this.createReadFileTool());
        this.registerTool(this.createWriteFileTool());
        this.registerTool(this.createMkdirTool());
        this.registerTool(this.createDeleteTool());
        this.registerTool(this.createRenameTool());
        this.registerTool(this.createStatTool());

        // File transfer operations
        this.registerTool(this.createUploadTool());
        this.registerTool(this.createDownloadTool());
        this.registerTool(this.createGetTransferStatusTool());
        this.registerTool(this.createListTransfersTool());
        this.registerTool(this.createCancelTransferTool());
    }

    private generateTransferId(): string {
        return `transfer_${randomUUID()}`;
    }

    private isTransferCancelled(task: TransferTask): boolean {
        return task.cancelRequested || task.status === 'cancelled';
    }

    /** Emit current transfer state to UI subscribers */
    private emitTransferUpdate(): void {
        this._transferTasksSubject.next(Array.from(this.transferTasks.values()));
    }

    private cleanupOldTransfers(): void {
        const tasks = Array.from(this.transferTasks.values());
        const completed = tasks.filter(t => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled' || t.status === 'unknown');
        if (completed.length > this.maxTransferHistory) {
            completed.sort((a, b) => (a.endTime || 0) - (b.endTime || 0));
            const toRemove = completed.slice(0, completed.length - this.maxTransferHistory);
            toRemove.forEach(t => this.transferTasks.delete(t.id));
            this.emitTransferUpdate();
        }
    }

    /** Wait for the backend or its completed close callback, never byte count alone. */
    private async waitForTransferComplete<T>(
        sftpPromise: Promise<T>,
        transferObj: { isComplete: () => boolean; isCancelled: () => boolean; cancel: () => void },
        sshSession?: { open: boolean },
        pollIntervalMs: number = 500,
        maxWaitMs: number = this.config.store.mcp?.sftp?.timeout ?? 60000
    ): Promise<T | 'completed_via_polling'> {
        const timeout = Number.isFinite(maxWaitMs) && maxWaitMs > 0 ? Math.min(maxWaitMs, 2147483647) : 60000;
        const signal = requestContext.getStore();
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const checkState = () => {
            if (signal?.aborted || transferObj.isCancelled()) throw new Error('Transfer cancelled');
            if (sshSession?.open === false) throw new Error('SSH connection lost during transfer');
        };
        const completion = new Promise<'completed_via_polling'>((resolve, reject) => {
            onAbort = () => reject(new Error('Transfer cancelled'));
            signal?.addEventListener('abort', onAbort, { once: true });
            deadlineTimer = setTimeout(() => reject(new Error(`Transfer timed out after ${timeout}ms`)), timeout);
            const poll = () => {
                try {
                    checkState();
                    if (transferObj.isComplete()) {
                        resolve('completed_via_polling');
                    } else {
                        pollTimer = setTimeout(poll, pollIntervalMs);
                    }
                } catch (error) { reject(error); }
            };
            try { checkState(); } catch (error) { reject(error); return; }
            pollTimer = setTimeout(poll, pollIntervalMs);
        });
        try {
            return await Promise.race([sftpPromise.then(result => {
                checkState();
                if (!transferObj.isComplete()) throw new Error('Transfer ended before the expected file size was transferred');
                return result;
            }), completion]);
        } catch (error) {
            transferObj.cancel();
            throw error;
        } finally {
            clearTimeout(pollTimer);
            clearTimeout(deadlineTimer);
            if (onAbort) signal?.removeEventListener('abort', onAbort);
        }
    }

    // ============== Public methods for UI ==============

    /** Get current snapshot of all transfers */
    public getTransfers(): TransferTask[] {
        return Array.from(this.transferTasks.values());
    }

    /** Cancel a transfer by ID (for UI button) */
    public cancelTransferById(transferId: string): boolean {
        const task = this.transferTasks.get(transferId);
        if (task && (task.status === 'pending' || task.status === 'running')) {
            task.cancelRequested = true;
            task.status = 'cancelled';
            task.endTime = Date.now();

            if (task.cancelCallback) {
                try {
                    task.cancelCallback();
                    this.logger.info(`Called cancel callback for task ${transferId}`);
                } catch (e) {
                    this.logger.error(`Error calling cancel callback for ${transferId}:`, e);
                }
            }

            // waitForTransferComplete polls isCancelled() and rejects the MCP
            // tool promise within one poll interval (500ms)
            this.emitTransferUpdate();
            this.logger.info(`Transfer ${transferId} cancellation requested by user`);
            return true;
        }
        return false;
    }

    /** Clear all completed/failed/cancelled transfers from history */
    public clearCompletedTransfers(): void {
        const toRemove: string[] = [];
        this.transferTasks.forEach((task, id) => {
            if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'unknown') {
                toRemove.push(id);
            }
        });
        toRemove.forEach(id => this.transferTasks.delete(id));
        this.emitTransferUpdate();
        this.logger.info(`Cleared ${toRemove.length} completed transfers`);
    }

    /**
     * Get session ID for a tab - delegates to TerminalToolCategory
     * This ensures SFTP uses the same session IDs as terminal tools
     */
    private getOrCreateSessionId(tab: any): string {
        // Delegate to terminal tools to ensure consistent session IDs
        // TerminalToolCategory.getOrCreateSessionId expects BaseTerminalTabComponent
        // SSHTabComponent extends BaseTerminalTabComponent, so this works
        return this.terminalTools.getOrCreateSessionId(tab);
    }

    private findAllSSHTabs(): any[] {
        if (!sftpAvailable) return [];

        const sshTabs: any[] = [];
        for (const tab of this.app.tabs) {
            if (tab instanceof SSHTabComponent) {
                sshTabs.push(tab);
            } else if (tab instanceof SplitTabComponent) {
                const splitTab = tab as SplitTabComponent;
                for (const childTab of splitTab.getAllTabs()) {
                    if (childTab instanceof SSHTabComponent) {
                        sshTabs.push(childTab);
                    }
                }
            }
        }
        return sshTabs;
    }

    private findSSHSession(locator: { sessionId?: string; tabIndex?: number; title?: string; profileName?: string }): { tab: any; sessionId: string } | null {
        if (!sftpAvailable) return null;
        const sessions = this.terminalTools.findTerminalSessions().filter(session => session.tab instanceof SSHTabComponent);
        let session;
        if (locator.sessionId) session = sessions.find(item => item.sessionId === locator.sessionId);
        else if (locator.tabIndex !== undefined) {
            // SFTP's legacy index addresses a top-level tab; use its focused pane.
            const parent = this.app.tabs[locator.tabIndex];
            const tab = parent instanceof SplitTabComponent ? parent.getFocusedTab() : parent;
            session = sessions.find(item => item.tab === tab);
        } else if (locator.title) session = uniqueMatch(sessions, item => !!item.tab.title?.toLowerCase().includes(locator.title!.toLowerCase()));
        else if (locator.profileName) session = uniqueMatch(sessions, item => !!(item.tab as any).profile?.name?.toLowerCase().includes(locator.profileName!.toLowerCase()));
        else session = sessions.find(item => item.tabParent.hasFocus && (!item.isSplit || item.isFocusedPane));
        return session ? { tab: session.tab, sessionId: session.sessionId } : null;
    }

    private async getSFTPSession(sshTab: any): Promise<any> {
        try {
            const sshSession = sshTab.sshSession;
            if (!sshSession) {
                this.logger.debug('[getSFTPSession] No sshSession on tab');
                return null;
            }

            // Check if SSH session itself is still open
            if (!sshSession.open) {
                this.logger.debug('[getSFTPSession] sshSession.open is false');
                // Clear any stale cache entry
                this.sftpSessionCache.delete(sshSession);
                return null;
            }

            // Check cache first
            const cached = this.sftpSessionCache.get(sshSession);
            if (cached) {
                const age = Date.now() - cached.createdAt;

                // Check TTL expiration (proactive cleanup before issues occur)
                if (age > this.SFTP_SESSION_TTL_MS) {
                    this.logger.info(`[getSFTPSession] SFTP session expired (age: ${Math.round(age / 1000)}s > TTL: ${this.SFTP_SESSION_TTL_MS / 1000}s). Recreating...`);
                    this.sftpSessionCache.delete(sshSession);
                    // Fall through to create new session
                } else {
                    // CRITICAL: Validate cached session is still alive
                    // Even within TTL, network issues can cause session to become stale
                    try {
                        // Quick health check with a lightweight operation
                        await Promise.race([
                            cached.sftpSession.stat('/'),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('SFTP health check timeout')), 3000)
                            )
                        ]);
                        this.logger.debug(`[getSFTPSession] Cached SFTP session validated (age: ${Math.round(age / 1000)}s)`);
                        return cached.sftpSession;
                    } catch (healthError: any) {
                        // Cached session is stale/broken, remove and recreate
                        this.logger.warn(`[getSFTPSession] Cached SFTP session failed health check: ${healthError.message}. Recreating...`);
                        this.sftpSessionCache.delete(sshSession);
                        // Fall through to create new session
                    }
                }
            }

            // Check if openSFTP is available
            if (typeof sshSession.openSFTP !== 'function') {
                this.logger.debug('[getSFTPSession] sshSession.openSFTP is not a function');
                return null;
            }

            // Create new SFTP session
            this.logger.debug('[getSFTPSession] Opening new SFTP session...');
            const sftpSession = await sshSession.openSFTP();

            // Store with creation timestamp for TTL management
            this.sftpSessionCache.set(sshSession, {
                sftpSession,
                createdAt: Date.now()
            });
            this.logger.info('[getSFTPSession] New SFTP session opened and cached');

            // Cleanup old entries from disconnected sessions
            this.cleanupStaleSFTPSessions();

            return sftpSession;
        } catch (error: any) {
            this.logger.error('[getSFTPSession] Failed to open SFTP session:', error.message || error);
            return null;
        }
    }

    /**
     * Cleanup stale SFTP sessions from closed SSH connections
     * Called periodically when creating new sessions
     */
    private cleanupStaleSFTPSessions(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const [sshSession, cached] of this.sftpSessionCache.entries()) {
            // Remove if SSH session is closed OR TTL expired
            if (sshSession.open === false || (now - cached.createdAt) > this.SFTP_SESSION_TTL_MS) {
                this.sftpSessionCache.delete(sshSession);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.logger.debug(`[cleanupStaleSFTPSessions] Removed ${cleaned} stale entries`);
        }
    }

    private readonly sessionSchema = {
        sessionId: z.string().optional().describe('SSH session ID (from get_session_list)'),
        tabIndex: z.number().optional().describe('Tab index of SSH session'),
        title: z.string().optional().describe('Match SSH session by tab title'),
        profileName: z.string().optional().describe('Match SSH session by profile name (partial, case-insensitive)')
    };

    // ============== BASIC SFTP OPERATIONS ==============

    private createListFilesTool(): McpTool {
        return {
            name: 'sftp_list_files',
            description: `List files in remote directory via SFTP.
Returns: Array of {name, path, isDirectory, size, modifiedTime}`,
            schema: z.object({
                ...this.sessionSchema,
                path: z.string().optional().describe('Remote directory path (default: "/")')
            }),
            handler: async (params: { sessionId?: string; tabIndex?: number; title?: string; path?: string }) => {
                this.logger.info(`[sftp_list_files] Called with params: ${JSON.stringify(params)}`);
                const session = this.findSSHSession(params);
                if (!session) {
                    this.logger.warn('[sftp_list_files] No SSH session found');
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No SSH session found' }) }] };
                }
                this.logger.debug(`[sftp_list_files] Using session: ${session.sessionId}`);

                if (!await this.confirmSftpOperation('sftp_list_files', session.tab.title || 'SSH', params.path || '/')) {
                    return this.rejectedResponse('sftp_list_files');
                }

                try {
                    const sftp = await this.getSFTPSession(session.tab);
                    checkRequest();
                    if (!sftp) {
                        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open SFTP session' }) }] };
                    }

                    const remotePath = params.path || '/';
                    const files = await sftp.readdir(remotePath);
                    const fileList: SFTPFileInfo[] = files.map((f: any) => ({
                        name: f.name,
                        path: f.fullPath,
                        isDirectory: f.isDirectory,
                        isSymlink: f.isSymlink,
                        size: f.size,
                        mode: f.mode,
                        modifiedTime: f.modified?.toISOString() || 'unknown'
                    }));

                    this.logger.info(`[sftp_list_files] Success: ${fileList.length} files in ${remotePath}`);

                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true,
                                sessionId: session.sessionId,
                                path: remotePath,
                                files: fileList,
                                count: fileList.length
                            }, null, 2)
                        }]
                    };
                } catch (error: any) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || String(error) }) }] };
                }
            }
        };
    }

    private createReadFileTool(): McpTool {
        return {
            name: 'sftp_read_file',
            description: `Read remote file content via SFTP. For text files only.
Max size: Configurable in Settings (default: 1MB)`,
            schema: z.object({
                ...this.sessionSchema,
                path: z.string().describe('Remote file path to read'),
                maxSize: z.number().optional().describe('Max bytes (default: 1MB)')
            }),
            handler: async (params: { sessionId?: string; tabIndex?: number; title?: string; path: string; maxSize?: number }) => {
                this.logger.info(`[sftp_read_file] Called: path=${params.path}`);
                const session = this.findSSHSession(params);
                if (!session) {
                    this.logger.warn('[sftp_read_file] No SSH session found');
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No SSH session found' }) }] };
                }

                if (!await this.confirmSftpOperation('sftp_read_file', session.tab.title || 'SSH', params.path)) {
                    return this.rejectedResponse('sftp_read_file');
                }

                try {
                    const sftp = await this.getSFTPSession(session.tab);
                    checkRequest();
                    if (!sftp) {
                        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open SFTP session' }) }] };
                    }

                    const stats = await sftp.stat(params.path);
                    const configuredMax = this.config.store.mcp?.sftp?.maxFileSize ?? 1024 * 1024;
                    const maxSize = Math.min(params.maxSize ?? configuredMax, configuredMax);

                    if (stats.size > maxSize) {
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: false,
                                    error: `File too large: ${stats.size} bytes (max: ${maxSize})`,
                                    hint: 'Use sftp_download to download the file locally'
                                })
                            }]
                        };
                    }

                    const handle = await sftp.open(params.path, 1); // OPEN_READ
                    const chunks: Uint8Array[] = [];
                    let received = 0;
                    try {
                        while (true) {
                            checkRequest();
                            const chunk = await handle.read();
                            if (!chunk || chunk.length === 0) break;
                            received += chunk.length;
                            if (received > maxSize) throw new Error('File grew beyond the configured read limit.');
                            chunks.push(chunk);
                        }
                    } finally { await handle.close(); }

                    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                    const combined = new Uint8Array(totalLength);
                    let offset = 0;
                    for (const chunk of chunks) {
                        combined.set(chunk, offset);
                        offset += chunk.length;
                    }
                    const content = new TextDecoder('utf-8').decode(combined);

                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true, sessionId: session.sessionId, path: params.path, size: stats.size, content
                            })
                        }]
                    };
                } catch (error: any) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || String(error) }) }] };
                }
            }
        };
    }

    private createWriteFileTool(): McpTool {
        return {
            name: 'sftp_write_file',
            description: `Write string content to remote file via SFTP.
For text content only. Use sftp_upload for binary files.`,
            schema: z.object({
                ...this.sessionSchema,
                path: z.string().describe('Remote file path'),
                content: z.string().describe('Text content to write'),
                append: z.boolean().optional().describe('Append instead of overwrite')
            }),
            handler: async (params: { sessionId?: string; tabIndex?: number; title?: string; path: string; content: string; append?: boolean }) => {
                this.logger.info(`[sftp_write_file] Called: path=${params.path}, contentLen=${params.content?.length}, append=${params.append}`);
                const session = this.findSSHSession(params);
                if (!session) {
                    this.logger.warn('[sftp_write_file] No SSH session found');
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No SSH session found' }) }] };
                }

                const writeDetail = `${params.append ? 'APPEND' : 'WRITE'} ${params.path} (${params.content?.length ?? 0} chars)\nContent: ${JSON.stringify(params.content)}`;
                if (!await this.confirmSftpOperation('sftp_write_file', session.tab.title || 'SSH', writeDetail)) {
                    return this.rejectedResponse('sftp_write_file');
                }

                try {
                    const sftp = await this.getSFTPSession(session.tab);
                    checkRequest();
                    if (!sftp) {
                        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open SFTP session' }) }] };
                    }

                    const flags = params.append ? (2 | 8 | 4) : (2 | 8 | 16);
                    const handle = await sftp.open(params.path, flags);
                    const data = new TextEncoder().encode(params.content);
                    await handle.write(data);
                    await handle.close();

                    this.logger.info(`[sftp_write_file] Success: ${data.length} bytes written to ${params.path}`);

                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true, sessionId: session.sessionId, path: params.path, bytesWritten: data.length
                            })
                        }]
                    };
                } catch (error: any) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || String(error) }) }] };
                }
            }
        };
    }

    private createMkdirTool(): McpTool {
        return {
            name: 'sftp_mkdir',
            description: 'Create directory on remote server via SFTP.',
            schema: z.object({
                ...this.sessionSchema,
                path: z.string().describe('Directory path to create')
            }),
            handler: async (params: { sessionId?: string; tabIndex?: number; title?: string; path: string }) => {
                const session = this.findSSHSession(params);
                if (!session) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No SSH session found' }) }] };
                }

                if (!await this.confirmSftpOperation('sftp_mkdir', session.tab.title || 'SSH', params.path)) {
                    return this.rejectedResponse('sftp_mkdir');
                }

                try {
                    const sftp = await this.getSFTPSession(session.tab);
                    checkRequest();
                    if (!sftp) {
                        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open SFTP session' }) }] };
                    }

                    await sftp.mkdir(params.path);
                    return { content: [{ type: 'text', text: JSON.stringify({ success: true, sessionId: session.sessionId, path: params.path }) }] };
                } catch (error: any) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || String(error) }) }] };
                }
            }
        };
    }

    private createDeleteTool(): McpTool {
        return {
            name: 'sftp_delete',
            description: 'Delete file or empty directory via SFTP.',
            schema: z.object({
                ...this.sessionSchema,
                path: z.string().describe('Path to delete'),
                isDirectory: z.boolean().optional().describe('Force treat as directory')
            }),
            handler: async (params: { sessionId?: string; tabIndex?: number; title?: string; path: string; isDirectory?: boolean }) => {
                this.logger.info(`[sftp_delete] Called: path=${params.path}, isDirectory=${params.isDirectory}`);
                const session = this.findSSHSession(params);
                if (!session) {
                    this.logger.warn('[sftp_delete] No SSH session found');
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No SSH session found' }) }] };
                }

                if (!await this.confirmSftpOperation('sftp_delete', session.tab.title || 'SSH', `DELETE ${params.path}`)) {
                    return this.rejectedResponse('sftp_delete');
                }

                try {
                    const sftp = await this.getSFTPSession(session.tab);
                    checkRequest();
                    if (!sftp) {
                        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open SFTP session' }) }] };
                    }

                    let isDir = params.isDirectory;
                    if (isDir === undefined) {
                        try {
                            const stats = await sftp.stat(params.path);
                            isDir = stats.isDirectory;
                        } catch { isDir = false; }
                    }

                    if (isDir) {
                        await sftp.rmdir(params.path);
                    } else {
                        await sftp.unlink(params.path);
                    }

                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true, sessionId: session.sessionId, path: params.path, type: isDir ? 'directory' : 'file'
                            })
                        }]
                    };
                } catch (error: any) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || String(error) }) }] };
                }
            }
        };
    }

    private createRenameTool(): McpTool {
        return {
            name: 'sftp_rename',
            description: 'Rename or move file/directory via SFTP.',
            schema: z.object({
                ...this.sessionSchema,
                sourcePath: z.string().describe('Current path'),
                destPath: z.string().describe('New path')
            }),
            handler: async (params: { sessionId?: string; tabIndex?: number; title?: string; sourcePath: string; destPath: string }) => {
                const session = this.findSSHSession(params);
                if (!session) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No SSH session found' }) }] };
                }

                if (!await this.confirmSftpOperation('sftp_rename', session.tab.title || 'SSH', `${params.sourcePath} → ${params.destPath}`)) {
                    return this.rejectedResponse('sftp_rename');
                }

                try {
                    const sftp = await this.getSFTPSession(session.tab);
                    checkRequest();
                    if (!sftp) {
                        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open SFTP session' }) }] };
                    }

                    await sftp.rename(params.sourcePath, params.destPath);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true, sessionId: session.sessionId, sourcePath: params.sourcePath, destPath: params.destPath
                            })
                        }]
                    };
                } catch (error: any) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || String(error) }) }] };
                }
            }
        };
    }

    private createStatTool(): McpTool {
        return {
            name: 'sftp_stat',
            description: 'Get file/directory info (exists, size, permissions, etc).',
            schema: z.object({
                ...this.sessionSchema,
                path: z.string().describe('Path to stat')
            }),
            handler: async (params: { sessionId?: string; tabIndex?: number; title?: string; path: string }) => {
                const session = this.findSSHSession(params);
                if (!session) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No SSH session found' }) }] };
                }

                if (!await this.confirmSftpOperation('sftp_stat', session.tab.title || 'SSH', params.path)) {
                    return this.rejectedResponse('sftp_stat');
                }

                try {
                    const sftp = await this.getSFTPSession(session.tab);
                    checkRequest();
                    if (!sftp) {
                        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open SFTP session' }) }] };
                    }

                    const stats = await sftp.stat(params.path);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true, sessionId: session.sessionId, path: params.path, exists: true,
                                isDirectory: stats.isDirectory, isSymlink: stats.isSymlink, size: stats.size, mode: stats.mode,
                                modifiedTime: stats.modified?.toISOString() || 'unknown'
                            })
                        }]
                    };
                } catch (error: any) {
                    const errorStr = error.message || String(error);
                    if (errorStr.includes('No such file') || errorStr.includes('not found')) {
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: true, sessionId: session.sessionId, path: params.path, exists: false
                                })
                            }]
                        };
                    }
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: errorStr }) }] };
                }
            }
        };
    }

    // ============== FILE TRANSFER OPERATIONS ==============

    private createUploadTool(): McpTool {
        return {
            name: 'sftp_upload',
            description: `Upload a local file to a remote server via SFTP.

⚠️ IMPORTANT: Use these exact parameter names:
  • localPath (required): Absolute path to the local file to upload
  • remotePath (required): Destination path on the remote server
  • sync (optional): Wait for completion (default: true)

Example: { "localPath": "/home/user/file.txt", "remotePath": "/tmp/uploaded.txt" }

Max upload size is configurable in Tabby Settings → MCP → SFTP.
An interrupted upload can report OUTCOME_UNKNOWN: the remote backend may still commit. Inspect the remote file before retrying.`,
            schema: z.object({
                ...this.sessionSchema,
                localPath: z.string().describe('REQUIRED: Absolute path to local file (e.g., /home/user/file.txt)'),
                remotePath: z.string().describe('REQUIRED: Remote destination path (e.g., /tmp/uploaded.txt)'),
                sync: z.boolean().optional().describe('Wait for completion, default true. Set false to get transferId for async tracking')
            }),
            handler: async (params: {
                sessionId?: string; tabIndex?: number; title?: string;
                localPath: string; remotePath: string; sync?: boolean
            }) => {
                this.logger.info(`[sftp_upload] Called: localPath=${params.localPath}, remotePath=${params.remotePath}, sync=${params.sync !== false}`);
                const session = this.findSSHSession(params);
                if (!session) {
                    this.logger.warn('[sftp_upload] No SSH session found');
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No SSH session found' }) }] };
                }
                this.logger.debug(`[sftp_upload] Using session: ${session.sessionId}`);

                if (!await this.confirmSftpOperation('sftp_upload', session.tab.title || 'SSH', `${params.localPath} → ${params.remotePath}`)) {
                    return this.rejectedResponse('sftp_upload');
                }

                // Check local file exists
                if (!fs.existsSync(params.localPath)) {
                    this.logger.warn(`[sftp_upload] Local file not found: ${params.localPath}`);
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false, error: `Local file not found: ${params.localPath}`
                            })
                        }]
                    };
                }

                const stats = fs.statSync(params.localPath);
                const maxSize = this.config.store.mcp?.sftp?.maxUploadSize || 10 * 1024 * 1024;

                if (stats.size > maxSize) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false,
                                error: `File too large: ${stats.size} bytes (max: ${maxSize})`,
                                hint: 'Increase max upload size in Settings → MCP → SFTP'
                            })
                        }]
                    };
                }

                const transferId = this.generateTransferId();
                const task: TransferTask = {
                    id: transferId,
                    type: 'upload',
                    localPath: params.localPath,
                    remotePath: params.remotePath,
                    sessionId: session.sessionId,
                    connectionName: session.tab.title || 'SSH Connection',
                    status: 'pending',
                    progress: 0,
                    bytesTransferred: 0,
                    totalBytes: stats.size,
                    startTime: Date.now(),
                    cancelRequested: false
                };
                this.transferTasks.set(transferId, task);
                this._transferTasksSubject.next(Array.from(this.transferTasks.values()));
                this.cleanupOldTransfers();

                const sync = params.sync !== false;

                const doUpload = async () => {
                    if (this.isTransferCancelled(task)) {
                        throw new Error('Transfer cancelled');
                    }
                    task.status = 'running';
                    this.emitTransferUpdate();
                    let fileUpload: StreamFileUpload | undefined;
                    let uploadStarted = false;
                    try {
                        const sftpSession = await this.getSFTPSession(session.tab);
                        if (!sftpSession) {
                            throw new Error('Could not open SFTP session');
                        }

                        fileUpload = new StreamFileUpload(
                            params.localPath,
                            stats.size,
                            (bytes: number) => {
                                if (!this.isTransferCancelled(task)) {
                                    task.bytesTransferred = bytes;
                                    task.progress = Math.round((bytes / task.totalBytes) * 100);
                                    task.speed = bytes / ((Date.now() - task.startTime) / 1000);
                                }
                            }
                        );
                        task.cancelCallback = () => {
                            this.logger.warn(`[SFTP] Cancelling upload: ${transferId}`);
                            if (uploadStarted) {
                                task.status = 'unknown';
                                task.error = 'Cancellation requested; remote upload outcome is unknown. Inspect the remote file before retrying.';
                            }
                            fileUpload?.cancel();
                        };

                        if (this.isTransferCancelled(task)) {
                            fileUpload.cancel();
                            throw new Error('Transfer cancelled');
                        }

                        const sshSession = (session.tab as any).sshSession;
                        uploadStarted = true;
                        const uploadPromise = sftpSession.upload(params.remotePath, fileUpload);
                        const result = await this.waitForTransferComplete(uploadPromise, fileUpload, sshSession);

                        if (this.isTransferCancelled(task)) {
                            throw new Error('Transfer cancelled');
                        }
                        if (result === 'completed_via_polling') {
                            this.logger.info('[sftp_upload] Transfer completed via polling fallback');
                        }

                        task.status = 'completed';
                        task.progress = 100;
                        task.bytesTransferred = task.totalBytes;
                        task.endTime = Date.now();
                        this.emitTransferUpdate();
                    } catch (error: any) {
                        if (uploadStarted) {
                            // Tabby's opaque upload can still unlink/rename after its last read.
                            task.status = 'unknown';
                            task.error = `${error.message || String(error)}. Remote upload outcome is unknown; inspect the remote file before retrying.`;
                        } else if (!this.isTransferCancelled(task)) {
                            task.status = 'failed';
                            task.error = error.message || String(error);
                        }
                        task.endTime = Date.now();
                        this.emitTransferUpdate();
                        fileUpload?.cancel();
                        throw error;
                    } finally {
                        task.cancelCallback = undefined;
                        fileUpload?.close();
                    }
                };

                if (sync) {
                    try {
                        await doUpload();
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: true,
                                    transferId,
                                    localPath: params.localPath,
                                    remotePath: params.remotePath,
                                    bytesTransferred: task.bytesTransferred,
                                    duration: task.endTime! - task.startTime
                                })
                            }]
                        };
                    } catch (error: any) {
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: false, transferId,
                                    code: task.status === 'unknown' ? 'OUTCOME_UNKNOWN' : undefined,
                                    error: task.error || error.message || String(error)
                                })
                            }]
                        };
                    }
                } else {
                    // Async mode - start upload in background
                    doUpload().catch(e => {
                        if (!this.isTransferCancelled(task)) {
                            this.logger.error('Async upload failed:', e);
                        }
                    });
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: true,
                                async: true,
                                transferId,
                                message: 'Upload started. Use sftp_get_transfer_status to check progress.'
                            })
                        }]
                    };
                }
            }
        };
    }

    private createDownloadTool(): McpTool {
        return {
            name: 'sftp_download',
            description: `Download a remote file to local path via SFTP.

⚠️ IMPORTANT: Use these exact parameter names:
  • remotePath (required): Path to the file on the remote server
  • localPath (required): Absolute path for local destination
  • sync (optional): Wait for completion (default: true)

Example: { "remotePath": "/tmp/remote.txt", "localPath": "/home/user/downloaded.txt" }

Max download size is configurable in Tabby Settings → MCP → SFTP.`,
            schema: z.object({
                ...this.sessionSchema,
                remotePath: z.string().describe('REQUIRED: Remote file path to download (e.g., /tmp/remote.txt)'),
                localPath: z.string().describe('REQUIRED: Local destination path, must be absolute (e.g., /home/user/file.txt)'),
                sync: z.boolean().optional().describe('Wait for completion, default true. Set false to get transferId for async tracking')
            }),
            handler: async (params: {
                sessionId?: string; tabIndex?: number; title?: string;
                remotePath: string; localPath: string; sync?: boolean
            }) => {
                this.logger.info(`[sftp_download] Called: remotePath=${params.remotePath}, localPath=${params.localPath}, sync=${params.sync !== false}`);
                const session = this.findSSHSession(params);
                if (!session) {
                    this.logger.warn('[sftp_download] No SSH session found');
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No SSH session found' }) }] };
                }
                this.logger.debug(`[sftp_download] Using session: ${session.sessionId}`);

                if (!await this.confirmSftpOperation('sftp_download', session.tab.title || 'SSH', `${params.remotePath} → ${params.localPath}`)) {
                    return this.rejectedResponse('sftp_download');
                }

                try {
                    const sftp = await this.getSFTPSession(session.tab);
                    checkRequest();
                    if (!sftp) {
                        return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Could not open SFTP session' }) }] };
                    }

                    // Check remote file size
                    let remoteStats;
                    try {
                        remoteStats = await sftp.stat(params.remotePath);
                    } catch (error: any) {
                        if (error.code === 'ENOENT' || error.message?.includes('No such file')) {
                            return {
                                content: [{
                                    type: 'text', text: JSON.stringify({
                                        success: false,
                                        error: `Remote file not found: ${params.remotePath}`
                                    })
                                }]
                            };
                        }
                        throw error;
                    }

                    const maxSize = this.config.store.mcp?.sftp?.maxDownloadSize || 10 * 1024 * 1024;

                    if (remoteStats.size > maxSize) {
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: false,
                                    error: `File too large: ${remoteStats.size} bytes (max: ${maxSize})`,
                                    hint: 'Increase max download size in Settings → MCP → SFTP'
                                })
                            }]
                        };
                    }

                    // Ensure local directory exists
                    const localDir = path.dirname(params.localPath);
                    if (!fs.existsSync(localDir)) {
                        fs.mkdirSync(localDir, { recursive: true });
                    }

                    const transferId = this.generateTransferId();
                    const task: TransferTask = {
                        id: transferId,
                        type: 'download',
                        localPath: params.localPath,
                        remotePath: params.remotePath,
                        sessionId: session.sessionId,
                        connectionName: session.tab.title || 'SSH Connection',
                        status: 'pending',
                        progress: 0,
                        bytesTransferred: 0,
                        totalBytes: remoteStats.size,
                        startTime: Date.now(),
                        cancelRequested: false
                    };
                    this.transferTasks.set(transferId, task);
                    this._transferTasksSubject.next(Array.from(this.transferTasks.values()));
                    this.cleanupOldTransfers();

                    const sync = params.sync !== false;

                    const doDownload = async () => {
                        if (this.isTransferCancelled(task)) {
                            throw new Error('Transfer cancelled');
                        }
                        task.status = 'running';
                        this.emitTransferUpdate();
                        let fileDownload: StreamFileDownload | undefined;
                        try {
                            const sftpSession = await this.getSFTPSession(session.tab);
                            if (!sftpSession) {
                                throw new Error('Could not open SFTP session');
                            }

                            fileDownload = new StreamFileDownload(
                                params.localPath,
                                remoteStats.size,
                                (bytes: number) => {
                                    if (!this.isTransferCancelled(task)) {
                                        task.bytesTransferred = bytes;
                                        task.progress = Math.round((bytes / task.totalBytes) * 100);
                                        task.speed = bytes / ((Date.now() - task.startTime) / 1000);
                                    }
                                }
                            );
                            task.cancelCallback = () => {
                                this.logger.warn(`[SFTP] Cancelling download: ${transferId}`);
                                fileDownload?.cancel();
                            };

                            if (this.isTransferCancelled(task)) {
                                fileDownload.cancel();
                                throw new Error('Transfer cancelled');
                            }

                            const sshSession = (session.tab as any).sshSession;
                            const downloadPromise = sftpSession.download(params.remotePath, fileDownload);
                            const result = await this.waitForTransferComplete(downloadPromise, fileDownload, sshSession);

                            if (this.isTransferCancelled(task)) {
                                throw new Error('Transfer cancelled');
                            }
                            if (result === 'completed_via_polling') {
                                this.logger.info('[sftp_download] Transfer completed via polling fallback');
                            }

                            fileDownload.commit();
                            task.status = 'completed';
                            task.progress = 100;
                            task.bytesTransferred = task.totalBytes;
                            task.endTime = Date.now();
                            this.emitTransferUpdate();
                        } catch (error: any) {
                            if (!this.isTransferCancelled(task)) {
                                task.status = 'failed';
                                task.error = error.message || String(error);
                            }
                            task.endTime = Date.now();
                            this.emitTransferUpdate();
                            fileDownload?.cancel();
                            throw error;
                        } finally {
                            task.cancelCallback = undefined;
                            fileDownload?.close();
                        }
                    };

                    if (sync) {
                        await doDownload();
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: true,
                                    transferId,
                                    remotePath: params.remotePath,
                                    localPath: params.localPath,
                                    bytesTransferred: task.bytesTransferred,
                                    duration: task.endTime! - task.startTime
                                })
                            }]
                        };
                    } else {
                        doDownload().catch(e => {
                            if (!this.isTransferCancelled(task)) {
                                this.logger.error('Async download failed:', e);
                            }
                        });
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    success: true,
                                    async: true,
                                    transferId,
                                    message: 'Download started. Use sftp_get_transfer_status to check progress.'
                                })
                            }]
                        };
                    }
                } catch (error: any) {
                    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message || String(error) }) }] };
                }
            }
        };
    }

    private createGetTransferStatusTool(): McpTool {
        return {
            name: 'sftp_get_transfer_status',
            description: 'Get status and progress of a file transfer task.',
            schema: z.object({
                transferId: z.string().describe('Transfer task ID from sftp_upload/sftp_download')
            }),
            handler: async (params: { transferId: string }) => {
                const task = this.transferTasks.get(params.transferId);
                if (!task) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false, error: 'Transfer not found', transferId: params.transferId
                            })
                        }]
                    };
                }

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            transferId: task.id,
                            type: task.type,
                            status: task.status,
                            code: task.status === 'unknown' ? 'OUTCOME_UNKNOWN' : undefined,
                            progress: task.progress,
                            bytesTransferred: task.bytesTransferred,
                            totalBytes: task.totalBytes,
                            speed: task.speed,
                            localPath: task.localPath,
                            remotePath: task.remotePath,
                            startTime: new Date(task.startTime).toISOString(),
                            endTime: task.endTime ? new Date(task.endTime).toISOString() : undefined,
                            duration: task.endTime ? task.endTime - task.startTime : Date.now() - task.startTime,
                            error: task.error
                        })
                    }]
                };
            }
        };
    }

    private createListTransfersTool(): McpTool {
        return {
            name: 'sftp_list_transfers',
            description: 'List all active and recent file transfers.',
            schema: z.object({
                status: z.enum(['all', 'active', 'completed', 'failed', 'unknown']).optional().describe('Filter by status')
            }),
            handler: async (params: { status?: string }) => {
                let tasks = Array.from(this.transferTasks.values());

                if (params.status && params.status !== 'all') {
                    if (params.status === 'active') {
                        tasks = tasks.filter(t => t.status === 'pending' || t.status === 'running');
                    } else {
                        tasks = tasks.filter(t => t.status === params.status);
                    }
                }

                // Sort by start time descending
                tasks.sort((a, b) => b.startTime - a.startTime);

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: true,
                            count: tasks.length,
                            transfers: tasks.map(t => ({
                                id: t.id,
                                type: t.type,
                                status: t.status,
                                code: t.status === 'unknown' ? 'OUTCOME_UNKNOWN' : undefined,
                                progress: t.progress,
                                localPath: t.localPath,
                                remotePath: t.remotePath,
                                bytesTransferred: t.bytesTransferred,
                                totalBytes: t.totalBytes
                            }))
                        }, null, 2)
                    }]
                };
            }
        };
    }

    private createCancelTransferTool(): McpTool {
        return {
            name: 'sftp_cancel_transfer',
            description: 'Request cancellation of an active file transfer. Started uploads may report an unknown remote outcome.',
            schema: z.object({
                transferId: z.string().describe('Transfer task ID to cancel')
            }),
            handler: async (params: { transferId: string }) => {
                const task = this.transferTasks.get(params.transferId);
                if (!task) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false, error: 'Transfer not found'
                            })
                        }]
                    };
                }

                if (!['pending', 'running'].includes(task.status)) {
                    return {
                        content: [{
                            type: 'text', text: JSON.stringify({
                                success: false, error: `Cannot cancel transfer in status: ${task.status}`
                            })
                        }]
                    };
                }

                if (!await this.confirmSftpOperation(
                    'sftp_cancel_transfer',
                    task.connectionName,
                    `${task.type}: ${task.localPath} ↔ ${task.remotePath}`
                )) {
                    return this.rejectedResponse('sftp_cancel_transfer');
                }

                // Use the UI cancellation path; the opaque remote upload may still commit.
                const cancelled = this.cancelTransferById(params.transferId);

                return {
                    content: [{
                        type: 'text', text: JSON.stringify({
                            success: cancelled,
                            transferId: params.transferId,
                            status: task.status,
                            code: task.status === 'unknown' ? 'OUTCOME_UNKNOWN' : undefined,
                            message: task.status === 'unknown' ? task.error : cancelled ? 'Transfer cancelled' : 'Transfer could not be cancelled'
                        })
                    }]
                };
            }
        };
    }
}

/**
 * Stream-based FileUpload adapter for SFTP upload
 * Reads file in chunks to prevent OOM on large files
 */
class StreamFileUpload {
    private fd: number | null = null;
    private name: string;
    private filePath: string;
    private size: number;
    private position = 0;
    private readonly chunkSize = 64 * 1024; // 64KB chunks
    private onProgress: (bytes: number) => void;
    private cancelled = false;
    private closed = false;
    private signal = requestContext.getStore();

    constructor(filePath: string, size: number, onProgress?: (bytes: number) => void) {
        this.name = path.basename(filePath);
        this.filePath = filePath;
        this.size = size;
        this.onProgress = onProgress || (() => { });
    }

    open(): void {
        if (this.fd === null) {
            this.fd = fs.openSync(this.filePath, 'r');
        }
    }

    getName(): string { return this.name; }
    getSize(): number { return this.size; }
    getMode(): number { return 0o644; }
    getCompletedBytes(): number { return this.position; }
    isComplete(): boolean { return this.closed && !this.isCancelled() && this.position === this.size; }
    isCancelled(): boolean { return this.cancelled || !!this.signal?.aborted; }

    cancel(): void {
        this.cancelled = true;
        this.close();
    }

    async read(): Promise<Uint8Array> {
        if (this.cancelled || this.signal?.aborted) throw new Error('Transfer cancelled');
        if (this.fd === null) this.open();

        if (this.position >= this.size) {
            return new Uint8Array(0);
        }

        const buffer = Buffer.alloc(this.chunkSize);
        const bytesRead = fs.readSync(this.fd!, buffer, 0, Math.min(this.chunkSize, this.size - this.position), this.position);

        if (bytesRead === 0) return new Uint8Array(0);

        this.position += bytesRead;
        this.onProgress(this.position);

        return new Uint8Array(buffer.subarray(0, bytesRead));
    }

    // Required by some SFTP implementations
    async readAll(): Promise<Uint8Array> {
        throw new Error('readAll not supported for stream upload (file too large)');
    }

    close(): void {
        this.closed = true;
        if (this.fd !== null) {
            try {
                fs.closeSync(this.fd);
            } catch (e) {
                // Ignore close errors
            }
            this.fd = null;
        }
    }
}

/**
 * Stream-based FileDownload adapter for SFTP download
 * Writes file in chunks to prevent OOM and enable immediate disk persistence
 */
class StreamFileDownload {
    private fd: number | null = null;
    private stagedPath: string | null = null;
    private bytesReceived = 0;
    private cancelled = false;
    private closed = false;
    private signal = requestContext.getStore();

    constructor(private filePath: string, private expectedSize: number, private onProgress: (bytes: number) => void = () => {}) {}

    open(): void {
        if (this.isCancelled() || this.closed) throw new Error('Transfer cancelled or closed');
        if (this.fd !== null) return;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const stagedPath = path.join(path.dirname(this.filePath), `.tabby-download-${randomUUID()}.tmp`);
        this.fd = fs.openSync(stagedPath, 'wx', 0o600);
        this.stagedPath = stagedPath;
    }

    getName(): string { return path.basename(this.filePath); }
    getSize(): number { return this.expectedSize; }
    getMode(): number { return 0o644; }
    getCompletedBytes(): number { return this.bytesReceived; }
    isComplete(): boolean { return this.closed && !this.isCancelled() && this.bytesReceived === this.expectedSize; }
    isCancelled(): boolean { return this.cancelled || !!this.signal?.aborted; }

    cancel(): void {
        this.cancelled = true;
        try { this.close(); } finally {
            if (this.stagedPath) {
                fs.unlinkSync(this.stagedPath);
                this.stagedPath = null;
            }
        }
    }

    async write(buffer: Uint8Array): Promise<void> {
        if (this.isCancelled() || this.closed) throw new Error('Transfer cancelled or closed');
        if (this.fd === null) this.open();
        if (this.bytesReceived + buffer.length > this.expectedSize) throw new Error('Remote file grew beyond the approved download size.');
        let written = 0;
        while (written < buffer.length) {
            const bytes = fs.writeSync(this.fd!, buffer, written, buffer.length - written);
            if (bytes === 0) throw new Error('Could not write download staging file');
            written += bytes;
            this.bytesReceived += bytes;
        }
        this.onProgress(this.bytesReceived);
    }

    getData(): Uint8Array { return new Uint8Array(0); }

    /** Tabby closes on EOF. Seal staging here; only the successful tool commits it. */
    close(): void {
        if (this.closed) return;
        // Empty downloads still need a staging file, after the backend reaches EOF.
        if (!this.isCancelled() && this.fd === null) this.open();
        this.closed = true;
        if (this.fd !== null) {
            const fd = this.fd;
            this.fd = null;
            try { if (!this.isCancelled()) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
    }

    commit(): void {
        if (!this.isComplete() || !this.stagedPath) throw new Error('Download is incomplete');
        fs.renameSync(this.stagedPath, this.filePath);
        this.stagedPath = null;
    }
}
