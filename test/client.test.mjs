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

test('broadcast posts the ping body to the right path', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/ab12/notifications': () => ({
      status: 201,
      body: { id: 'n1', message: 'hi', created_at: 'now', action_number: null, action_icon: null, trigger_source: null },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const res = await pr.broadcast('ab12', { message: 'hi', data: { commit: 'abc' }, correlation_id: 'c1' });
  assert.equal(res.id, 'n1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { message: 'hi', data: { commit: 'abc' }, correlation_id: 'c1' });
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
