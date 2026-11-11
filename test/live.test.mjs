import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { LIVE_CLAIM_ERROR_CODES, PingRoom, PingRoomError } from '../dist/index.js';

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
  const fetchMock = async () => new Response(
    JSON.stringify({ code: 'stream_not_found', message: 'No live stream for that correlation id in the last 24 hours.' }),
    { status: 404 },
  );
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  assert.equal(await pr.live.get('AB12CD', 'corr-1'), null);
});

test('live.get throws for a 404 that is not stream_not_found, such as an unknown room', async () => {
  // A mistyped or deleted room code is the route-binding 404, which carries no
  // stream code. Reading it as "no stream" would make a restarted producer open
  // a new stream instead of failing.
  const fetchMock = async () => new Response(JSON.stringify({ message: 'Resource not found.' }), { status: 404 });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await assert.rejects(
    () => pr.live.get('NOPE99', 'corr-1'),
    (e) => e instanceof PingRoomError && e.status === 404 && e.code === null,
  );
});

const NOTIFICATION_ID = '0198f3c2-6f0e-7d3a-9a55-3b1c2d4e5f60';

test('live.claim posts the action to the agent transition route and returns the claim', async () => {
  const claim = { status: 'claimed', by: { id: 'u1', name: 'Alex' }, at: 1794146700, late: false };
  let seen;
  const fetchMock = async (url, init) => {
    seen = { url: new URL(url).pathname, method: init.method, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({ notification_id: NOTIFICATION_ID, correlation_id: 'milk-1', claim, state: 'running', idempotent: false }),
      { status: 200 },
    );
  };
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const result = await pr.live.claim('AB12CD', NOTIFICATION_ID, 'claim');
  assert.deepEqual(seen, {
    url: `/api/agent/rooms/AB12CD/live/${NOTIFICATION_ID}/claim`,
    method: 'POST',
    body: { action: 'claim' },
  });
  assert.equal(result.claim.by.name, 'Alex');
  assert.equal(result.idempotent, false);
});

const claimReceipt = (overrides = {}) => ({
  notification_id: NOTIFICATION_ID, correlation_id: 'milk-1', state: 'running', idempotent: false,
  claim: { status: 'claimed', by: { id: 'member-1', name: 'Alex', image_url: null }, at: 1794146700, late: false },
  ...overrides,
});

test('live.claim accepts each documented transition and idempotent receipt without dropping additive fields', async () => {
  for (const [action, status, state] of [
    ['claim', 'claimed', 'running'], ['release', 'open', 'running'], ['done', 'done', 'done'], ['cancel', 'cancelled', 'failed'],
  ]) for (const idempotent of [false, true]) {
    const receipt = claimReceipt({ state, idempotent, extra: 'future-field' });
    receipt.claim.status = status;
    if (action === 'release' || action === 'cancel') Object.assign(receipt.claim, { by: null, at: null });
    let calls = 0;
    const pr = new PingRoom({ token: 't', fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(receipt));
    } });
    assert.deepEqual(await pr.live.claim('AB12CD', NOTIFICATION_ID.toUpperCase(), action), receipt);
    assert.equal(calls, 1);
  }
});

// What the server answers when a claimer lets go of a request past its deadline
// (Claim::decide): a 200 with claim.status "expired", stream state "failed",
// nobody holding it, and the request ended by the person who let go. A retry by
// the same person replays it with idempotent: true.
const expiredReleaseReceipt = (overrides = {}) => ({
  notification_id: NOTIFICATION_ID, correlation_id: 'milk-1', state: 'failed', idempotent: false,
  claim: { status: 'expired', by: null, at: null, late: false, realerted_at: 1794146000, ended_by: 'member-1' },
  ...overrides,
});

test('live.claim release past the deadline resolves with the expired receipt, once, and keeps additive fields', async () => {
  for (const idempotent of [false, true]) {
    const receipt = expiredReleaseReceipt({ idempotent, extra: 'future-field' });
    const seen = [];
    const pr = new PingRoom({ token: 't', fetch: async (url, init) => {
      seen.push({ path: new URL(url).pathname, method: init.method, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(receipt), { status: 200 });
    } });
    const result = await pr.live.claim('AB12CD', NOTIFICATION_ID, 'release');
    assert.deepEqual(result, receipt);
    assert.equal(result.claim.status, 'expired');
    assert.equal(result.state, 'failed');
    assert.deepEqual(seen, [{ path: `/api/agent/rooms/AB12CD/live/${NOTIFICATION_ID}/claim`, method: 'POST', body: { action: 'release' } }]);
  }
});

test('live.claim takes the expired receipt only for release, and only as expired with state failed', async () => {
  const wrongPair = (status, state) => expiredReleaseReceipt({ state, claim: { ...expiredReleaseReceipt().claim, status } });
  const cases = [
    // The expired receipt is release's alone.
    ...['claim', 'done', 'cancel'].map((action) => [action, expiredReleaseReceipt()]),
    // Release takes open/running or expired/failed, nothing in between.
    ['release', wrongPair('expired', 'running')],
    ['release', wrongPair('expired', 'done')],
    ['release', wrongPair('open', 'failed')],
    ['release', wrongPair('unfinished', 'failed')],
    ['release', wrongPair('cancelled', 'failed')],
    // And an expired receipt is still checked like every other one.
    ['release', expiredReleaseReceipt({ notification_id: 'another-notification' })],
    ['release', expiredReleaseReceipt({ claim: { ...expiredReleaseReceipt().claim, late: 'false' } })],
    ['release', expiredReleaseReceipt({ claim: { ...expiredReleaseReceipt().claim, at: '1794146700' } })],
  ];
  for (const [action, body] of cases) {
    let calls = 0;
    const pr = new PingRoom({ token: 't', fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(body));
    } });
    await assert.rejects(
      pr.live.claim('AB12CD', NOTIFICATION_ID, action),
      (error) => error instanceof PingRoomError && error.code === 'invalid_response' && error.status === 0,
      `${action}: ${JSON.stringify(body)}`,
    );
    assert.equal(calls, 1);
  }
});

