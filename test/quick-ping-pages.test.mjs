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

test('quick action input types round-trip and a press carries its detail', async () => {
  const { pr, calls } = setup();
  await pr.actions.update('AB12', 2, { label: 'Where?', icon: '📍', input_type: 'location' });
  assert.deepEqual(calls.at(-1).body, { label: 'Where?', icon: '📍', input_type: 'location' });
  await pr.actions.updateMany('AB12', [{ action_number: 3, label: 'Receipt', icon: '📄', input_type: 'pdf' }]);
  assert.equal(calls.at(-1).body.actions[0].input_type, 'pdf');

  await pr.actions.trigger('AB12', 2, {
    quick_action_id: '3f2c9c1e-6d1a-4f0e-9a7b-2b8c1d2e3f40',
    data: { location: { latitude: 25.2048, longitude: 55.2708, label: 'Dubai Mall' } },
  });
  assert.deepEqual(calls.at(-1), {
    path: '/api/agent/rooms/AB12/actions/2/trigger', method: 'POST',
    body: { quick_action_id: '3f2c9c1e-6d1a-4f0e-9a7b-2b8c1d2e3f40', data: { location: { latitude: 25.2048, longitude: 55.2708, label: 'Dubai Mall' } } },
  });
  await pr.actions.trigger('AB12', 2, { data: { url: 'https://ci.example.com/run/42' } });
  assert.deepEqual(calls.at(-1).body, { data: { url: 'https://ci.example.com/run/42' } });
  await pr.actions.trigger('AB12', 3, { attachment_ids: ['a1', 'a2'] });
  assert.deepEqual(calls.at(-1).body, { attachment_ids: ['a1', 'a2'] });
  assert.equal(calls.length, 5);
});

test('quick action press details are validated locally before any request', async () => {
  const { pr, calls } = setup();
  assert.throws(() => pr.actions.trigger('AB12', 2, { data: { url: 'javascript:alert(1)' } }), PingRoomError);
  assert.throws(() => pr.actions.trigger('AB12', 2, { data: { location: { latitude: 91, longitude: 0 } } }), PingRoomError);
  assert.throws(() => pr.actions.trigger('AB12', 2, { data: { url: 'https://x.example', button_label: 'Open' } }), /button_label/);
  assert.throws(() => pr.actions.trigger('AB12', 2, { attachment_ids: ['1', '2', '3', '4', '5'] }), /at most 4/);
  assert.equal(calls.length, 0);
  for (const [status, code] of [[422, 'quick_action_input_required'], [422, 'quick_action_input_type'], [409, 'quick_action_layout_changed']]) {
    const failing = setup(status, { code, message: 'Open PingRoom to add the detail this ping needs.' });
    await assert.rejects(() => failing.pr.actions.trigger('AB12', 2), (error) => error instanceof PingRoomError && error.status === status && error.code === code);
  }
});

test('a slot can be reserved as disabled, but an icon is still required with a label', async () => {
  const { pr, calls } = setup();
  await pr.actions.update('AB12', 4, { label: '', icon: '' });
  assert.deepEqual(calls.at(-1).body, { label: '', icon: '' });
  await pr.actions.updateMany('AB12', [{ action_number: 8, label: '', icon: '' }]);
  assert.deepEqual(calls.at(-1).body.actions, [{ action_number: 8, label: '', icon: '' }]);
  assert.throws(() => pr.actions.update('AB12', 4, { label: 'Named', icon: '' }), /icon/);
  assert.throws(() => pr.actions.updateMany('AB12', [{ action_number: 4, label: 'Named', icon: '' }]), /icon/);
  assert.equal(calls.length, 2);
});

