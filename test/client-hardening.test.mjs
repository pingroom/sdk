import test from 'node:test';
import assert from 'node:assert/strict';
import { format, inspect } from 'node:util';
import { HttpClient } from '../dist/http.js';
import { PingRoom, PingRoomError, sendIncomingWebhook } from '../dist/index.js';

const TOKEN = 'agt_live_fixture_credential_5f2c9e';

function recording(respond = () => ({ body: {} })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const { status = 200, body, headers } = respond(calls.at(-1), calls.length);
    return new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return { calls, fetchImpl };
}

// --- SDK-05: the credential never reaches serialised or inspected output ----

test('the bearer token is absent from JSON.stringify and util.inspect of the client and its namespaces', () => {
  const pr = new PingRoom({ token: TOKEN, baseUrl: 'https://api.pingroom.io', fetch: async () => new Response('{}') });
  const renderings = [
    JSON.stringify(pr),
    JSON.stringify(pr.rooms),
    JSON.stringify({ context: { client: pr, approvals: pr.approvals, mcp: pr.mcp } }),
    inspect(pr, { depth: Infinity, showHidden: true }),
    inspect(pr.rooms, { depth: Infinity, showHidden: true }),
    inspect(pr.mcp, { depth: Infinity, showHidden: true }),
    format('%o %O %j', pr, pr.handoffs, pr.notifications),
  ];
  for (const rendering of renderings) {
    assert.ok(!rendering.includes(TOKEN), `token leaked: ${rendering.slice(0, 200)}`);
  }
  assert.match(JSON.stringify(pr), /\[redacted\]/);
  assert.match(inspect(pr), /PingRoom \{ baseUrl: "https:\/\/api\.pingroom\.io", token: \[redacted\] \}/);
  assert.equal(pr.getToken(), TOKEN, 'the credential stays readable through the explicit accessor');
});

test('a client without a token says so without inventing one', () => {
  const pr = new PingRoom({ baseUrl: 'https://api.pingroom.io', fetch: async () => new Response('{}') });
  assert.deepEqual(JSON.parse(JSON.stringify(pr)), { baseUrl: 'https://api.pingroom.io', token: null });
});

