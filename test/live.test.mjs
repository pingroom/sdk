import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError } from '../dist/index.js';

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
