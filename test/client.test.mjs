import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError } from '../dist/index.js';

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
  });
  assert.equal(q.id, 'q1');
  assert.equal(q.state, 'pending');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    prompt: 'Deploy?',
    options: ['ship', 'hold'],
    responder_scope: 'room',
    ttl: 600,
    correlation_id: 'd-1',
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

test('handoffs.list unwraps { handoffs } and sends the state filter', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/handoffs': () => ({ body: { handoffs: [{ id: 'h5', kind: 'ack', state: 'open' }] } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const list = await pr.handoffs.list({ state: 'open' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'h5');
  assert.match(calls[0].url, /state=open/);
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

test('mcp.callTool builds a JSON-RPC 2.0 envelope', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/mcp': () => ({ body: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const r = await pr.mcp.callTool('list_rooms', { limit: 5 });
  assert.equal(r.content[0].type, 'text');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.method, 'tools/call');
  assert.deepEqual(body.params, { name: 'list_rooms', arguments: { limit: 5 } });
});
