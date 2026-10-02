import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_BY_NAME, authorize } from '../shared/catalog.js';
import { LOCAL_PRINCIPAL } from '../shared/protocol.js';

test('full catalog exposes 36 original tools and both Hub additions', () => {
  assert.equal(TOOLS.length, 38);
  assert.equal(TOOL_BY_NAME.size, 38);
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
