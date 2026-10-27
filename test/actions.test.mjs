import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom } from '../dist/index.js';
import { recorder } from './helpers.mjs';

test('actions.update forwards and returns the acknowledgement policy', async () => {
  const { calls, fetchMock } = recorder({
    'PUT /api/agent/rooms/ab12/actions/2': ({ init }) => ({
      body: {
        id: 'qa2',
        action_number: 2,
        ...JSON.parse(init.body),
      },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const action = await pr.actions.update('ab12', 2, {
    label: 'Take this',
    icon: '🙋',
    requires_ack: true,
  });

  assert.equal(action.requires_ack, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    label: 'Take this',
    icon: '🙋',
    requires_ack: true,
  });
});

test('actions.updateMany writes every slot in a single request', async () => {
  const { calls, fetchMock } = recorder({
    'PUT /api/agent/rooms/ab12/actions': ({ init }) => ({
      body: JSON.parse(init.body).actions,
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const actions = await pr.actions.updateMany('ab12', [
    { action_number: 1, label: 'Deployed', icon: '✅' },
    { action_number: 2, label: '', icon: '🔥' },
  ]);

  // One request, not one per slot — the whole point of the method.
  assert.equal(calls.length, 1);
  assert.equal(actions.length, 2);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    actions: [
      { action_number: 1, label: 'Deployed', icon: '✅' },
      { action_number: 2, label: '', icon: '🔥' },
    ],
  });
});

test('actions.updateMany rejects a malformed batch before spending a request', async () => {
  const { calls, fetchMock } = recorder({});
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  // An empty array is a caller bug, not a way to clear a room's Pings.
  assert.throws(() => pr.actions.updateMany('ab12', []), /at least one action/);
  assert.throws(
    () => pr.actions.updateMany('ab12', Array.from({ length: 17 }, (_, i) => ({
      action_number: i + 1, label: 'Ready', icon: '✅',
    }))),
    /at most 16 action slots/,
  );
  // Two entries for one slot: the last would silently win server-side.
  assert.throws(
    () => pr.actions.updateMany('ab12', [
      { action_number: 2, label: 'a', icon: '1' },
      { action_number: 2, label: 'b', icon: '2' },
    ]),
    /Duplicate action_number 2/,
  );
  assert.throws(
    () => pr.actions.updateMany('ab12', [{ action_number: 1, label: 'a', icon: '' }]),
    /`icon` is required/,
  );

  assert.equal(calls.length, 0);
});

test('actions.update sends an emoji-only Ping with an empty label', async () => {
  // A Ping's title is optional — the emoji can be the whole name — so `''` is
  // a deliberate value the SDK must forward, not a missing field it rejects.
  const { calls, fetchMock } = recorder({
    'PUT /api/agent/rooms/ab12/actions/1': ({ init }) => ({
      body: { id: 'qa1', action_number: 1, ...JSON.parse(init.body) },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const action = await pr.actions.update('ab12', 1, { label: '', icon: '🔥' });

  assert.equal(action.label, '');
  assert.deepEqual(JSON.parse(calls[0].init.body), { label: '', icon: '🔥' });
});

test('actions.update still refuses a missing label or a blank icon', async () => {
  const { fetchMock } = recorder({});
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  // Both guards run before the request, so they throw synchronously.
  assert.throws(
    () => pr.actions.update('ab12', 1, { icon: '🔥' }),
    /`label` must be a string/,
  );
  assert.throws(
    () => pr.actions.update('ab12', 1, { label: 'Hi', icon: '  ' }),
    /`icon` is required/,
  );
});

test('trigger forwards a one-shot is_urgent for a single quick-action press', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/ab12/actions/2/trigger': () => ({
      status: 201,
      body: { id: 'n2', message: 'pressed', created_at: 'now', action_number: 2, action_icon: null, trigger_source: 'manual' },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.actions.trigger('ab12', 2, { is_urgent: true });

  assert.deepEqual(JSON.parse(calls[0].init.body), { is_urgent: true });
});
