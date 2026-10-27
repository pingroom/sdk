import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError } from '../dist/index.js';
import { recorder } from './helpers.mjs';

test('broadcast posts the ping body to the right path', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/ab12/notifications': () => ({
      status: 201,
      body: { id: 'n1', message: 'hi', created_at: 'now', action_number: null, action_icon: null, trigger_source: null },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const res = await pr.broadcast('ab12', {
    message: 'hi',
    data: { commit: 'abc' },
    correlation_id: 'c1',
    requires_ack: true,
    ack_timeout_seconds: 300,
  });
  assert.equal(res.id, 'n1');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    message: 'hi',
    data: { commit: 'abc' },
    correlation_id: 'c1',
    requires_ack: true,
    ack_timeout_seconds: 300,
  });
});

test('data is measured the way the server measures it, before any request', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/ab12/notifications': () => ({ status: 201, body: { id: 'n1', message: 'hi' } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  // 2,000 Persian characters are 4 KB of UTF-8 but 12 KB of json_encode output.
  assert.throws(
    () => pr.broadcast('ab12', { message: 'hi', data: { note: 'س'.repeat(2000) } }),
    (error) => error instanceof PingRoomError && error.code === 'invalid_data',
  );
  // json_encode escapes every slash, so 4,100 of them pass 8 KB too.
  assert.throws(
    () => pr.broadcast('ab12', { message: 'hi', data: { path: '/'.repeat(4100) } }),
    (error) => error instanceof PingRoomError && error.code === 'invalid_data',
  );
  assert.equal(calls.length, 0);

  await pr.broadcast('ab12', { message: 'hi', data: { note: 'a'.repeat(8000) } });
  assert.equal(calls.length, 1);
});

// Urgency and acknowledgement are independent flags on the wire. They were one
// (`requires_ack`, which also raised the interruption level), so a caller asking
// for a ping that cuts through Focus also demanded an acknowledgement.
test('broadcast forwards is_urgent without implying requires_ack', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/ab12/notifications': () => ({
      status: 201,
      body: { id: 'n1', message: 'prod is down', created_at: 'now', action_number: null, action_icon: null, trigger_source: null },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.broadcast('ab12', { message: 'prod is down', is_urgent: true });

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    message: 'prod is down',
    is_urgent: true,
  });
});

test('broadcast accepts public-room Ping boundaries and forwards the title', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/public1/notifications': () => ({
      status: 201,
      body: { id: 'n1', message: 'ok', created_at: 'now', action_number: null, action_icon: null, trigger_source: null },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const message = 'm'.repeat(160);
  const title = 't'.repeat(40);

  await pr.broadcast('public1', { message, title });

  assert.deepEqual(JSON.parse(calls[0].init.body), { message, title });
});

test('broadcast rejects only the public ceiling locally and leaves private-room enforcement to the server', async () => {
  let requests = 0;
  const pr = new PingRoom({
    token: 't',
    fetch: async () => {
      requests += 1;
      return new Response('{}', { status: 201 });
    },
  });

  assert.throws(
    () => pr.broadcast('ab12', { message: 'm'.repeat(161) }),
    (error) => error instanceof PingRoomError
      && error.code === 'invalid_request'
      && /message.*160.*161/.test(error.message),
  );
  assert.throws(
    () => pr.broadcast('ab12', { message: 'ok', title: 't'.repeat(41) }),
    (error) => error instanceof PingRoomError
      && error.code === 'invalid_request'
      && /title.*40.*41/.test(error.message),
  );
  assert.equal(requests, 0);
});

test('agents.ping hits the handle path', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/agents/agt_x/ping': () => ({
      status: 201,
      body: {
        id: 'n',
        target_handle: 'agt_x',
        room_code: 'r',
        message: 'hi',
        correlation_id: null,
        reply_to: null,
        created_at: 'now',
      },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const r = await pr.agents.ping('agt_x', { message: 'hi' });
  assert.equal(r.target_handle, 'agt_x');
  assert.equal(calls[0].url.endsWith('/api/agent/agents/agt_x/ping'), true);
});
