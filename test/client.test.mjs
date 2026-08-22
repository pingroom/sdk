import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_INBOX_ERROR_CODES,
  HANDOFF_ERROR_CODES,
  PingRoom,
  PingRoomActivationIncompleteError,
  PingRoomError,
  PingRoomTimeoutError,
  ROOM_SCOPED_ERROR_CODES,
  VERSION,
} from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('package and lockfile versions stay aligned', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'));
  assert.equal(pkg.version, '0.4.3');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  // A VERSION that drifts from package.json makes the SDK misreport itself in
  // the User-Agent and the MCP clientInfo.
  assert.equal(VERSION, pkg.version);
});

/** Build a fetch mock that routes by "METHOD /pathname" and records every call. */
function recorder(routes) {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const handler = routes[`${init.method} ${u.pathname}`] ?? routes['*'];
    if (!handler) {
      return new Response('{}', { status: 404 });
    }
    const r = handler({ url: u, init });
    const body = r.body === undefined ? '' : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  };
  return { calls, fetchMock };
}

test('rooms.list GETs with bearer auth', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/rooms': () => ({ body: [{ id: 'r1', name: 'A', invite_code: 'ab12', icon: null, color: null }] }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });
  const rooms = await pr.rooms.list();
  assert.equal(rooms[0].id, 'r1');
  assert.equal(calls[0].init.headers['Authorization'], 'Bearer tok_abc');
});

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

test('notifications.wait sends cursor/timeout/limit and parses the result', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/notifications/wait': () => ({
      body: {
        notifications: [
          { id: 'n2', message: 'yo', created_at: 'now', action_number: null, action_icon: null, trigger_source: null },
        ],
        cursor: 'cur2',
      },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const r = await pr.notifications.wait({ after: 'cur1', timeout: 5, limit: 10 });
  assert.equal(r.cursor, 'cur2');
  assert.match(calls[0].url, /after=cur1/);
  assert.match(calls[0].url, /timeout=5/);
  assert.match(calls[0].url, /limit=10/);
});

test('notifications.getNotification fetches one notification and URL-encodes its id', async () => {
  const { calls, fetchMock } = recorder({
    '*': () => ({
      body: {
        id: 'n/1 ?',
        message: 'Please acknowledge',
        action_number: null,
        action_icon: null,
        trigger_source: 'webhook',
        created_at: 'now',
        action_state: {
          status: 'open',
          requires_ack: true,
          acked_by: null,
          acked_at: null,
          expires_at: null,
        },
      },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const notification = await pr.notifications.getNotification('n/1 ?');
  assert.equal(notification.action_state.status, 'open');
  assert.equal(new URL(calls[0].url).pathname, '/api/agent/notifications/n%2F1%20%3F');
});

test('notifications.waitForAcknowledgement sends timeout and returns the terminal state', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/notifications/n%2F1/ack/wait': () => ({
      body: {
        id: 'n/1',
        action_state: {
          status: 'acked',
          requires_ack: true,
          acked_by: { id: 'u1', name: 'Sam', profile_image: null },
          acked_at: 'now',
          expires_at: null,
        },
      },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const result = await pr.notifications.waitForAcknowledgement('n/1', { timeout: 7 });
  assert.equal(result.action_state.status, 'acked');
  assert.equal(result.action_state.acked_by.name, 'Sam');
  assert.match(calls[0].url, /\/api\/agent\/notifications\/n%2F1\/ack\/wait/);
  assert.match(calls[0].url, /timeout=7/);
});

test('notifications.listen yields across polls then stops on abort', async () => {
  let n = 0;
  const fetchMock = async (url) => {
    const u = new URL(url);
    if (u.pathname !== '/api/agent/notifications/wait') {
      return new Response('{}', { status: 404 });
    }
    n++;
    if (n === 1) {
      return new Response(JSON.stringify({ notifications: [], cursor: 'c0' }), { status: 200 });
    }
    const id = n === 2 ? 'a' : 'b';
    const cursor = n === 2 ? 'c1' : 'c2';
    return new Response(
      JSON.stringify({
        notifications: [{ id, message: String(n), created_at: 'now', action_number: null, action_icon: null, trigger_source: null }],
        cursor,
      }),
      { status: 200 },
    );
  };
  const ac = new AbortController();
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const got = [];
  for await (const ping of pr.notifications.listen({ signal: ac.signal })) {
    got.push(ping.id);
    if (got.length >= 2) {
      ac.abort();
    }
  }
  assert.deepEqual(got, ['a', 'b']);
});

test('directory.list is public (no Authorization header)', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agents/directory': () => ({
      body: { data: [], current_page: 1, per_page: 50, total: 0, last_page: 1, next_page_url: null, prev_page_url: null },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.directory.list({ tag: 'ci' });
  assert.equal(calls[0].init.headers['Authorization'], undefined);
  assert.match(calls[0].url, /tag=ci/);
});

test('maps the API error code and never leaks the token', async () => {
  const fetchMock = async () =>
    new Response(JSON.stringify({ code: 'pings_closed', message: 'closed' }), { status: 403 });
  const pr = new PingRoom({ token: 'super_secret_token', fetch: fetchMock });
  await assert.rejects(
    () => pr.agents.ping('agt_x', { message: 'hi' }),
    (e) => {
      assert.ok(e instanceof PingRoomError);
      assert.equal(e.code, 'pings_closed');
      assert.equal(e.status, 403);
      assert.equal(JSON.stringify(e).includes('super_secret_token'), false);
      assert.equal(String(e.message).includes('super_secret_token'), false);
      return true;
    },
  );
});

test('refuses an insecure base URL at construction', () => {
  assert.throws(
    () => new PingRoom({ baseUrl: 'http://api.evil.com' }),
    (e) => e instanceof PingRoomError && e.code === 'insecure_url',
  );
});

test('allows http for localhost dev', () => {
  assert.doesNotThrow(() => new PingRoom({ baseUrl: 'http://localhost:8000', fetch: async () => new Response('{}') }));
});

test('setToken updates the bearer used on subsequent calls', async () => {
  const { calls, fetchMock } = recorder({ 'GET /api/agent/rooms': () => ({ body: [] }) });
  const pr = new PingRoom({ fetch: fetchMock });
  pr.setToken('tok2');
  await pr.rooms.list();
  assert.equal(calls[0].init.headers['Authorization'], 'Bearer tok2');
});

test('auth.startPairing registers anonymously, then creates an app pairing with the pending credential', async () => {
  const scopes = ['pingroom:rooms:read', 'pingroom:broadcast:send'];
  const { calls, fetchMock } = recorder({
    'POST /api/agent/auth': () => ({
      status: 201,
      body: {
        credential: 'pending_token',
        credential_type: 'preclaim',
        expires_in: 900,
        scopes,
      },
    }),
    'POST /api/agent/auth/pair/start': () => ({
      status: 201,
      body: {
        pair_token: 'pair_123',
        pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
        expires_in: 900,
        poll_interval_ms: 1500,
      },
    }),
  });
  const pr = new PingRoom({ fetch: fetchMock });

  const pairing = await pr.auth.startPairing({ agent_label: 'Deploy bot', scopes });

  assert.equal(pairing.pair_token, 'pair_123');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    type: 'anonymous',
    scopes,
    agent_label: 'Deploy bot',
  });
  assert.equal(calls[0].init.headers['Authorization'], undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body), { scopes });
  assert.equal(calls[1].init.headers['Authorization'], 'Bearer pending_token');
});