test('live.claim rejects malformed or misattributed success receipts without replaying the POST', async () => {
  const invalid = [
    null, [], {}, true, 1,
    claimReceipt({ notification_id: 'another-notification' }),
    claimReceipt({ notification_id: undefined }),
    claimReceipt({ correlation_id: '' }),
    claimReceipt({ idempotent: 'true' }),
    claimReceipt({ idempotent: undefined }),
    claimReceipt({ state: 'done' }),
    claimReceipt({ claim: null }),
    ...[
      { status: 'open' }, { status: 'other' }, { by: [] }, { by: { name: 'Alex' } },
      { by: { id: 'member-1' } }, { by: 'Alex' }, { at: undefined }, { at: '1794146700' }, { late: 0 },
    ].map((change) => { const receipt = claimReceipt(); Object.assign(receipt.claim, change); return receipt; }),
  ];
  for (const body of invalid) {
    let calls = 0;
    const pr = new PingRoom({ token: 't', fetch: async (_url, init) => {
      calls += 1;
      assert.equal(init.method, 'POST');
      return new Response(JSON.stringify(body));
    } });
    await assert.rejects(
      pr.live.claim('AB12CD', NOTIFICATION_ID, 'claim'),
      (error) => error instanceof PingRoomError && error.code === 'invalid_response' && error.status === 0,
      JSON.stringify(body),
    );
    assert.equal(calls, 1);
  }
});

test('live.claim preserves refusal status, code and body without replaying the POST', async () => {
  for (const [status, code] of [[409, 'claim_conflict'], [422, 'claim_own_request'], [403, 'forbidden'], [404, 'claim_not_found']]) {
    const body = { code, message: 'Refused', ...(status === 409 || status === 422 ? { claim: claimReceipt().claim, state: 'running' } : {}) };
    let calls = 0;
    const pr = new PingRoom({ token: 't', fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify(body), { status });
    } });
    await assert.rejects(pr.live.claim('AB12CD', NOTIFICATION_ID, 'claim'), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.deepEqual(error.body, body);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('LiveClaimParty accepts the documented null image URL and rejects a numeric one', () => {
  const filename = fileURLToPath(new URL('./live-claim-contract.mts', import.meta.url));
  const source = `
    import type { LiveClaimParty } from '../dist/index.js';
    const party: LiveClaimParty = { id: 'member-1', name: 'Alex', image_url: null };
    const image: string | null | undefined = party.image_url;
    // @ts-expect-error avatar image URLs cannot be numbers
    const invalid: LiveClaimParty = { id: 'member-1', name: 'Alex', image_url: 42 };
    void [image, invalid];
  `;
  const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const host = ts.createCompilerHost(options), read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  host.readFile = (path) => path === filename ? source : read(path);
  host.fileExists = (path) => path === filename || exists(path);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
});

test('live.claim throws a coded PingRoomError whose body names who got it first', async () => {
  const claim = { status: 'claimed', by: { id: 'u2', name: 'Sam' }, at: 1794146700, late: false };
  const fetchMock = async () =>
    new Response(
      JSON.stringify({ code: 'claim_conflict', message: 'Sam is already on it.', claim, state: 'running' }),
      { status: 409 },
    );
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await assert.rejects(
    () => pr.live.claim('AB12CD', NOTIFICATION_ID, 'claim'),
    (e) => e instanceof PingRoomError && e.status === 409 && e.code === 'claim_conflict' && e.body.claim.by.name === 'Sam',
  );
});

test('live.claim refuses an empty notification id before any request', () => {
  const pr = new PingRoom({ token: 't', fetch: async () => { throw new Error('no request expected'); } });
  assert.throws(() => pr.live.claim('AB12CD', '', 'done'), (e) => e instanceof PingRoomError && e.code === 'invalid_request');
});

test('live.claim rejects unsupported JavaScript actions before any request', () => {
  let calls = 0;
  const pr = new PingRoom({ token: 't', fetch: async () => { calls += 1; return new Response('{}'); } });
  for (const action of ['', 'take', 'constructor', '__proto__', null, undefined, 42, {}]) {
    assert.throws(() => pr.live.claim('AB12CD', NOTIFICATION_ID, action),
      (error) => error instanceof PingRoomError && error.code === 'invalid_request');
  }
  assert.equal(calls, 0);
});

test('the claim error codes are exported as a runtime union', () => {
  assert.deepEqual([...LIVE_CLAIM_ERROR_CODES], [
    'claim_conflict', 'claim_own_request', 'claim_private_rooms_only', 'claim_not_found',
    'claim_request_invalid', 'claim_must_start_running', 'claim_deadline_out_of_range',
  ]);
});
