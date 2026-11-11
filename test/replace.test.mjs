import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError, REPLACE_ERROR_CODES, COMMON_ERROR_CODES, sendIncomingWebhook } from '../dist/index.js';
import { recorder } from './helpers.mjs';

const PATH = '/api/agent/rooms/ab12/notifications/n1';
const PING = {
  id: 'n1',
  message: 'Build 41: green',
  action_number: null,
  action_icon: null,
  trigger_source: 'manual',
  created_at: 'now',
  edited_at: '2026-11-11T12:00:00.000000Z',
};

test('notifications.replace PUTs the new text to the Ping and returns it with edited_at', async () => {
  const { calls, fetchMock } = recorder({ [`PUT ${PATH}`]: () => ({ body: PING }) });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const res = await pr.notifications.replace('ab12', 'n1', { message: 'Build 41: green' });

  assert.equal(res.id, 'n1');
  assert.equal(res.edited_at, '2026-11-11T12:00:00.000000Z');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(new URL(calls[0].url).pathname, PATH);
  // title and data were omitted, so they are not on the wire: the server keeps them.
  assert.deepEqual(JSON.parse(calls[0].init.body), { message: 'Build 41: green' });
  // No Idempotency-Key: a replacement has none.
  assert.equal(Object.keys(calls[0].init.headers).some((name) => name.toLowerCase() === 'idempotency-key'), false);
});

test('replace sends title and data as given, and null clears them', async () => {
  const { calls, fetchMock } = recorder({ [`PUT ${PATH}`]: () => ({ body: PING }) });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  await pr.notifications.replace('ab12', 'n1', { message: 'm', title: 'Deploy', data: { build: 41 } });
  await pr.notifications.replace('ab12', 'n1', { message: 'm', title: null, data: null });
  await pr.notifications.replace('ab12', 'n1', { message: 'm', title: '' });

  assert.deepEqual(JSON.parse(calls[0].init.body), { message: 'm', title: 'Deploy', data: { build: 41 } });
  assert.deepEqual(JSON.parse(calls[1].init.body), { message: 'm', title: null, data: null });
  assert.deepEqual(JSON.parse(calls[2].init.body), { message: 'm', title: '' });
});

test('replace URL-encodes both path segments and refuses empty ones before any request', async () => {
  const { calls, fetchMock } = recorder({ '*': () => ({ body: PING }) });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  await pr.notifications.replace('ab 12', 'n/1', { message: 'm' });
  assert.equal(new URL(calls[0].url).pathname, '/api/agent/rooms/ab%2012/notifications/n%2F1');

  const invalid = (error) => error instanceof PingRoomError && error.code === 'invalid_request';
  assert.throws(() => pr.notifications.replace('', 'n1', { message: 'm' }), invalid);
  assert.throws(() => pr.notifications.replace('ab12', ' ', { message: 'm' }), invalid);
  assert.throws(() => pr.notifications.replace('ab12', 'n1', { message: '' }), invalid);
  assert.throws(() => pr.notifications.replace('ab12', 'n1', {}), invalid);
  assert.equal(calls.length, 1);
});

test('replace checks length and data the way a send does, before any request', async () => {
  const { calls, fetchMock } = recorder({ '*': () => ({ body: PING }) });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  assert.throws(
    () => pr.notifications.replace('ab12', 'n1', { message: 'm'.repeat(161) }),
    (error) => error instanceof PingRoomError && error.code === 'invalid_request',
  );
  assert.throws(
    () => pr.notifications.replace('ab12', 'n1', { message: 'm', title: 't'.repeat(41) }),
    (error) => error instanceof PingRoomError && error.code === 'invalid_request',
  );
  assert.throws(
    () => pr.notifications.replace('ab12', 'n1', { message: 'm', data: [1] }),
    (error) => error instanceof PingRoomError && error.code === 'invalid_data',
  );
  assert.equal(calls.length, 0);
});

test('every replace refusal surfaces its status and code on the error', async () => {
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
    [422, 'unsupported_actions'],
    [409, 'replace_window_closed'],
    [409, 'replace_limit_reached'],
    [409, 'ping_withdrawn'],
  ];
  assert.deepEqual(refusals.map(([, code]) => code), [...REPLACE_ERROR_CODES]);

  for (const [status, code] of refusals) {
    const pr = new PingRoom({
      token: 't',
      fetch: async () => new Response(JSON.stringify({ code, message: `refused: ${code}` }), { status }),
    });
    await assert.rejects(
      () => pr.notifications.replace('ab12', 'n1', { message: 'm' }),
      (error) => error instanceof PingRoomError && error.status === status && error.code === code,
    );
  }
});