test('auth.startPairing restores an existing credential when pair creation fails', async () => {
  const { fetchMock } = recorder({
    'POST /api/agent/auth': () => ({
      status: 201,
      body: {
        credential: 'pending_token',
        credential_type: 'pre_claim',
        expires_in: 900,
        scopes: ['pingroom:rooms:read'],
      },
    }),
    'POST /api/agent/auth/pair/start': () => ({
      status: 503,
      body: { code: 'temporarily_unavailable', message: 'Try again.' },
    }),
  });
  const pr = new PingRoom({ token: 'existing_active', fetch: fetchMock });

  await assert.rejects(
    () => pr.auth.startPairing({ scopes: ['pingroom:rooms:read'] }),
    (e) => e instanceof PingRoomError && e.status === 503,
  );
  assert.equal(pr.getToken(), 'existing_active');
});

test('auth.startPairing defaults to room-read, broadcast, and Agent Inbox/Handoff scopes', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/auth': () => ({
      status: 201,
      body: {
        credential: 'pending_token',
        credential_type: 'pre_claim',
        expires_in: 900,
        scopes: [],
      },
    }),
    'POST /api/agent/auth/pair/start': () => ({
      status: 201,
      body: {
        pair_token: 'pair_123',
        pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
        expires_in: 900,
        poll_interval_ms: 1500,
      },
    }),
  });
  const pr = new PingRoom({ fetch: fetchMock });

  await pr.auth.startPairing();

  const expected = ['pingroom:rooms:read', 'pingroom:broadcast:send', 'pingroom:handoffs:create'];
  assert.deepEqual(JSON.parse(calls[0].init.body).scopes, expected);
  assert.deepEqual(JSON.parse(calls[1].init.body).scopes, expected);
});

test('auth.waitForPairing adopts the approved credential and selected room', async () => {
  let statusCalls = 0;
  const { calls, fetchMock } = recorder({
    'POST /api/agent/auth': () => ({
      status: 201,
      body: {
        credential: 'pending_token',
        credential_type: 'preclaim',
        expires_in: 900,
        scopes: ['pingroom:rooms:read'],
      },
    }),
    'POST /api/agent/auth/pair/start': () => ({
      status: 201,
      body: {
        pair_token: 'pair_123',
        pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
        expires_in: 10,
        poll_interval_ms: 1000,
      },
    }),
    'GET /api/agent/auth/pair/status': () => {
      statusCalls += 1;
      if (statusCalls === 1) return { body: { status: 'pending' } };
      return {
        body: {
          status: 'active',
          credential: 'active_token',
          credential_type: 'active',
          expires_in: 0,
          scopes: ['pingroom:rooms:read'],
          handle: 'agt_deploy',
          room: { invite_code: 'AB12CD', name: 'Deployments' },
        },
      };
    },
    'GET /api/agent/rooms': () => ({ body: [] }),
  });
  const pr = new PingRoom({ fetch: fetchMock });
  const pairing = await pr.auth.startPairing({ scopes: ['pingroom:rooms:read'] });

  const active = await pr.auth.waitForPairing(pairing);
  await pr.rooms.list();

  assert.equal(active.credential, 'active_token');
  assert.equal(active.room.invite_code, 'AB12CD');
  assert.equal(pr.getToken(), 'active_token');
  assert.equal(calls.at(-1).init.headers['Authorization'], 'Bearer active_token');
});

