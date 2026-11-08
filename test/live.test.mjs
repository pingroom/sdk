import test from 'node:test';
import assert from 'node:assert/strict';
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

test('the claim error codes are exported as a runtime union', () => {
  assert.deepEqual([...LIVE_CLAIM_ERROR_CODES], [
    'claim_conflict', 'claim_own_request', 'claim_private_rooms_only', 'claim_not_found',
    'claim_request_invalid', 'claim_must_start_running', 'claim_deadline_out_of_range',
  ]);
});
