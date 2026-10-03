import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { globalId, parseGlobalId, wireMessageSchema } from '../shared/protocol.js';

test('global targets preserve window ownership and reject malformed IDs', () => {
  const windowId = randomUUID();
  assert.deepEqual(parseGlobalId(globalId(windowId, 'pane/a')), { windowId, localId: 'pane/a' });
  assert.throws(() => parseGlobalId('0/foo'));
  assert.throws(() => parseGlobalId(`${windowId}/%Q`));
});
test('wire registration validates bounded topology and rejects extra fields', () => {
  const registration = { type: 'register', protocol: 1, windowId: randomUUID(), metadata: {},
    capabilities: [], snapshot: { tabs: [], sessions: [], profiles: [], transfers: [] } };
  assert.equal(wireMessageSchema.safeParse(registration).success, true);
  assert.equal(wireMessageSchema.safeParse({ ...registration, protocol: 2 }).success, false);
  assert.equal(wireMessageSchema.safeParse({ ...registration, credential: 'secret' }).success, false);
});