test('auth.waitForPairing adopts an all-rooms grant that pins no delivery room', async () => {
  // `room_access: "all"` is the MOST permissive answer the human can give, and
  // the server sends `room: null` for it because no single destination was
  // pinned. Treating that as a broken response threw away a working credential.
  const { calls, fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: 'active_token',
        credential_type: 'active',
        expires_in: 0,
        scopes: ['pingroom:rooms:read'],
        handle: 'agt_deploy',
        account: { name: 'Ada' },
        room: null,
        room_access: 'all',
        rooms: [],
      },
    }),
    'GET /api/agent/rooms': () => ({ body: [] }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  const active = await pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 10,
    poll_interval_ms: 1000,
  });
  await pr.rooms.list();

  assert.equal(active.credential, 'active_token');
  assert.equal(active.room, null);
  assert.equal(active.room_access, 'all');
  assert.deepEqual(active.rooms, []);
  assert.equal(active.handle, 'agt_deploy');
  assert.equal(active.status, undefined);
  // setToken ran: the credential is adopted, not merely returned.
  assert.equal(pr.getToken(), 'active_token');
  assert.equal(calls.at(-1).init.headers['Authorization'], 'Bearer active_token');
});

test('auth.waitForPairing accepts an omitted room and carries the selected grant', async () => {
  const { fetchMock } = recorder({
    // `room` absent entirely, not just null.
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: 'active_token',
        credential_type: 'active',
        expires_in: null,
        scopes: ['pingroom:rooms:read'],
      },
    }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  const active = await pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 10,
    poll_interval_ms: 1000,
  });

  assert.equal(active.room, undefined);
  assert.equal(pr.getToken(), 'active_token');
});

test('auth.waitForPairing still rejects a room that is present but malformed', async () => {
  for (const room of [{ name: 'Deployments' }, { invite_code: '   ' }, { invite_code: 7 }]) {
    const { fetchMock } = recorder({
      'GET /api/agent/auth/pair/status': () => ({
        body: {
          status: 'active',
          credential: 'active_token',
          credential_type: 'active',
          expires_in: 0,
          scopes: ['pingroom:rooms:read'],
          room,
        },
      }),
    });
    const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

    await assert.rejects(
      () => pr.auth.waitForPairing({
        pair_token: 'pair_123',
        pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
        expires_in: 10,
        poll_interval_ms: 1000,
      }),
      (e) => e instanceof PingRoomError && e.code === 'pairing_invalid_response',
    );
    assert.equal(pr.getToken(), 'pending_token');
  }
});

test('auth.waitForPairing reports an expired app link without changing the token', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({ body: { status: 'expired' } }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  await assert.rejects(
    () => pr.auth.waitForPairing({
      pair_token: 'pair_123',
      pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
      expires_in: 10,
      poll_interval_ms: 1000,
    }),
    (e) => e instanceof PingRoomError && e.code === 'pairing_expired',
  );
  assert.equal(pr.getToken(), 'pending_token');
});

test('auth.waitForPairing rejects an incomplete active response without adopting it', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: '',
        credential_type: 'active',
        expires_in: null,
        scopes: ['pingroom:rooms:read'],
        room: null,
      },
    }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  await assert.rejects(
    () => pr.auth.waitForPairing({
      pair_token: 'pair_123',
      pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
      expires_in: 10,
      poll_interval_ms: 1000,
    }),
    (e) => e instanceof PingRoomError && e.code === 'pairing_invalid_response',
  );
  assert.equal(pr.getToken(), 'pending_token');
});

test('auth.waitForPairing rejects invalid active credential metadata', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: 'preclaim_token',
        credential_type: 'pre_claim',
        expires_in: 'never',
        scopes: 'pingroom:rooms:read',
        room: { invite_code: 'AB12CD', name: 'Deployments' },
      },
    }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  await assert.rejects(
    () => pr.auth.waitForPairing({
      pair_token: 'pair_123',
      pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
      expires_in: 10,
      poll_interval_ms: 1000,
    }),
    (e) => e instanceof PingRoomError && e.code === 'pairing_invalid_response',
  );
  assert.equal(pr.getToken(), 'pending_token');
});