test('the token is still sent as the Authorization header', async () => {
  const { calls, fetchImpl } = recording(() => ({ body: [] }));
  await new PingRoom({ token: TOKEN, fetch: fetchImpl }).rooms.list();
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

// --- SDK-06: idempotency keys on broadcast, trigger and approvals.request ---

const idempotentSends = [
  {
    name: 'broadcast',
    path: '/api/agent/rooms/AB12/notifications',
    send: (pr, key) => pr.broadcast('AB12', { message: 'Deploy shipped', ...key }),
    body: { message: 'Deploy shipped' },
  },
  {
    name: 'actions.trigger',
    path: '/api/agent/rooms/AB12/actions/2/trigger',
    send: (pr, key) => pr.actions.trigger('AB12', 2, { is_urgent: true, ...key }),
    body: { is_urgent: true },
  },
  {
    name: 'approvals.request',
    path: '/api/agent/rooms/AB12/approvals',
    send: (pr, key) => pr.approvals.request('AB12', { question: 'Ship it?', ...key }),
    body: { question: 'Ship it?' },
  },
];

for (const send of idempotentSends) {
  test(`${send.name} sends idempotencyKey as the Idempotency-Key header, never in the body`, async () => {
    const { calls, fetchImpl } = recording(() => ({ body: { id: 'x' } }));
    const pr = new PingRoom({ token: 't', fetch: fetchImpl });
    await send.send(pr, { idempotencyKey: 'deploy-1.4.0' });
    await send.send(pr, {});
    assert.equal(calls[0].url.pathname, send.path);
    assert.equal(calls[0].init.headers['Idempotency-Key'], 'deploy-1.4.0');
    assert.deepEqual(JSON.parse(calls[0].init.body), send.body);
    assert.equal('Idempotency-Key' in calls[1].init.headers, false);
    assert.deepEqual(JSON.parse(calls[1].init.body), send.body);
  });

  test(`${send.name} refuses an empty or over-long idempotencyKey before sending`, async () => {
    const { calls, fetchImpl } = recording();
    const pr = new PingRoom({ token: 't', fetch: fetchImpl });
    for (const idempotencyKey of ['', '   ', 'k'.repeat(256)]) {
      await assert.rejects(
        async () => send.send(pr, { idempotencyKey }),
        (error) => error instanceof PingRoomError && error.code === 'invalid_request' && /idempotencyKey/.test(error.message),
      );
    }
    await send.send(pr, { idempotencyKey: 'k'.repeat(255) });
    assert.equal(calls.length, 1);
  });

  test(`${send.name} refuses a key that cannot travel as a header as invalid_request, not network_error`, async () => {
    // fetch throws a TypeError on a character outside Latin-1, which used to
    // surface as a retryable network_error that every retry repeated.
    const { calls, fetchImpl } = recording();
    const pr = new PingRoom({ token: 't', fetch: fetchImpl });
    for (const idempotencyKey of ['deploy-✅', 'ключ', 'café', 'line\nbreak', 'tab\there', 'nul\u0000inside', 'del\u007f', 42]) {
      await assert.rejects(
        async () => send.send(pr, { idempotencyKey }),
        (error) => error instanceof PingRoomError && error.code === 'invalid_request' && /idempotencyKey/.test(error.message),
        JSON.stringify(idempotencyKey),
      );
    }
    assert.equal(calls.length, 0);
  });

  test(`${send.name} accepts interior spaces and trims the ends the way the server does`, async () => {
    const { calls, fetchImpl } = recording(() => ({ body: { id: 'x' } }));
    const pr = new PingRoom({ token: 't', fetch: fetchImpl });
    await send.send(pr, { idempotencyKey: 'deploy 1.4.0 abc123' });
    await send.send(pr, { idempotencyKey: ' \t deploy-2\n' });
    await send.send(pr, { idempotencyKey: ` ${'k'.repeat(255)} ` });
    assert.equal(calls[0].init.headers['Idempotency-Key'], 'deploy 1.4.0 abc123');
    assert.equal(calls[1].init.headers['Idempotency-Key'], 'deploy-2');
    assert.equal(calls[2].init.headers['Idempotency-Key'], 'k'.repeat(255));
    // Every printable ASCII character is accepted.
    const printable = Array.from({ length: 0x7f - 0x21 }, (_, i) => String.fromCharCode(0x21 + i)).join('');
    await send.send(pr, { idempotencyKey: `a ${printable}` });
    assert.equal(calls[3].init.headers['Idempotency-Key'], `a ${printable}`);
  });
}

test('handoff creates and incoming webhooks apply the same header-safe key rule', async () => {
  const { calls, fetchImpl } = recording(() => ({ body: { id: 'h1', kind: 'ack', state: 'open', success: true } }));
  const pr = new PingRoom({ token: 't', fetch: fetchImpl });
  const invalid = (error) => error instanceof PingRoomError && error.code === 'invalid_request' && /idempotencyKey/.test(error.message);
  for (const idempotencyKey of ['deploy-✅', 'k'.repeat(256), '   ']) {
    await assert.rejects(async () => pr.handoffs.requestAck({ prompt: 'Ship?', idempotencyKey }), invalid);
    await assert.rejects(async () => pr.handoffs.ask({ prompt: 'Ship?', options: ['a', 'b'], idempotencyKey }), invalid);
    await assert.rejects(
      sendIncomingWebhook('https://api.pingroom.invalid/api/webhook/s', { message: 'hi' }, { fetch: fetchImpl, idempotencyKey }),
      invalid,
    );
  }
  assert.equal(calls.length, 0);
  await pr.handoffs.requestAck({ prompt: 'Ship?', idempotencyKey: ' deploy 42 ' });
  await sendIncomingWebhook('https://api.pingroom.invalid/api/webhook/s', { message: 'hi' }, { fetch: fetchImpl, idempotencyKey: 'build 42' });
  // An empty key still means "no key" on these two, as before.
  await pr.handoffs.requestAck({ prompt: 'Ship?', idempotencyKey: '' });
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'deploy 42');
  assert.equal(calls[1].init.headers['Idempotency-Key'], 'build 42');
  assert.equal('Idempotency-Key' in calls[2].init.headers, false);
});

// --- SDK-08: dot segments and empty path parameters ------------------------

test('a path parameter of "", "." or ".." is refused instead of resolving to another route', async () => {
  const { calls, fetchImpl } = recording();
  const pr = new PingRoom({ token: 't', fetch: fetchImpl });
  const attempts = [
    () => pr.live.get('AB12', '..'),
    () => pr.approvals.get('..'),
    () => pr.approvals.waitForDecision('.'),
    () => pr.questions.cancel('.'),
    () => pr.questions.get('..'),
    () => pr.rooms.get(''),
    () => pr.actions.list('..'),
    () => pr.notifications.getNotification('..'),
    () => pr.directory.get('.'),
  ];
  for (const attempt of attempts) {
    await assert.rejects(async () => attempt(), (error) => error instanceof PingRoomError && error.code === 'invalid_request');
  }
  assert.equal(calls.length, 0);
  // Dots inside a segment are ordinary characters.
  await pr.approvals.get('..a');
  assert.equal(calls[0].url.pathname, '/api/agent/approvals/..a');
});

// --- SDK-10: absolute request paths and malformed MCP responses ------------

test('the HTTP client refuses an absolute URL so the token cannot go to another origin', async () => {
  const { calls, fetchImpl } = recording();
  const client = new HttpClient({ baseUrl: 'https://api.pingroom.io', token: TOKEN, fetch: fetchImpl });
  for (const path of ['https://elsewhere.invalid/collect', 'HTTP://elsewhere.invalid/', 'javascript:alert(1)']) {
    await assert.rejects(client.request('GET', path), (error) => error instanceof PingRoomError && error.code === 'invalid_request');
  }
  assert.equal(calls.length, 0);
  await client.request('GET', 'api/agent/rooms');
  assert.equal(calls[0].url.href, 'https://api.pingroom.io/api/agent/rooms');
});

test('mcp.call rejects a 2xx that carries neither result nor error', async () => {
  for (const body of [undefined, '<html>ok</html>', {}, [], { jsonrpc: '2.0', id: 1 }]) {
    const { fetchImpl } = recording(() => ({ body }));
    const pr = new PingRoom({ token: 't', fetch: fetchImpl });
    await assert.rejects(
      pr.mcp.call('tools/list'),
      (error) => error instanceof PingRoomError && error.code === 'mcp_invalid_response',
      JSON.stringify(body),
    );
  }
  const { fetchImpl } = recording(() => ({ body: { jsonrpc: '2.0', id: 1, result: null } }));
  assert.equal(await new PingRoom({ token: 't', fetch: fetchImpl }).mcp.call('ping'), null);
});

// --- SDK-09: the connection routes are wrapped ------------------------------

test('auth.connection and auth.disconnect call the agent connection routes', async () => {
  const connection = {
    flow_version: 2,
    claim_mode: 'agent_identity',
    status: 'active',
    handle: 'agt_fixture',
    agent: { id: 'reg-1', label: 'CI', handle: 'agt_fixture', profile: { display_name: 'CI', handle: 'agt_fixture', avatar_id: 'bot-1', avatar_url: 'https://pingroom.io/a.png' } },
    owner: { id: 'u_public', name: 'Sam' },
    home_room: { id: 'r1', invite_code: 'AB12', name: 'Home' },
    room_membership: null,
    room_memberships: [],
    room_access: 'selected',
    links: { latest_pings: 'https://api.pingroom.io/api/agent/notifications', install_app: 'https://pingroom.io/i' },
  };
  const disconnected = { status: 'revoked', handle: 'agt_fixture', owner: { id: 'u_public', name: 'Sam' }, message: 'Revoked.' };
  const { calls, fetchImpl } = recording(({ url }) => ({ body: url.pathname.endsWith('/connection') ? connection : disconnected }));
  const pr = new PingRoom({ token: 't', fetch: fetchImpl });
  assert.deepEqual(await pr.auth.connection(), connection);
  assert.deepEqual(await pr.auth.disconnect(), disconnected);
  assert.deepEqual(calls.map(({ url, init }) => `${init.method} ${url.pathname}`), ['GET /api/agent/connection', 'POST /api/agent/disconnect']);
});

// --- SDK-04 / XR-03: listen retries only transient failures ----------------

function listenScript(steps) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push({ at: performance.now(), url: new URL(url) });
    const step = steps[Math.min(requests.length - 1, steps.length - 1)];
    if (step.throws) throw step.throws;
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200, headers: step.headers });
  };
  return { requests, pr: new PingRoom({ token: 't', fetch: fetchImpl }) };
}

