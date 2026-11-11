import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError, REPLACE_ERROR_CODES, WITHDRAW_ERROR_CODES, COMMON_ERROR_CODES } from '../dist/index.js';
import { recorder } from './helpers.mjs';

const PATH = '/api/agent/rooms/ab12/notifications/n1/withdraw';
const PING = {
  id: 'n1',
  message: 'Deploy started',
  action_number: null,
  action_icon: null,
  trigger_source: 'manual',
  created_at: 'now',
  edited_at: null,
  withdrawn_at: '2026-11-11T12:00:00.000000Z',
};

test('notifications.withdraw POSTs to the Ping\'s withdraw route and returns it with withdrawn_at', async () => {
  const { calls, fetchMock } = recorder({ [`POST ${PATH}`]: () => ({ body: PING }) });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const res = await pr.notifications.withdraw('ab12', 'n1');

  assert.equal(res.id, 'n1');
  // The text stays: the Ping is still in the room's history.
  assert.equal(res.message, 'Deploy started');
  assert.equal(res.withdrawn_at, '2026-11-11T12:00:00.000000Z');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new URL(calls[0].url).pathname, PATH);
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
  // No Idempotency-Key: withdrawing twice is a no-op by itself.
  assert.equal(Object.keys(calls[0].init.headers).some((name) => name.toLowerCase() === 'idempotency-key'), false);
});

test('withdraw URL-encodes both path segments and refuses empty ones before any request', async () => {
  const { calls, fetchMock } = recorder({ '*': () => ({ body: PING }) });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  await pr.notifications.withdraw('ab 12', 'n/1');
  assert.equal(new URL(calls[0].url).pathname, '/api/agent/rooms/ab%2012/notifications/n%2F1/withdraw');

  const invalid = (error) => error instanceof PingRoomError && error.code === 'invalid_request';
  assert.throws(() => pr.notifications.withdraw('', 'n1'), invalid);
  assert.throws(() => pr.notifications.withdraw('ab12', ' '), invalid);
  assert.equal(calls.length, 1);
});

test('every withdraw refusal surfaces its status and code on the error', async () => {
  const refusals = [
    [404, 'notification_not_found'],
    [403, 'not_ping_owner'],
    [422, 'unsupported_room'],
    [422, 'unsupported_question'],
    [422, 'unsupported_handoff'],
    [422, 'unsupported_live_status'],
    [422, 'unsupported_claim'],
    [422, 'unsupported_ack'],
    [422, 'unsupported_checklist'],
    [422, 'unsupported_source'],
    [409, 'withdraw_window_closed'],
  ];
  assert.deepEqual(refusals.map(([, code]) => code), [...WITHDRAW_ERROR_CODES]);

  for (const [status, code] of refusals) {
    const pr = new PingRoom({
      token: 't',
      fetch: async () => new Response(JSON.stringify({ code, message: `refused: ${code}` }), { status }),
    });
    await assert.rejects(
      () => pr.notifications.withdraw('ab12', 'n1'),
      (error) => error instanceof PingRoomError && error.status === status && error.code === code,
    );
  }
});

test('a withdraw 404 with no code (withdrawing is off on the server) is a plain 404', async () => {
  const pr = new PingRoom({
    token: 't',
    fetch: async () => new Response(JSON.stringify({ message: 'Resource not found.' }), { status: 404 }),
  });
  await assert.rejects(
    () => pr.notifications.withdraw('ab12', 'n1'),
    (error) => error instanceof PingRoomError && error.status === 404 && error.code === null,
  );
});

test('the withdraw error codes are distinct snake_case codes and none is common', () => {
  assert.equal(new Set(WITHDRAW_ERROR_CODES).size, WITHDRAW_ERROR_CODES.length);
  for (const code of WITHDRAW_ERROR_CODES) {
    assert.match(code, /^[a-z][a-z0-9_]*$/);
    assert.equal(COMMON_ERROR_CODES.includes(code), false);
  }
});

test('a replace refused because the Ping was withdrawn carries ping_withdrawn', async () => {
  assert.ok(REPLACE_ERROR_CODES.includes('ping_withdrawn'));
  const pr = new PingRoom({
    token: 't',
    fetch: async () => new Response(JSON.stringify({ code: 'ping_withdrawn', message: 'A Ping that was withdrawn cannot be replaced.' }), { status: 409 }),
  });
  await assert.rejects(
    () => pr.notifications.replace('ab12', 'n1', { message: 'm' }),
    (error) => error instanceof PingRoomError && error.status === 409 && error.code === 'ping_withdrawn',
  );
});

test('reads keep withdrawn_at on the notification types', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/notifications/n1': () => ({ body: { ...PING, state: 'delivered' } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const detail = await pr.notifications.getNotification('n1');
  assert.equal(detail.withdrawn_at, '2026-11-11T12:00:00.000000Z');
});