test('auth.waitForPairing does not adopt a credential after cancellation during a status poll', async () => {
  let releaseStatus;
  const statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const fetchMock = async (url) => {
    if (new URL(url).pathname !== '/api/agent/auth/pair/status') {
      return new Response('{}', { status: 404 });
    }
    await statusGate;
    return new Response(JSON.stringify({
      status: 'active',
      credential: 'active_token',
      credential_type: 'active',
      expires_in: null,
      scopes: ['pingroom:rooms:read'],
      room: { invite_code: 'AB12CD', name: 'Deployments' },
    }));
  };
  const controller = new AbortController();
  const cancelled = new Error('pairing cancelled');
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });
  const waiting = pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 10,
    poll_interval_ms: 1000,
  }, { signal: controller.signal });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(cancelled);
  releaseStatus();

  await assert.rejects(waiting, (e) => e === cancelled);
  assert.equal(pr.getToken(), 'pending_token');
});

test('auth.waitForPairing retries a timed-out status poll', async () => {
  let statusCalls = 0;
  const fetchMock = async (url) => {
    if (new URL(url).pathname !== '/api/agent/auth/pair/status') {
      return new Response('{}', { status: 404 });
    }
    statusCalls += 1;
    if (statusCalls === 1) {
      throw new PingRoomTimeoutError();
    }
    return new Response(JSON.stringify({
      status: 'active',
      credential: 'active_token',
      credential_type: 'active',
      expires_in: null,
      scopes: ['pingroom:rooms:read'],
      room: { invite_code: 'AB12CD', name: 'Deployments' },
    }));
  };
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  const active = await pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 3,
    poll_interval_ms: 1000,
  });

  assert.equal(statusCalls, 2);
  assert.equal(active.credential, 'active_token');
  assert.equal(pr.getToken(), 'active_token');
});

test('a call needing auth without a token throws no_token before fetching', async () => {
  let fetched = false;
  const pr = new PingRoom({ fetch: async () => ((fetched = true), new Response('{}')) });
  await assert.rejects(
    () => pr.rooms.list(),
    (e) => e instanceof PingRoomError && e.code === 'no_token',
  );
  assert.equal(fetched, false);
});

test('questions.ask posts the prompt/options to the room questions path', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/ab12/questions': () => ({
      status: 201,
      body: { id: 'q1', kind: 'question', prompt: 'Deploy?', state: 'pending', options: [], answer: null },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const q = await pr.questions.ask('ab12', {
    prompt: 'Deploy?',
    options: ['ship', 'hold'],
    responder_scope: 'room',
    ttl: 600,
    correlation_id: 'd-1',
    attachment_ids: ['att_1', 'att_2', 'att_3', 'att_4'],
  });
  assert.equal(q.id, 'q1');
  assert.equal(q.state, 'pending');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    prompt: 'Deploy?',
    options: ['ship', 'hold'],
    responder_scope: 'room',
    ttl: 600,
    correlation_id: 'd-1',
    attachment_ids: ['att_1', 'att_2', 'att_3', 'att_4'],
  });
});

test('questions.list unwraps { questions } and sends the state filter', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/questions': () => ({ body: { questions: [{ id: 'q1', kind: 'question', state: 'answered' }] } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const list = await pr.questions.list({ state: 'answered' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'q1');
  assert.match(calls[0].url, /state=answered/);
});

test('questions.waitForAnswer loops until the state leaves pending', async () => {
  let n = 0;
  const fetchMock = async (url) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/api/agent/questions/q1/wait');
    n++;
    const body = n < 2
      ? { id: 'q1', kind: 'question', state: 'pending', answer: null }
      : { id: 'q1', kind: 'question', state: 'answered', answer: { value: 'ship', label: 'Ship' } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const resolved = await pr.questions.waitForAnswer('q1');
  assert.equal(resolved.state, 'answered');
  assert.equal(resolved.answer.value, 'ship');
  assert.equal(n, 2);
});

test('questions.cancel POSTs to the cancel path', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/questions/q1/cancel': () => ({ body: { id: 'q1', kind: 'question', state: 'cancelled' } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const q = await pr.questions.cancel('q1');
  assert.equal(q.state, 'cancelled');
  assert.equal(calls[0].init.method, 'POST');
});

test('inbox.ensure resolves the designated delivery room with an empty POST', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/inbox/ensure': () => ({
      status: 201,
      body: {
        onboarded: true,
        replayed: false,
        room: { id: 'r-project', name: 'Project X', invite_code: 'PROJECT1', is_agent_inbox: false },
        question: { id: 'q-onboard', kind: 'question', state: 'pending', options: [] },
      },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const result = await pr.inbox.ensure();
  assert.equal(result.room.is_agent_inbox, false);
  assert.equal(result.question.id, 'q-onboard');
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
});

function inboxEnsureBody(id = 'q-onboard') {
  return {
    onboarded: true,
    replayed: false,
    room: { id: 'r1', name: 'Project X', invite_code: 'PROJECT1', is_agent_inbox: false },
    question: {
      id,
      kind: 'question',
      prompt: 'PingRoom connected. Can you answer this?',
      state: 'pending',
      options: [{ value: 'yes', label: 'Yes' }],
      expires_at: '2026-08-10T00:00:00Z',
      created_at: '2026-08-09T00:00:00Z',
    },
  };
}

function answeredActivation(overrides = {}) {
  return {
    id: 'q-onboard',
    kind: 'question',
    prompt: 'PingRoom connected. Can you answer this?',
    state: 'answered',
    answer: {
      value: 'yes',
      label: 'Yes',
      text: null,
      responder: { id: 'u1', display_name: 'Mahdi' },
      answered_at: '2026-08-09T00:01:00Z',
    },
    activation_completed: true,
    ...overrides,
  };
}