const ping = (id) => ({ id, message: id, created_at: 'now', action_number: null, action_icon: null, trigger_source: null });

test('listen ends by throwing a 401 even with onError, instead of retrying a revoked credential', async () => {
  const { pr, requests } = listenScript([{ status: 401, body: { message: 'Unauthenticated.' } }]);
  const handled = [];
  const iterate = async () => {
    for await (const _ of pr.notifications.listen({ after: 'c0', backoffMs: 1, onError: (e) => handled.push(e) })) { /* none */ }
  };
  await assert.rejects(iterate(), (error) => error instanceof PingRoomError && error.status === 401);
  assert.equal(requests.length, 1);
  assert.equal(handled.length, 0);
});

test('listen passes only transient failures to onError, backs off, and keeps delivering', async () => {
  const { pr, requests } = listenScript([
    { status: 503, body: {} },
    { throws: new TypeError('fetch failed') },
    { body: { notifications: [ping('a')], cursor: 'c1' } },
  ]);
  const handled = [];
  const got = [];
  for await (const n of pr.notifications.listen({ after: 'c0', backoffMs: 40, onError: (e) => handled.push(e) })) {
    got.push(n.id);
    break;
  }
  assert.deepEqual(got, ['a']);
  assert.deepEqual(handled.map((e) => [e.status, e.code]), [[503, null], [0, 'network_error']]);
  // Exponential: 40 ms after the first failure, 80 ms after the second.
  assert.ok(requests[1].at - requests[0].at >= 35);
  assert.ok(requests[2].at - requests[1].at >= 75);
});

