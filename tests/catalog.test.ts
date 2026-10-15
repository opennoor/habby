import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_BY_NAME, authorize } from '../shared/catalog.js';
import { LOCAL_PRINCIPAL } from '../shared/protocol.js';
import path from 'node:path';
import os from 'node:os';

test('full catalog exposes 36 original tools and three Hub additions', () => {
  assert.equal(TOOLS.length, 39);
  assert.equal(TOOL_BY_NAME.size, 39);
  const original = `list_tabs select_tab close_tab close_all_tabs duplicate_tab next_tab previous_tab
    move_tab_left move_tab_right reopen_last_tab list_profiles open_profile show_profile_selector quick_connect
    split_tab get_session_list exec_command send_input submit_keyboard_interactive_response get_session_environment
    get_terminal_buffer abort_command get_command_status focus_pane sftp_list_files sftp_read_file sftp_write_file
    sftp_mkdir sftp_delete sftp_rename sftp_stat sftp_upload sftp_download sftp_get_transfer_status
    sftp_list_transfers sftp_cancel_transfer`.trim().split(/\s+/);
  assert.deepEqual(TOOLS.map(tool => tool.name).sort(), [...original, 'list_windows', 'read_terminal_output', 'habby.new_window'].sort());
  for (const tool of TOOLS) authorize(LOCAL_PRINCIPAL, tool.name);
  assert.equal(TOOL_BY_NAME.get('exec_command')?.schema.safeParse({ command: 'whoami' }).success, true);
  assert.equal(TOOL_BY_NAME.get('sftp_list_transfers')?.schema.safeParse({ status: 'unknown' }).success, true);
});
test('split schema rejects unsupported ratios instead of silently ignoring them', () => {
  const schema = TOOL_BY_NAME.get('split_tab')!.schema;
  for (const direction of ['left', 'right', 'top', 'bottom', 'horizontal', 'vertical']) assert.equal(schema.safeParse({ direction }).success, true);
  for (const ratio of [0, 0.2, 0.5, 0.9, 1]) assert.equal(schema.safeParse({ direction: 'right', ratio }).success, false);
});
test('command timeout accepts only bounded positive integer milliseconds', () => {
  const schema = TOOL_BY_NAME.get('exec_command')!.schema;
  for (const timeout of [-1, 0, 0.5, 300001, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
    assert.equal(schema.safeParse({ command: 'echo hello', timeout }).success, false);
  }
  for (const timeout of [undefined, 1, 30000, 300000]) assert.equal(schema.safeParse({ command: 'echo hello', timeout }).success, true);
});

test('scopes distinguish reads, shell writes and host-file transfers', () => {
  const read = { id: 'reader', scopes: ['terminal:read', 'files:read'] };
  authorize(read, 'get_terminal_buffer');
  assert.throws(() => authorize(read, 'exec_command'));
  assert.throws(() => authorize(read, 'sftp_upload'));
  assert.throws(() => authorize(read, 'get_session_environment', { activeProbe: true }));
});

test('target defaults preserve tool-specific required fields and descriptions', () => {
  for (const [name, key] of [['focus_pane', 'sessionId'], ['sftp_get_transfer_status', 'transferId'], ['sftp_cancel_transfer', 'transferId']]) {
    const schema = TOOL_BY_NAME.get(name)!.schema;
    assert.equal(schema.safeParse({}).success, false, name);
    assert.equal(schema.safeParse({ [key]: 'window/target' }).success, true, name);
    assert.ok(schema.shape[key].description, name);
  }
  assert.equal(TOOL_BY_NAME.get('send_input')!.schema.safeParse({ input: 'hello' }).success, true);
});

test('host upload and download paths must be absolute on this platform', () => {
  for (const name of ['sftp_upload', 'sftp_download']) {
    const schema = TOOL_BY_NAME.get(name)!.schema;
    for (const localPath of ['', 'file.txt', './file.txt', '../file.txt']) {
      assert.equal(schema.safeParse({ localPath, remotePath: '/remote/file' }).success, false, `${name}: ${localPath}`);
    }
    assert.equal(schema.safeParse({ localPath: path.join(os.tmpdir(), 'file.txt'), remotePath: '/remote/file' }).success, true);
    if (process.platform === 'win32') {
      assert.equal(schema.safeParse({ localPath: 'C:\\files\\file.txt', remotePath: '/remote/file' }).success, true);
      assert.equal(schema.safeParse({ localPath: '\\\\server\\share\\file.txt', remotePath: '/remote/file' }).success, true);
      assert.equal(schema.safeParse({ localPath: 'C:file.txt', remotePath: '/remote/file' }).success, false);
    }
  }
});