test('inbox.activate throttles pending observations before confirmed success', async () => {
  let waits = 0;
  const waitStartedAt = [];
  const { calls, fetchMock } = recorder({
    'POST /api/agent/inbox/ensure': () => ({
      status: 201,
      body: inboxEnsureBody(),
    }),
    'GET /api/agent/handoffs/q-onboard/wait': () => {
      waits += 1;
      waitStartedAt.push(Date.now());
      if (waits === 1) {
        return { body: { id: 'q-onboard', kind: 'question', state: 'pending', answer: null, activation_completed: false } };
      }
      return { body: answeredActivation() };
    },
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  const activated = await pr.inbox.activate({ timeout: 3, overallTimeoutMs: 8_000 });

  assert.equal(activated.activation_completed, true);
  assert.equal(activated.room.invite_code, 'PROJECT1');
  assert.equal(activated.question.state, 'answered');
  assert.equal(activated.question.activation_completed, true);
  assert.equal(activated.question.answer.value, 'yes');
  assert.equal(waits, 2);
  for (let i = 1; i < waitStartedAt.length; i += 1) {
    assert.ok(waitStartedAt[i] - waitStartedAt[i - 1] >= 2_080, 'polls must stay below 30 requests/minute');
  }
  assert.equal(calls[0].init.method, 'POST');
  for (const call of calls.slice(1)) assert.equal(new URL(call.url).searchParams.get('timeout'), '3');
});

test('inbox.activate rejects answered results whose activation stamp is false or missing', async () => {
  for (const activationCompleted of [false, undefined]) {
    const terminal = answeredActivation();
    if (activationCompleted === undefined) delete terminal.activation_completed;
    else terminal.activation_completed = activationCompleted;

    let waits = 0;
    const { fetchMock } = recorder({
      'POST /api/agent/inbox/ensure': () => ({ body: inboxEnsureBody() }),
      'GET /api/agent/handoffs/q-onboard/wait': () => {
        waits += 1;
        return { body: terminal };
      },
    });
    const pr = new PingRoom({ token: 'active-token', fetch: fetchMock });
    await assert.rejects(
      () => pr.inbox.activate({ overallTimeoutMs: 100 }),
      (error) => error instanceof PingRoomActivationIncompleteError
        && error.reason === 'answered_without_completion'
        && error.code === 'inbox_activation_incomplete',
    );
    assert.equal(pr.getToken(), 'active-token');
    assert.equal(waits, 1, 'a terminal unverified sequence must not be polled as if history can change');
  }
});

test('inbox.activate maps expired onboarding to an activation-incomplete domain error', async () => {
  const { fetchMock } = recorder({
    'POST /api/agent/inbox/ensure': () => ({ body: inboxEnsureBody('q-expired') }),
    'GET /api/agent/handoffs/q-expired/wait': () => ({
      body: {
        id: 'q-expired', kind: 'question', state: 'expired', answer: null, activation_completed: false,
      },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await assert.rejects(
    () => pr.inbox.activate({ overallTimeoutMs: 500 }),
    (error) => error instanceof PingRoomActivationIncompleteError && error.reason === 'expired',
  );
});

test('inbox.activate cancellation interrupts the handoff wait', async () => {
  const controller = new AbortController();
  const cancelled = new Error('activation cancelled');
  const fetchMock = async (url, init) => {
    if (new URL(url).pathname === '/api/agent/inbox/ensure') {
      return new Response(JSON.stringify(inboxEnsureBody()));
    }
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const activation = pr.inbox.activate({ signal: controller.signal, timeout: 1, overallTimeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(cancelled);
  await assert.rejects(activation, (error) => error === cancelled);
});

test('inbox.activate enforces its overridable overall deadline without changing the credential', async () => {
  const fetchMock = async (url, init) => {
    if (new URL(url).pathname === '/api/agent/inbox/ensure') {
      return new Response(JSON.stringify(inboxEnsureBody()));
    }
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const pr = new PingRoom({ token: 'active-token', fetch: fetchMock });
  await assert.rejects(
    () => pr.inbox.activate({ overallTimeoutMs: 20 }),
    (error) => error instanceof PingRoomActivationIncompleteError && error.reason === 'deadline_exceeded',
  );
  assert.equal(pr.getToken(), 'active-token');
});

test('inbox.activate overall deadline includes the ensure request', async () => {
  let requestedPath = null;
  const pr = new PingRoom({
    token: 'active-token',
    fetch: async (url, init) => {
      requestedPath = new URL(url).pathname;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  });

  await assert.rejects(
    () => pr.inbox.activate({ overallTimeoutMs: 20 }),
    (error) => error instanceof PingRoomActivationIncompleteError && error.reason === 'deadline_exceeded',
  );
  assert.equal(requestedPath, '/api/agent/inbox/ensure');
  assert.equal(pr.getToken(), 'active-token');
});

test('inbox.activate rejects invalid overall deadlines before fetching', async () => {
  let fetched = false;
  const pr = new PingRoom({ token: 't', fetch: async () => ((fetched = true), new Response('{}')) });
  for (const overallTimeoutMs of [-1, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => pr.inbox.activate({ overallTimeoutMs }),
      (error) => error instanceof PingRoomError && error.code === 'invalid_request',
    );
  }
  assert.equal(fetched, false);
});

test('inbox.activate validates ensure correlation and terminal answer envelopes', async () => {
  const baseEnsure = inboxEnsureBody();
  const invalidEnsure = new PingRoom({
    token: 't',
    fetch: async () => new Response(JSON.stringify({
      ...baseEnsure,
      question: { ...baseEnsure.question, id: '' },
    })),
  });
  await assert.rejects(
    () => invalidEnsure.inbox.activate({ overallTimeoutMs: 500 }),
    (error) => error instanceof PingRoomError && error.code === 'inbox_invalid_response',
  );

  for (const terminal of [
    answeredActivation({ id: 'different-id' }),
    answeredActivation({ kind: 'ack' }),
    answeredActivation({ answer: { value: 'yes' } }),
  ]) {
    const { fetchMock } = recorder({
      'POST /api/agent/inbox/ensure': () => ({ body: inboxEnsureBody() }),
      'GET /api/agent/handoffs/q-onboard/wait': () => ({ body: terminal }),
    });
    const pr = new PingRoom({ token: 't', fetch: fetchMock });
    await assert.rejects(
      () => pr.inbox.activate({ overallTimeoutMs: 500 }),
      (error) => error instanceof PingRoomError && error.code === 'inbox_invalid_response',
    );
  }
});

test('inbox.activate propagates ensure and wait API errors', async () => {
  const ensureFailure = new PingRoom({
    token: 't',
    fetch: async () => new Response(JSON.stringify({ code: 'no_room_configured', message: 'Choose a room.' }), { status: 409 }),
  });
  await assert.rejects(
    () => ensureFailure.inbox.activate(),
    (error) => error instanceof PingRoomError && error.code === 'no_room_configured' && error.status === 409,
  );

  const { fetchMock } = recorder({
    'POST /api/agent/inbox/ensure': () => ({
      body: inboxEnsureBody(),
    }),
    'GET /api/agent/handoffs/q-onboard/wait': () => ({
      status: 503,
      body: { code: 'temporarily_unavailable', message: 'Try again.' },
    }),
  });
  const waitFailure = new PingRoom({ token: 't', fetch: fetchMock });
  await assert.rejects(
    () => waitFailure.inbox.activate({ timeout: 2, overallTimeoutMs: 500 }),
    (error) => error instanceof PingRoomError && error.code === 'temporarily_unavailable' && error.status === 503,
  );
});

test('handoffs.requestAck posts a direct ack handoff with the Idempotency-Key header', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/handoffs': () => ({
      status: 201,
      body: { id: 'h1', kind: 'ack', prompt: 'Ack me', state: 'open', delivery_state: 'enqueued' },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const h = await pr.handoffs.requestAck({
    prompt: 'Ack me',
    expiresIn: 600,
    correlationId: 'deploy-1',
    data: { commit: 'abc' },
    idempotencyKey: 'idem-1',
  });
  assert.equal(h.id, 'h1');
  assert.equal(h.kind, 'ack');
  assert.equal(h.delivery_state, 'enqueued');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'idem-1');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    kind: 'ack',
    prompt: 'Ack me',
    audience: { type: 'direct', user_id: 'me' },
    expires_in: 600,
    correlation_id: 'deploy-1',
    data: { commit: 'abc' },
  });
});

test('handoffs.requestAck sends no Idempotency-Key when omitted and honors an explicit target', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h2', kind: 'ack', state: 'open' } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.handoffs.requestAck({ prompt: 'hi', target: 'user-uuid-9' });
  assert.equal(calls[0].init.headers['Idempotency-Key'], undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body).audience, { type: 'direct', user_id: 'user-uuid-9' });
});

test('handoffs.requestAck preserves a failed delivery state from the API', async () => {
  const { fetchMock } = recorder({
    'POST /api/agent/handoffs': () => ({
      status: 201,
      body: { id: 'h-failed', kind: 'ack', prompt: 'Ack me', state: 'open', delivery_state: 'failed' },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const handoff = await pr.handoffs.requestAck({ prompt: 'Ack me' });
  assert.equal(handoff.delivery_state, 'failed');
});

test('handoffs.ask normalizes bare-string options to {value,label}', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/handoffs': () => ({
      status: 201,
      body: { id: 'h3', kind: 'question', prompt: 'Ship?', state: 'pending', options: [] },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const h = await pr.handoffs.ask({ prompt: 'Ship?', options: ['deploy', { value: 'hold', style: 'danger' }] });
  assert.equal(h.kind, 'question');
  assert.deepEqual(JSON.parse(calls[0].init.body).options, [
    { value: 'deploy', label: 'deploy' },
    { value: 'hold', style: 'danger' },
  ]);
});

test('handoffs.ask requires at least 2 options before fetching', () => {
  let fetched = false;
  const pr = new PingRoom({ token: 't', fetch: async () => ((fetched = true), new Response('{}')) });
  assert.throws(
    () => pr.handoffs.ask({ prompt: 'x', options: ['only-one'] }),
    (e) => e instanceof PingRoomError && e.code === 'invalid_request',
  );
  assert.equal(fetched, false);
});

test('handoffs.ask rejects more than 4 options before fetching', () => {
  let fetched = false;
  const pr = new PingRoom({ token: 't', fetch: async () => ((fetched = true), new Response('{}')) });
  assert.throws(
    () => pr.handoffs.ask({ prompt: 'x', options: ['one', 'two', 'three', 'four', 'five'] }),
    (e) => e instanceof PingRoomError && e.code === 'invalid_request' && /between 2 and 4/.test(e.message),
  );
  assert.equal(fetched, false);
});

test('handoffs.waitForResult loops until a terminal state, returning a negative answer as success', async () => {
  let n = 0;
  const fetchMock = async (url) => {
    const u = new URL(url);
    assert.equal(u.pathname, '/api/agent/handoffs/h4/wait');
    n++;
    const body = n < 2
      ? { id: 'h4', kind: 'question', state: 'pending', answer: null }
      : { id: 'h4', kind: 'question', state: 'answered', answer: { value: 'hold', label: 'Hold' } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const resolved = await pr.handoffs.waitForResult('h4', { timeout: 5 });
  assert.equal(resolved.state, 'answered');
  assert.equal(resolved.answer.value, 'hold');
  assert.equal(n, 2);
});

test('handoffs.list unwraps { handoffs } and sends the recent-history state filter', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/handoffs': () => ({ body: { handoffs: [{ id: 'h5', kind: 'ack', state: 'open' }] } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const list = await pr.handoffs.list({ state: 'all' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'h5');
  assert.match(calls[0].url, /state=all/);
});

test('handoffs surfaces a 409 idempotency_conflict as a typed PingRoomError', async () => {
  const fetchMock = async () =>
    new Response(JSON.stringify({ code: 'idempotency_conflict', message: 'reused key' }), { status: 409 });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await assert.rejects(
    () => pr.handoffs.requestAck({ prompt: 'hi', idempotencyKey: 'dup' }),
    (e) => e instanceof PingRoomError && e.code === 'idempotency_conflict' && e.status === 409,
  );
});

// The exported unions are a promise about the server's `code` vocabulary, so
// they are pinned here exactly. Each entry below was verified against a live
// emitter in the API source; a code with no emitter is worse than an untyped
// one, because it invites callers to write a branch that can never run.
test('the handoff error codes match the codes the handoff endpoints emit', () => {
  assert.deepEqual([...HANDOFF_ERROR_CODES], [
    'feature_temporarily_unavailable', // AgentHandoffController::store
    'handoff_room_unsupported', //        AgentHandoffController::store
    'invalid_target', //                  shared send-guard vocabulary
    'no_room_configured', //              AgentHandoffController::store
    'target_not_permitted', //            AgentHandoffController::resolveTarget
    'recipient_not_ready', //             RecipientNotReadyException renderer
    'idempotency_conflict', //            HandoffService / RequestIdempotency
    'invalid_idempotency_key', //         RequestIdempotency
    'capability_check_unavailable', //    CapabilityCheckUnavailableException renderer
    'insufficient_scope', //              agent.scope middleware
    'free_limit_reached', //              agent.quota middleware
  ]);

  // These four had ZERO emitters anywhere in the API and were removed.
  for (const dead of ['target_not_found', 'target_unavailable', 'pings_closed', 'not_room_member']) {
    assert.equal(HANDOFF_ERROR_CODES.includes(dead), false, `${dead} has no server emitter`);
  }

  // `room_not_granted` comes from the `agent.room` gate, and POST /handoffs is
  // not behind it — it belongs to the room-scoped union instead.
  assert.equal(HANDOFF_ERROR_CODES.includes('room_not_granted'), false);
});

test('the room-scoped and inbox error codes match their server emitters', () => {
  assert.deepEqual([...ROOM_SCOPED_ERROR_CODES], ['room_not_granted']);

  assert.deepEqual([...AGENT_INBOX_ERROR_CODES], [
    'activation_evidence_unavailable', // AgentInboxController::activate
    'no_room_configured', //              AgentInboxController::activate
    'activation_room_muted', //           AgentInboxController::activate
    'activation_delivery_unavailable', // AgentInboxController
    'feature_temporarily_unavailable', // AgentInboxController
  ]);

  // No union may carry a duplicate or a non-snake_case code.
  for (const codes of [HANDOFF_ERROR_CODES, ROOM_SCOPED_ERROR_CODES, AGENT_INBOX_ERROR_CODES]) {
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^[a-z][a-z0-9_]*$/);
  }
});

test('a room-scoped 403 room_not_granted propagates instead of reading as "no stream"', async () => {
  const fetchMock = async () =>
    new Response(
      JSON.stringify({ code: 'room_not_granted', message: 'not granted' }),
      { status: 403 },
    );
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  // liveStatus.get() swallows a 404 only. A permission failure must never be
  // reported as an absent stream, or a producer would open a duplicate.
  await assert.rejects(
    () => pr.live.get('AB12CD', 'corr-1'),
    (e) => e instanceof PingRoomError && e.code === 'room_not_granted' && e.status === 403,
  );
});

test('live.get still resolves null for a genuinely absent stream', async () => {
  const fetchMock = async () => new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  assert.equal(await pr.live.get('AB12CD', 'corr-1'), null);
});

test('mcp.callTool initializes once, notifies the server, and sends the negotiated protocol header', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/mcp': ({ init }) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return {
          body: {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'pingroom', version: '1.0.0' },
            },
          },
        };
      }
      if (body.method === 'notifications/initialized') {
        return { status: 202 };
      }
      if (body.method === 'tools/list') {
        return { body: { jsonrpc: '2.0', id: body.id, result: { tools: [] } } };
      }
      return {
        body: {
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: '{}' }] },
        },
      };
    },
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const r = await pr.mcp.callTool('list_rooms', { limit: 5 });
  await pr.mcp.listTools();

  assert.equal(r.content[0].type, 'text');
  assert.deepEqual(calls.map(({ init }) => JSON.parse(init.body).method), [
    'initialize',
    'notifications/initialized',
    'tools/call',
    'tools/list',
  ]);
  const toolCall = JSON.parse(calls[2].init.body);
  assert.equal(toolCall.jsonrpc, '2.0');
  assert.deepEqual(toolCall.params, { name: 'list_rooms', arguments: { limit: 5 } });
  assert.equal(calls[0].init.headers['MCP-Protocol-Version'], undefined);
  assert.equal(calls[1].init.headers['MCP-Protocol-Version'], '2025-06-18');
  assert.equal(calls[2].init.headers['MCP-Protocol-Version'], '2025-06-18');
});