test('listen without onError retries a 429 after retryAfter instead of ending', async () => {
  const { pr, requests } = listenScript([
    { status: 429, body: { code: 'rate_limited', message: 'Too Many Attempts.', retry_after: 1 } },
    { body: { notifications: [ping('b')], cursor: 'c2' } },
  ]);
  const got = [];
  for await (const n of pr.notifications.listen({ after: 'c0', backoffMs: 1 })) {
    got.push(n.id);
    break;
  }
  assert.deepEqual(got, ['b']);
  assert.ok(requests[1].at - requests[0].at >= 950, `retried after ${requests[1].at - requests[0].at} ms`);
});

test('listen retries a transient failure of its first head read', async () => {
  const { pr, requests } = listenScript([
    { status: 502, body: {} },
    { body: { notifications: [], cursor: 'head' } },
    { body: { notifications: [ping('c')], cursor: 'c3' } },
  ]);
  const got = [];
  for await (const n of pr.notifications.listen({ backoffMs: 1 })) {
    got.push(n.id);
    break;
  }
  assert.deepEqual(got, ['c']);
  assert.equal(requests[1].url.searchParams.get('timeout'), '0');
  assert.equal(requests[1].url.searchParams.has('after'), false);
  assert.equal(requests[2].url.searchParams.get('after'), 'head');
});

test('aborting listen during a backoff ends it quietly', async () => {
  const { pr, requests } = listenScript([{ status: 503, body: {} }]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = performance.now();
  for await (const _ of pr.notifications.listen({ after: 'c0', signal: controller.signal, backoffMs: 5000 })) { /* none */ }
  assert.ok(performance.now() - started < 1000);
  assert.equal(requests.length, 1);
});

// --- SD-06 / SD-08: listen polls are spaced, and a malformed 2xx is not a ping feed ---

test('listen({ timeout: 0 }) does not spin when the server answers at once', async () => {
  const { pr, requests } = listenScript([{ body: { notifications: [], cursor: 'c0' } }]);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  for await (const _ of pr.notifications.listen({ after: 'c0', timeout: 0, signal: controller.signal })) { /* none */ }
  // The route allows 30 a minute per human, shared with their other listeners.
  assert.equal(requests.length, 1);
});

test('listen starts empty polls at least 2.1 s apart, and re-polls a non-empty batch at once', async () => {
  const { pr, requests } = listenScript([
    { body: { notifications: [ping('a')], cursor: 'c1' } },
    { body: { notifications: [], cursor: 'c1' } },
    { body: { notifications: [], cursor: 'c1' } },
  ]);
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (requests.length >= 3) controller.abort();
  }, 20);
  const got = [];
  try {
    for await (const n of pr.notifications.listen({ after: 'c0', timeout: 0, signal: controller.signal })) {
      got.push(n.id);
    }
  } finally {
    clearInterval(timer);
  }
  assert.deepEqual(got, ['a']);
  assert.equal(requests.length, 3);
  assert.ok(requests[1].at - requests[0].at < 500, 'a non-empty batch is followed by an immediate poll');
  assert.ok(requests[2].at - requests[1].at >= 2090, `empty polls ${requests[2].at - requests[1].at} ms apart`);
});

test('listen turns a 2xx that is not a wait answer into invalid_response', async () => {
  const bodies = [
    { body: '<html>Please sign in to the hotspot</html>' },
    { body: {} },
    { body: { notifications: 'none', cursor: 'c1' } },
    { body: { notifications: [null], cursor: 'c1' } },
    { body: { notifications: [], cursor: 7 } },
  ];
  for (const step of bodies) {
    const { pr, requests } = listenScript([step]);
    await assert.rejects(
      async () => {
        for await (const _ of pr.notifications.listen({ after: 'c0' })) { /* none */ }
      },
      (error) => error instanceof PingRoomError && error.code === 'invalid_response' && error.status === 0,
    );
    assert.equal(requests.length, 1);
  }
  // The initial head read exists to obtain a cursor: one without it is invalid.
  const head = listenScript([{ body: { notifications: [] } }]);
  await assert.rejects(
    async () => {
      for await (const _ of head.pr.notifications.listen()) { /* none */ }
    },
    (error) => error instanceof PingRoomError && error.code === 'invalid_response',
  );
});
