import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WindowRegistry } from '../packages/hub/src/registry.js';
import { globalId, LOCAL_PRINCIPAL, MAX_REQUEST_TIMEOUT_MS, wireMessageSchema } from '../shared/protocol.js';

test('abort during listener attachment prevents request dispatch and clears pending state', async () => {
  const registry = new WindowRegistry(); const windowId = randomUUID(); const messages: any[] = [];
  registry.register({ type: 'register', protocol: 1, windowId, metadata: {}, capabilities: ['exec_command'],
    snapshot: { tabs: [], sessions: [], profiles: [], transfers: [] } }, message => messages.push(message));
  const controller = new AbortController();
  const attach = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { controller.abort(); attach(...args); };
  try {
    await assert.rejects(registry.call('exec_command', { windowId, command: 'never' }, LOCAL_PRINCIPAL, controller.signal), { code: 'OUTCOME_UNKNOWN' });
    assert.equal(messages.filter(message => message.type === 'request').length, 0);
    assert.equal((registry as any).pending.size, 0);
  } finally { registry.close(); }
});

test('two matching windows remain isolated and ambiguous mutation fails', async () => {
  const registry = new WindowRegistry();
  const windows = [randomUUID(), randomUUID()];
  const requests: any[] = [];
  for (const windowId of windows) registry.register({ type: 'register', protocol: 1, windowId,
    metadata: { label: 'same' }, capabilities: ['list_tabs', 'exec_command'],
    snapshot: { tabs: [{ id: 'tab', title: 'same' }], sessions: [{ id: 'pane', tabId: 'tab' }], profiles: [], transfers: [] },
  }, message => {
    if (message.type === 'request') {
      requests.push(message);
      registry.receive(windowId, message.epoch, { type: 'response', id: message.id, windowId,
        epoch: message.epoch, result: { content: [{ type: 'text', text: JSON.stringify({ window: windowId, sessionId: 'pane' }) }] } });
    }
  });
  await assert.rejects(registry.call('exec_command', { command: 'whoami' }, LOCAL_PRINCIPAL), { code: 'AMBIGUOUS_TARGET' });
  const result = await registry.call('exec_command', { command: 'whoami', sessionId: globalId(windows[1], 'pane') }, LOCAL_PRINCIPAL);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].windowId, windows[1]);
  assert.equal(requests[0].params.sessionId, 'pane');
  assert.match(JSON.stringify(result), new RegExp(windows[1]));
  await assert.rejects(registry.call('exec_command', { command: 'x', windowId: windows[0], sessionId: globalId(windows[1], 'pane') }, LOCAL_PRINCIPAL), { code: 'INVALID_TARGET' });
  registry.close();
});