test('attachments.upload posts multipart and lets the runtime own the boundary', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/attachments': () => ({
      status: 201,
      body: {
        attachment: {
          id: 'att_1',
          filename: 'brief.pdf',
          mime_type: 'application/pdf',
          size_bytes: 5,
          created_at: '2026-08-10T08:00:00Z',
        },
      },
    }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  const attachment = await pr.attachments.upload({
    content: new Uint8Array([37, 80, 68, 70, 45]),
    filename: 'brief.pdf',
    contentType: 'application/pdf',
  });

  assert.equal(attachment.id, 'att_1');
  const { init } = calls[0];
  assert.ok(init.body instanceof FormData, 'body should be FormData');
  // Setting Content-Type ourselves would strip the generated boundary.
  assert.equal(init.headers['Content-Type'], undefined);
  assert.equal(init.headers['Authorization'], 'Bearer tok_abc');

  const part = init.body.get('file');
  assert.equal(part.name, 'brief.pdf');
  assert.equal(part.type, 'application/pdf');
  assert.equal(await part.text(), '%PDF-');
});

test('attachments.manifest returns a zip listing and null for a non-archive', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/attachments/att_zip/manifest': () => ({
      status: 200,
      body: {
        manifest: {
          entries: [
            { name: 'src', size_bytes: null, is_directory: true },
            { name: 'src/index.js', size_bytes: 300, is_directory: false },
          ],
          total_entries: 2,
          truncated: false,
          total_uncompressed_bytes: 300,
        },
      },
    }),
    'GET /api/agent/attachments/att_pdf/manifest': () => ({
      status: 200,
      body: { manifest: null },
    }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  const manifest = await pr.attachments.manifest('att_zip');
  assert.equal(manifest.total_entries, 2);
  assert.equal(manifest.entries[1].name, 'src/index.js');
  assert.equal(manifest.entries[0].size_bytes, null);

  assert.equal(await pr.attachments.manifest('att_pdf'), null);
  assert.equal(calls.length, 2);
});

