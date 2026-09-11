import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError, sendIncomingWebhook } from '../dist/index.js';

function setup(status = 200, response = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(response), { status });
  };
  return { calls, fetch, pr: new PingRoom({ token: 'test-token', fetch }) };
}

test('quick ping page slots survive SDK send, edit, trigger, and webhook requests', async () => {
  const { pr, calls, fetch } = setup();
  for (const slot of [4, 5, 8, 9, 12, 13, 16]) {
    await pr.broadcast('AB12', { message: 'Ready', action_number: slot });
    await pr.agents.ping('agt_test', { message: 'Ready', action_number: slot });
    await pr.actions.update('AB12', slot, { label: '', icon: '✅' });
    await pr.actions.trigger('AB12', slot);
    await pr.webhooks.create('AB12', { name: 'Build', action_number: slot });
    await sendIncomingWebhook('https://api.pingroom.io/api/webhooks/AB12/test', { message: 'Ready', action: slot }, { fetch });

    const requests = calls.slice(-6);
    assert.equal(requests[0].body.action_number, slot);
    assert.equal(requests[1].body.action_number, slot);
    assert.equal(requests[2].path, `/api/agent/rooms/AB12/actions/${slot}`);
    assert.deepEqual(requests[2].body, { label: '', icon: '✅' });
    assert.equal(requests[3].path, `/api/agent/rooms/AB12/actions/${slot}/trigger`);
    assert.equal(requests[4].body.action_number, slot);
    assert.equal(requests[5].body.action, slot);
  }
  assert.equal(calls.length, 42);
});

test('quick ping batches preserve four slots, all 16 slots, and sparse page edits', async () => {
  const { pr, calls } = setup();
  for (const slots of [[1, 2, 3, 4], Array.from({ length: 16 }, (_, i) => i + 1), [5, 16]]) {
    const actions = slots.map((action_number) => ({ action_number, label: '', icon: '✅' }));
    await pr.actions.updateMany('AB12', actions);
    assert.deepEqual(calls.at(-1), { path: '/api/agent/rooms/AB12/actions', method: 'PUT', body: { actions } });
  }
  assert.equal(calls.length, 3);
});

test('quick ping page limits and disabled slots remain server-authoritative', async () => {
  for (const [status, code] of [[403, 'pro_required'], [404, 'action_not_configured']]) {
    const { pr, calls } = setup(status, { code, message: 'This Quick Ping is unavailable.' });
    await assert.rejects(() => pr.actions.trigger('AB12', 16), (error) => error instanceof PingRoomError && error.status === status && error.code === code);
    assert.equal(calls.length, 1);
  }
});

test('invalid quick ping slots and duplicate later-page edits never reach the API', async () => {
  const { pr, calls, fetch } = setup();
  for (const slot of [0, 17, 1.5, NaN, Infinity, '5']) {
    assert.throws(() => pr.actions.trigger('AB12', slot), /integer 1–16/);
    assert.throws(() => pr.broadcast('AB12', { message: 'Ready', action_number: slot }), /integer 1–16/);
    await assert.rejects(() => sendIncomingWebhook('https://api.pingroom.io/test', { action: slot }, { fetch }), /integer 1–16/);
  }
  assert.throws(() => pr.actions.updateMany('AB12', [
    { action_number: 16, label: 'First', icon: '✅' },
    { action_number: 16, label: 'Second', icon: '✅' },
  ]), /Duplicate action_number 16/);
  assert.equal(calls.length, 0);
});
