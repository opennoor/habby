import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_BY_NAME, authorize } from '../shared/catalog.js';
import { LOCAL_PRINCIPAL } from '../shared/protocol.js';

test('full catalog exposes 36 original tools and both Hub additions', () => {
  assert.equal(TOOLS.length, 38);
  assert.equal(TOOL_BY_NAME.size, 38);
  const original = `list_tabs select_tab close_tab close_all_tabs duplicate_tab next_tab previous_tab
    move_tab_left move_tab_right reopen_last_tab list_profiles open_profile show_profile_selector quick_connect
    split_tab get_session_list exec_command send_input submit_keyboard_interactive_response get_session_environment
    get_terminal_buffer abort_command get_command_status focus_pane sftp_list_files sftp_read_file sftp_write_file
    sftp_mkdir sftp_delete sftp_rename sftp_stat sftp_upload sftp_download sftp_get_transfer_status
    sftp_list_transfers sftp_cancel_transfer`.trim().split(/\s+/);
  assert.deepEqual(TOOLS.map(tool => tool.name).sort(), [...original, 'list_windows', 'read_terminal_output'].sort());
  for (const tool of TOOLS) authorize(LOCAL_PRINCIPAL, tool.name);
  assert.equal(TOOL_BY_NAME.get('exec_command')?.schema.safeParse({ command: 'whoami' }).success, true);
});
test('scopes distinguish reads, shell writes and host-file transfers', () => {
  const read = { id: 'reader', scopes: ['terminal:read', 'files:read'] };
  authorize(read, 'get_terminal_buffer');
  assert.throws(() => authorize(read, 'exec_command'));
  assert.throws(() => authorize(read, 'sftp_upload'));
  assert.throws(() => authorize(read, 'get_session_environment', { activeProbe: true }));
});