test('up to four attachment ids ride the ping body while the bytes do not', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/AB12/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  await pr.broadcast('AB12', {
    message: 'report attached',
    attachment_ids: ['att_1', 'att_2', 'att_3', 'att_4'],
  });

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.attachment_ids, ['att_1', 'att_2', 'att_3', 'att_4']);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('attachments.content returns raw bytes but still throws on a refusal', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/attachments/att_1/content': () => ({
      body: undefined,
      headers: { 'Content-Type': 'application/pdf' },
    }),
    'GET /api/agent/attachments/att_gone/content': () => ({ status: 404, body: { message: 'Not found' } }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  const res = await pr.attachments.content('att_1');
  assert.equal(res.headers.get('Content-Type'), 'application/pdf');

  await assert.rejects(
    () => pr.attachments.content('att_gone'),
    (err) => err instanceof PingRoomError && err.status === 404,
  );
});

test('a 402 upload surfaces the Pro gate rather than a generic failure', async () => {
  const { fetchMock } = recorder({
    'POST /api/agent/attachments': () => ({
      status: 402,
      body: { error: 'pro_required', code: 'pro_required', message: 'Ping attachments are a Pro feature.' },
    }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  await assert.rejects(
    () => pr.attachments.upload({ content: 'notes', filename: 'notes.txt' }),
    (err) => err instanceof PingRoomError && err.status === 402 && err.code === 'pro_required',
  );
});