test('a replace 404 with no code (replacing is off on the server) is a plain 404', async () => {
  const pr = new PingRoom({
    token: 't',
    fetch: async () => new Response(JSON.stringify({ message: 'The route could not be found.' }), { status: 404 }),
  });
  await assert.rejects(
    () => pr.notifications.replace('ab12', 'n1', { message: 'm' }),
    (error) => error instanceof PingRoomError && error.status === 404 && error.code === null,
  );
});

test('the replace error codes are distinct snake_case codes and none is common', () => {
  assert.equal(new Set(REPLACE_ERROR_CODES).size, REPLACE_ERROR_CODES.length);
  for (const code of REPLACE_ERROR_CODES) {
    assert.match(code, /^[a-z][a-z0-9_]*$/);
    assert.equal(COMMON_ERROR_CODES.includes(code), false);
  }
});

test('broadcast sends replaceKey as replace_key and reads replaced and edited_at back', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/ab12/notifications': () => ({ status: 200, body: { ...PING, replaced: true } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const res = await pr.broadcast('ab12', { message: 'Build 41: green', replaceKey: 'build:41', idempotencyKey: 'k-1' });

  assert.equal(res.replaced, true);
  assert.equal(res.edited_at, '2026-11-11T12:00:00.000000Z');
  assert.deepEqual(JSON.parse(calls[0].init.body), { message: 'Build 41: green', replace_key: 'build:41' });
  // The camelCase name never reaches the wire.
  assert.equal(Object.hasOwn(JSON.parse(calls[0].init.body), 'replaceKey'), false);
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'k-1');
});

test('broadcast without a replaceKey sends no replace_key', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/ab12/notifications': () => ({ status: 201, body: { id: 'n2', message: 'hi' } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.broadcast('ab12', { message: 'hi' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { message: 'hi' });
});

test('replaceKey is checked the way the server checks it, before any request', async () => {
  const { calls, fetchMock } = recorder({
    '*': () => ({ status: 201, body: { id: 'n1', message: 'hi' } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const invalid = (error) => error instanceof PingRoomError && error.code === 'invalid_request';

  for (const replaceKey of ['', 'has space', 'ünï', 'a/b', 'x'.repeat(65), 7, null]) {
    assert.throws(() => pr.broadcast('ab12', { message: 'hi', replaceKey }), invalid, JSON.stringify(replaceKey));
  }
  assert.equal(calls.length, 0);

  for (const replaceKey of ['a', 'x'.repeat(64), 'build.41_prod:eu-1', 'A9']) {
    await pr.broadcast('ab12', { message: 'hi', replaceKey });
  }
  assert.equal(calls.length, 4);
});

test('sendIncomingWebhook sends replaceKey as replace_key and returns replaced', async () => {
  const { calls, fetchMock } = recorder({
    '*': () => ({ body: { success: true, notification_id: 'n1', replaced: true } }),
  });
  const result = await sendIncomingWebhook(
    'https://api.pingroom.io/api/webhooks/AB12/secret',
    { message: 'Build 41: green', replaceKey: 'build:41' },
    { fetch: fetchMock },
  );
  assert.equal(result.replaced, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { message: 'Build 41: green', replace_key: 'build:41' });

  await assert.rejects(
    () => sendIncomingWebhook(
      'https://api.pingroom.io/api/webhooks/AB12/secret',
      { message: 'm', replaceKey: 'no spaces allowed' },
      { fetch: fetchMock },
    ),
    (error) => error instanceof PingRoomError && error.code === 'invalid_request',
  );
  assert.equal(calls.length, 1);
});

test('edited_at is typed on reads: a string once replaced, null when never', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/notifications/n1': () => ({ body: { ...PING, action_state: null } }),
    'GET /api/agent/notifications/n2': () => ({ body: { ...PING, id: 'n2', edited_at: null, action_state: null } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  assert.equal((await pr.notifications.getNotification('n1')).edited_at, '2026-11-11T12:00:00.000000Z');
  assert.equal((await pr.notifications.getNotification('n2')).edited_at, null);
});
