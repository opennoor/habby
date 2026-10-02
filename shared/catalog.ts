// Adapted from GentlemanHu/Tabby-MCP (MIT, copyright 2026 GentlemanHu).
// Source revision 86a52fdfadb724959929f052c1fc89a45c9f1b0f. See THIRD_PARTY_NOTICES.md.
import { z } from 'zod4';
import path from 'node:path';
import { HubError, type Scope, type Principal } from './protocol.js';

const sessionSchema = { sessionId: z.string().optional(), tabIndex: z.number().optional(), title: z.string().optional(), profileName: z.string().optional() };
const targetShape = { windowId: z.string().uuid().optional(), tabId: z.string().max(512).optional(),
  sessionId: z.string().max(512).optional(), profileId: z.string().max(512).optional(),
  transferId: z.string().max(512).optional() };
function targets(schema: z.ZodObject<any>): z.ZodObject<any> {
  const shape = { ...targetShape, ...schema.shape };
  if (shape.tabIndex) shape.tabIndex = shape.tabIndex.optional();
  return z.object(shape).strict();
}
export interface ToolDefinition {
  name: string; description: string; schema: z.ZodObject<any>; scopes: readonly Scope[]; aggregate: boolean;
}
export const TOOLS: readonly ToolDefinition[] = [
  { name: 'list_tabs', description: `List all open tabs in Tabby with stable IDs and metadata.
Use tabId (stable) for reliable tab targeting; tabIndex may change if tabs are reordered.`, schema: targets(z.object({})), scopes: ['terminal:read'], aggregate: true },
  { name: 'select_tab', description: `Select/focus a specific tab.
Tab targeting: tabId (stable, recommended) > tabIndex (legacy) > title (partial match)`, schema: targets(z.object({
                tabId: z.string().optional().describe('Stable tab ID (recommended, from list_tabs)'),
                tabIndex: z.number().optional().describe('Tab index (legacy, may change)'),
                title: z.string().optional().describe('Match by title (partial, case-insensitive)')
            })), scopes: ['terminal:manage'], aggregate: false },
  { name: 'close_tab', description: `Close a specific tab. If no locator provided, closes the active tab.
Tab targeting: tabId (stable, recommended) > tabIndex (legacy) > title (partial match)`, schema: targets(z.object({
                tabId: z.string().optional().describe('Stable tab ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                force: z.boolean().optional().describe('Force close without asking (default: false)')
            })), scopes: ['terminal:manage'], aggregate: false },
  { name: 'close_all_tabs', description: 'Close all open tabs', schema: targets(z.object({})), scopes: ['terminal:manage'], aggregate: false },
  { name: 'duplicate_tab', description: 'Duplicate the active tab or a specific tab', schema: targets(z.object({
                tabIndex: z.number().optional().describe('Index of the tab to duplicate (default: active tab)')
            })), scopes: ['terminal:manage'], aggregate: false },
  { name: 'next_tab', description: 'Switch to the next tab', schema: targets(z.object({})), scopes: ['terminal:manage'], aggregate: false },
  { name: 'previous_tab', description: 'Switch to the previous tab', schema: targets(z.object({})), scopes: ['terminal:manage'], aggregate: false },
  { name: 'move_tab_left', description: 'Move the active tab to the left', schema: targets(z.object({})), scopes: ['terminal:manage'], aggregate: false },
  { name: 'move_tab_right', description: 'Move the active tab to the right', schema: targets(z.object({})), scopes: ['terminal:manage'], aggregate: false },
  { name: 'reopen_last_tab', description: 'Reopen the last closed tab', schema: targets(z.object({})), scopes: ['terminal:manage'], aggregate: false },
  { name: 'list_profiles', description: `List all available terminal profiles (local shell, SSH connections, etc.).
Returns profileId which can be used directly with open_profile().

Workflow: list_profiles() -> find desired profile -> open_profile(profileId="...")`, schema: targets(z.object({})), scopes: ['terminal:read'], aggregate: true },
  { name: 'open_profile', description: `Open a NEW terminal tab using a profile. Creates new connection.

Usage: list_profiles() -> open_profile(profileId="...from list_profiles result")

Parameters:
- profileId: Use 'profileId' field from list_profiles (recommended)
- profileName: Or match by name (partial, case-insensitive)
- waitForReady: Wait for terminal/SSH to fully connect (default: true)
- timeout: Timeout in ms when waiting (default: 30000)

Returns sessionId for immediate use with exec_command, SFTP tools, etc.

Response state fields:
- tabReady: Tab/frontend initialized
- sshConnected: SSH connection established (SSH profiles only)
- ready: OVERALL ready state (for SSH: tabReady AND sshConnected)

For SSH profiles, waits until sshSession.open=true (real connection established).

NOTE: This opens a NEW tab. For existing connections, use get_session_list + exec_command.`, schema: targets(z.object({
                profileId: z.string().optional().describe('profileId from list_profiles result'),
                profileName: z.string().optional().describe('Profile name (partial match, case-insensitive)'),
                waitForReady: z.boolean().optional().describe('Wait for connection (default: true for SSH, false for local)'),
                timeout: z.number().optional().describe('Timeout in ms when waiting (default: 30000)')
            })), scopes: ['terminal:manage'], aggregate: false },
  { name: 'show_profile_selector', description: `Show the profile selector dialog for the user to choose a profile.
This is a NON-BLOCKING operation - it immediately returns after opening the dialog.
The dialog will be shown to the user, but this tool does not wait for user selection.
Use list_profiles + open_profile for programmatic profile opening instead.`, schema: targets(z.object({})), scopes: ['terminal:manage'], aggregate: false },
  { name: 'quick_connect', description: `Quick connection - creates a NEW tab using the best matching provider.

IMPORTANT: This creates a NEW connection and tab, does NOT reuse existing sessions.
- For new connections: Use this or open_profile
- For existing sessions: Use get_session_list to find sessions, then exec_command
- Uses the same tab/session/ready return chain as open_profile
- protocol='auto' prefers SSH for user@host style input instead of relying on provider order

Examples:
- quick_connect(query="root@192.168.1.1")
- quick_connect(query="user@host:2222")
- quick_connect(query="telnet://host:23", protocol="auto")
- quick_connect(query="host:9000", protocol="socket")`, schema: targets(z.object({
                query: z.string().describe('Connection target, e.g. user@host, user@host:port, telnet://host:23, socket://host:9000, serial:///dev/ttyUSB0'),
                protocol: z.enum(['auto', 'ssh', 'telnet', 'socket', 'serial']).optional().describe('Protocol selection strategy (default: auto)'),
                waitForReady: z.boolean().optional().describe('Wait for connection readiness (default: true for SSH, false for most others)'),
                timeout: z.number().optional().describe('Timeout in ms when waiting (default: 30000)')
            })), scopes: ['terminal:manage'], aggregate: false },
  { name: 'split_tab', description: `Split the current terminal pane in a direction.
Creates a new pane with a copy of the current terminal.
Direction: 'right'/'left'/'top'/'bottom' (or shorthand 'r'/'l'/'t'/'b')
The active tab must be inside a SplitTabComponent, or be a terminal that can be wrapped.`, schema: targets(z.object({
                direction: z.enum(['horizontal', 'vertical', 'right', 'left', 'top', 'bottom', 'r', 'l', 't', 'b'])
                    .describe('Split direction: right/left/top/bottom (or r/l/t/b), or horizontal/vertical')
            })), scopes: ['terminal:manage'], aggregate: false },
  { name: 'get_session_list', description: `Get list of all terminal sessions with stable IDs and metadata.
Use sessionId (stable UUID) for reliable session targeting.

For split panes:
- isSplit: true if this session is inside a split tab
- splitTabIndex: Index of parent tab (use for grouping panes)
- paneIndex: Position within the split (0, 1, 2, ...)
- totalPanes: Number of panes in the split
- isFocusedPane: Whether this is the currently focused pane`, schema: targets(z.object({})), scopes: ['terminal:read'], aggregate: true },
  { name: 'exec_command', description: `Execute a command in a terminal session.
Session targeting (priority order): sessionId > tabIndex > title > profileName
- sessionId: Stable UUID (recommended, use get_session_list to get IDs)
- tabIndex: Array index (legacy, may change if tabs are reordered)
- title: Match by terminal title (partial, case-insensitive)
- profileName: Match by profile name (partial, case-insensitive)

For interactive/paging commands (less, vim, top), set waitForOutput=false.
For long-running commands, increase timeout or use waitForOutput=false and poll with get_terminal_buffer.`, schema: targets(z.object({
                command: z.string().describe('Command to execute'),
                sessionId: z.string().optional().describe('Stable session ID (recommended, from get_session_list)'),
                tabIndex: z.number().optional().describe('Tab index (legacy, may change if tabs reorder)'),
                title: z.string().optional().describe('Match session by title (partial, case-insensitive)'),
                profileName: z.string().optional().describe('Match session by profile name (partial, case-insensitive)'),
                waitForOutput: z.boolean().optional().describe('Wait for command completion (default: true). Set false for interactive commands.'),
                timeout: z.number().optional().describe('Timeout in ms (default: 30000, max: 300000)')
            })), scopes: ['terminal:write'], aggregate: false },
  { name: 'send_input', description: `Send raw input to a terminal. Use this for interactive commands like vim, less, top, etc.
Session targeting: sessionId (recommended) > tabIndex > title > profileName
Special keys: \\x03 (Ctrl+C), \\x04 (Ctrl+D), \\x1b (Escape), \\r (Enter)`, schema: targets(z.object({
                input: z.string().describe('Input to send (can include special characters like \\n, \\x03 for Ctrl+C)'),
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            })), scopes: ['terminal:write'], aggregate: false },
  { name: 'submit_keyboard_interactive_response', description: `Submit response(s) to an active SSH keyboard-interactive authentication prompt.
Use this for MFA/TOTP prompts shown by Tabby's SSH authentication panel, such as Jumpserver MFA.

This tool targets Tabby's activeKIPrompt object directly; it is different from send_input,
which writes to the terminal pty and cannot answer Tabby's auth form.

Session targeting: sessionId (recommended) > tabIndex > title > profileName`, schema: targets(z.object({
                response: z.string().optional().describe('Single response for prompts with one field, such as a 6-digit TOTP code'),
                responses: z.array(z.string()).optional().describe('Responses for multi-prompt keyboard-interactive auth, in prompt order'),
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            })), scopes: ['terminal:write'], aggregate: false },
  { name: 'get_session_environment', description: `Get the environment context of a terminal session (e.g., bash, python, node, database REPL).
Use this before sending complex commands to ensure the session is in the expected state.
Session targeting: sessionId (recommended) > tabIndex > title > profileName`, schema: targets(z.object({
                activeProbe: z.boolean().optional().describe('Run an explicit active probe; requires terminal:write'),
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            })), scopes: ['terminal:read'], aggregate: false },
  { name: 'get_terminal_buffer', description: `Get the content of a terminal buffer. Use this to check command output after using send_input or async exec_command.
Session targeting: sessionId (recommended) > tabIndex > title > profileName`, schema: targets(z.object({
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name'),
                lastNLines: z.number().optional().describe('Get only the last N lines (default: all)'),
                startLine: z.number().optional().describe('Start line (0-indexed)'),
                endLine: z.number().optional().describe('End line (exclusive)')
            })), scopes: ['terminal:read'], aggregate: false },
  { name: 'abort_command', description: `Abort a running command by sending Ctrl+C.
Session targeting: sessionId (recommended) > tabIndex > title > profileName`, schema: targets(z.object({
                sessionId: z.string().optional().describe('Stable session ID (recommended)'),
                tabIndex: z.number().optional().describe('Tab index (legacy)'),
                title: z.string().optional().describe('Match by title'),
                profileName: z.string().optional().describe('Match by profile name')
            })), scopes: ['terminal:write'], aggregate: false },
  { name: 'get_command_status', description: 'Get the status of active/running commands across all terminals', schema: targets(z.object({})), scopes: ['terminal:read'], aggregate: true },
  { name: 'focus_pane', description: `Focus a specific pane in a split terminal tab.
Use sessionId to identify the exact pane to focus.
After focusing, commands sent to that split tab will go to the focused pane.`, schema: targets(z.object({
                sessionId: z.string().describe('Session ID of the pane to focus (from get_session_list)')
            })), scopes: ['terminal:manage'], aggregate: false },
  { name: 'sftp_list_files', description: `List files in remote directory via SFTP.
Returns: Array of {name, path, isDirectory, size, modifiedTime}`, schema: targets(z.object({
                ...sessionSchema,
                path: z.string().optional().describe('Remote directory path (default: "/")')
            })), scopes: ['files:read'], aggregate: false },
  { name: 'sftp_read_file', description: `Read remote file content via SFTP. For text files only.
Max size: Configurable in Settings (default: 1MB)`, schema: targets(z.object({
                ...sessionSchema,
                path: z.string().describe('Remote file path to read'),
                maxSize: z.number().optional().describe('Max bytes (default: 1MB)')
            })), scopes: ['files:read'], aggregate: false },
  { name: 'sftp_write_file', description: `Write string content to remote file via SFTP.
For text content only. Use sftp_upload for binary files.`, schema: targets(z.object({
                ...sessionSchema,
                path: z.string().describe('Remote file path'),
                content: z.string().describe('Text content to write'),
                append: z.boolean().optional().describe('Append instead of overwrite')
            })), scopes: ['files:write'], aggregate: false },
  { name: 'sftp_mkdir', description: 'Create directory on remote server via SFTP.', schema: targets(z.object({
                ...sessionSchema,
                path: z.string().describe('Directory path to create')
            })), scopes: ['files:write'], aggregate: false },
  { name: 'sftp_delete', description: 'Delete file or empty directory via SFTP.', schema: targets(z.object({
                ...sessionSchema,
                path: z.string().describe('Path to delete'),
                isDirectory: z.boolean().optional().describe('Force treat as directory')
            })), scopes: ['files:write'], aggregate: false },
  { name: 'sftp_rename', description: 'Rename or move file/directory via SFTP.', schema: targets(z.object({
                ...sessionSchema,
                sourcePath: z.string().describe('Current path'),
                destPath: z.string().describe('New path')
            })), scopes: ['files:write'], aggregate: false },
  { name: 'sftp_stat', description: 'Get file/directory info (exists, size, permissions, etc).', schema: targets(z.object({
                ...sessionSchema,
                path: z.string().describe('Path to stat')
            })), scopes: ['files:read'], aggregate: false },
  { name: 'sftp_upload', description: `Upload a local file to a remote server via SFTP.

⚠️ IMPORTANT: Use these exact parameter names:
  • localPath (required): Absolute path to the local file to upload
  • remotePath (required): Destination path on the remote server
  • sync (optional): Wait for completion (default: true)

Example: { "localPath": "/home/user/file.txt", "remotePath": "/tmp/uploaded.txt" }

Max upload size is configurable in Tabby Settings → MCP → SFTP.
An interrupted upload can report OUTCOME_UNKNOWN: the remote backend may still commit. Inspect the remote file before retrying.`, schema: targets(z.object({
                ...sessionSchema,
                localPath: z.string().refine(value => path.isAbsolute(value), 'Host file path must be absolute').describe('REQUIRED: Absolute path to local file (e.g., /home/user/file.txt)'),
                remotePath: z.string().describe('REQUIRED: Remote destination path (e.g., /tmp/uploaded.txt)'),
                sync: z.boolean().optional().describe('Wait for completion, default true. Set false to get transferId for async tracking')
            })), scopes: ['files:write', 'files:read'], aggregate: false },
  { name: 'sftp_download', description: `Download a remote file to local path via SFTP.

⚠️ IMPORTANT: Use these exact parameter names:
  • remotePath (required): Path to the file on the remote server
  • localPath (required): Absolute path for local destination
  • sync (optional): Wait for completion (default: true)

Example: { "remotePath": "/tmp/remote.txt", "localPath": "/home/user/downloaded.txt" }

Max download size is configurable in Tabby Settings → MCP → SFTP.`, schema: targets(z.object({
                ...sessionSchema,
                remotePath: z.string().describe('REQUIRED: Remote file path to download (e.g., /tmp/remote.txt)'),
                localPath: z.string().refine(value => path.isAbsolute(value), 'Host file path must be absolute').describe('REQUIRED: Local destination path, must be absolute (e.g., /home/user/file.txt)'),
                sync: z.boolean().optional().describe('Wait for completion, default true. Set false to get transferId for async tracking')
            })), scopes: ['files:write', 'files:read'], aggregate: false },
  { name: 'sftp_get_transfer_status', description: 'Get status and progress of a file transfer task.', schema: targets(z.object({
                transferId: z.string().describe('Transfer task ID from sftp_upload/sftp_download')
            })), scopes: ['files:read'], aggregate: false },
  { name: 'sftp_list_transfers', description: 'List all active and recent file transfers.', schema: targets(z.object({
                status: z.enum(['all', 'active', 'completed', 'failed', 'unknown']).optional().describe('Filter by status')
            })), scopes: ['files:read'], aggregate: true },
  { name: 'sftp_cancel_transfer', description: 'Request cancellation of an active file transfer. Started uploads may report an unknown remote outcome.', schema: targets(z.object({
                transferId: z.string().describe('Transfer task ID to cancel')
            })), scopes: ['files:write'], aggregate: false },
  { name: 'list_windows', description: 'List every authorized Tabby window and its capabilities.',
    schema: z.object({ windowId: z.string().uuid().optional() }).strict(), scopes: ['terminal:read'], aggregate: true },
  { name: 'read_terminal_output', description: 'Read bounded incremental PTY output. Cursors are opaque; gaps report eviction.',
    schema: targets(z.object({ cursor: z.string().max(256).optional(), maxBytes: z.number().int().min(1).max(65536).default(65536),
      waitMs: z.number().int().min(0).max(25000).default(0) })), scopes: ['terminal:read'], aggregate: false },
];
export const TOOL_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));
export function authorize(principal: Principal, operation: string, params: Record<string, unknown> = {}, windowId?: string): void {
  const definition = TOOL_BY_NAME.get(operation);
  if (!definition) throw new HubError('UNKNOWN_TOOL', 'Unknown tool.');
  const scopes = [...definition.scopes];
  if (operation === 'get_session_environment' && params.activeProbe === true) scopes.push('terminal:write');
  if (!scopes.every(scope => principal.scopes.includes(scope))) throw new HubError('FORBIDDEN', 'Required scope is not granted.');
  if (principal.expiresAt && principal.expiresAt <= Date.now()) throw new HubError('UNAUTHORIZED', 'Grant expired.');
  if (windowId && principal.windows && !principal.windows.includes(windowId)) throw new HubError('FORBIDDEN', 'Window is not granted.');
}