test('aggregate discovery preserves healthy windows when another lacks the capability', async () => {
  const registry = new WindowRegistry();
  const windows = [randomUUID(), randomUUID()];
  for (const [index, windowId] of windows.entries()) registry.register({
    type: 'register', protocol: 1, windowId, metadata: {}, capabilities: index ? ['sftp_list_transfers'] : [],
    snapshot: { tabs: [], sessions: [], profiles: [], transfers: [] },
  }, message => {
    if (message.type === 'request') registry.receive(windowId, message.epoch, {
      type: 'response', windowId, epoch: message.epoch, id: message.id,
      result: { content: [{ type: 'text', text: '[]' }] },
    });
  });
  try {
    const result = await registry.call('sftp_list_transfers', {}, LOCAL_PRINCIPAL) as { content: { text: string }[] };
    const response = JSON.parse(result.content[0].text).windows;
    assert.equal(response[0].error.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(response[1].windowId, windows[1]); assert.deepEqual(response[1].result, []);
  } finally { registry.close(); }
});

test('window discovery withholds transfer details without file-read permission', () => {
  const registry = new WindowRegistry(); const windowId = randomUUID();
  registry.register({ type: 'register', protocol: 1, windowId, metadata: {}, capabilities: [],
    snapshot: { tabs: [], sessions: [], profiles: [], transfers: [{ id: 'transfer', path: '/private/file' }] },
  }, () => {});
  try {
    assert.deepEqual((registry.list({ ...LOCAL_PRINCIPAL, scopes: ['terminal:read'] })[0] as any).transfers, []);
    assert.equal((registry.list(LOCAL_PRINCIPAL)[0] as any).transfers[0].path, '/private/file');
  } finally { registry.close(); }
});

test('excluded windows reveal neither their topology nor their existence through routing errors', async () => {
  const registry = new WindowRegistry(); const windowId = randomUUID();
  registry.register({ type: 'register', protocol: 1, windowId, metadata: {}, capabilities: ['exec_command'],
    snapshot: { tabs: [{ id: 'tab' }], sessions: [{ id: 'pane', tabId: 'tab' }], profiles: [{ id: 'profile' }], transfers: [{ id: 'transfer' }] },
  }, () => { throw new Error('Unauthorized dispatch'); });
  const restricted = { ...LOCAL_PRINCIPAL, windows: [randomUUID()] };
  try {
    for (const id of [windowId, randomUUID()]) {
      for (const [operation, key, localId, params] of [
        ['exec_command', 'sessionId', 'pane', { command: 'true' }],
        ['close_tab', 'tabId', 'tab', {}],
        ['open_profile', 'profileId', 'profile', {}],
        ['sftp_get_transfer_status', 'transferId', 'transfer', {}],
      ] as const) {
        for (const target of [localId, 'missing']) {
          await assert.rejects(registry.call(operation, { ...params, [key]: globalId(id, target) }, restricted),
            { code: 'FORBIDDEN', message: 'Window is not granted.' });
        }
      }
      await assert.rejects(registry.call('exec_command', { windowId: id, command: 'true' }, restricted), { code: 'FORBIDDEN' });
      await assert.rejects(registry.call('list_windows', { windowId: id }, restricted), { code: 'FORBIDDEN' });
    }
    await assert.rejects(registry.call('exec_command', { command: 'true', sessionId: globalId(windowId, 'missing') }, LOCAL_PRINCIPAL), { code: 'TARGET_NOT_FOUND' });
  } finally { registry.close(); }
});

test('disconnected mutations have unknown outcome and never auto-replay', async () => {
  const registry = new WindowRegistry();
  const windowId = randomUUID();
  let requests = 0;
  const registration = { type: 'register' as const, protocol: 1 as const, windowId, metadata: {},
    capabilities: ['send_input'], snapshot: { tabs: [], sessions: [], profiles: [], transfers: [] } };
  const connection = registry.register(registration, message => { if (message.type === 'request') requests++; });
  const pending = registry.call('send_input', { windowId, input: 'x' }, LOCAL_PRINCIPAL);
  registry.disconnect(windowId, connection.epoch);
  await assert.rejects(pending, { code: 'OUTCOME_UNKNOWN' });
  assert.throws(() => registry.register(registration, () => {}), { code: 'INVALID_RESUME' });
  const resumed = registry.register({ ...registration, resumeToken: connection.resumeToken }, () => {});
  registry.disconnect(windowId, resumed.epoch);
  // A lost acknowledgement must not strand the incarnation with an unknown rotated secret.
  const resumedAgain = registry.register({ ...registration, resumeToken: connection.resumeToken }, () => {});
  assert.equal(resumedAgain.resumeToken, connection.resumeToken);
  assert.notEqual(resumedAgain.epoch, resumed.epoch);
  assert.equal(requests, 1);
  registry.close();
});


test('maximum command timeout returns monitored TIMEOUT within the observation margin', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const registry = new WindowRegistry(), windowId = randomUUID();
  let request: any, settled = false;
  registry.register({ type: 'register', protocol: 1, windowId, metadata: {}, capabilities: ['exec_command'],
    snapshot: { tabs: [], sessions: [], profiles: [], transfers: [] } }, message => {
    if (message.type !== 'request') return;
    request = wireMessageSchema.parse(message);
    setTimeout(() => registry.receive(windowId, message.epoch, { type: 'response', id: message.id, windowId,
      epoch: message.epoch, result: { success: false, error: 'TIMEOUT', outcomeUnknown: true, stillMonitored: true } }), 301000);
  });
  try {
    const pending = registry.call('exec_command', { windowId, command: 'slow', timeout: 300000 }, LOCAL_PRINCIPAL)
      .then(result => { settled = true; return result; });
    assert.equal(request.timeoutMs, MAX_REQUEST_TIMEOUT_MS);
    assert.equal(wireMessageSchema.safeParse({ ...request, timeoutMs: MAX_REQUEST_TIMEOUT_MS + 1 }).success, false);
    t.mock.timers.tick(300000); await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1000);
    assert.deepEqual(await pending, { success: false, error: 'TIMEOUT', outcomeUnknown: true, stillMonitored: true });
  } finally { registry.close(); }
});