test('updateLayout sends the snapshot contract and validates page shapes locally', async () => {
  const { pr, calls } = setup();
  const actions = Array.from({ length: 8 }, (_, i) => ({ action_number: i + 1, label: `P${i + 1}`, icon: '✅' }));
  await pr.actions.updateLayout('AB12', { base_action_ids: ['a', 'b'], page_order: [2, null], actions });
  assert.deepEqual(calls.at(-1), {
    path: '/api/agent/rooms/AB12/actions/layout', method: 'PUT',
    body: { base_action_ids: ['a', 'b'], page_order: [2, null], actions },
  });
  assert.throws(() => pr.actions.updateLayout('AB12', { base_action_ids: [], page_order: [], actions }), /page_order/);
  assert.throws(() => pr.actions.updateLayout('AB12', { base_action_ids: [], page_order: [5], actions: actions.slice(0, 4) }), /page_order/);
  assert.throws(() => pr.actions.updateLayout('AB12', { base_action_ids: [], page_order: [1], actions }), /exactly 4 slots/);
  assert.equal(calls.length, 1);
});

test('deletePage reads the current layout, renumbers the kept pages and preserves each slot', async () => {
  const stored = [
    { id: 'id-1', action_number: 1, label: 'One', icon: '1️⃣', requires_ack: true },
    { id: 'id-2', action_number: 2, label: '', icon: '' },
    { id: 'id-3', action_number: 3, label: 'Three', icon: '3️⃣', input_type: 'location', sound: 'ting' },
    { id: 'id-4', action_number: 4, label: 'Four', icon: '4️⃣' },
    { id: 'id-5', action_number: 5, label: 'Five', icon: '5️⃣' },
    { id: 'id-6', action_number: 6, label: 'Six', icon: '6️⃣', input_type: 'pdf' },
    { id: 'id-7', action_number: 7, label: '', icon: '' },
    { id: 'id-8', action_number: 8, label: 'Eight', icon: '8️⃣' },
  ];
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(init.method === 'GET' ? stored : stored.slice(4)), { status: 200 });
  };
  const pr = new PingRoom({ token: 'test-token', fetch });
  await pr.actions.deletePage('AB12', 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].path, '/api/agent/rooms/AB12/actions/layout');
  assert.deepEqual(calls[1].body.base_action_ids, ['id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6', 'id-7', 'id-8']);
  assert.deepEqual(calls[1].body.page_order, [2]);
  assert.deepEqual(calls[1].body.actions, [
    { action_number: 1, label: 'Five', icon: '5️⃣' },
    { action_number: 2, label: 'Six', icon: '6️⃣', input_type: 'pdf' },
    { action_number: 3, label: '', icon: '' },
    { action_number: 4, label: 'Eight', icon: '8️⃣' },
  ]);
  await assert.rejects(() => pr.actions.deletePage('AB12', 3), /2 page\(s\)/);
  const single = new PingRoom({ token: 'test-token', fetch: async () => new Response(JSON.stringify(stored.slice(0, 4)), { status: 200 }) });
  await assert.rejects(() => single.actions.deletePage('AB12', 1), /at least one page/);
});

test('public rooms carry a location trio or none, and attachments over 5 MiB never upload', async () => {
  const { pr, calls } = setup();
  const room = { name: 'Meetup', icon: 'globe', color: '#0391fe', handle: 'meetup' };
  await pr.rooms.createPublic({ ...room, location_name: 'Dubai Mall', location_latitude: 25.2048, location_longitude: 55.2708 });
  assert.deepEqual(calls.at(-1).body, { ...room, location_name: 'Dubai Mall', location_latitude: 25.2048, location_longitude: 55.2708 });
  await pr.rooms.createPublic(room);
  assert.deepEqual(calls.at(-1).body, room);
  assert.throws(() => pr.rooms.createPublic({ ...room, location_name: 'Dubai Mall' }), /together/);
  assert.equal(calls.length, 2);
  await assert.rejects(
    () => pr.attachments.upload({ filename: 'big.zip', content: new Uint8Array(5 * 1024 * 1024 + 1) }),
    (error) => error instanceof PingRoomError && error.code === 'attachment_too_large' && error.status === 413,
  );
  assert.equal(calls.length, 2);
});
