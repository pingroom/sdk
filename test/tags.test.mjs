import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError, liveStatus, sendIncomingWebhook } from '../dist/index.js';
import { recorder } from './helpers.mjs';

const TAG_32 = 'a'.repeat(32);

const invalid = (error) => error instanceof PingRoomError && error.code === 'invalid_request';

function pingRoomRecorder() {
  return recorder({
    'POST /api/agent/rooms/ab12/notifications': () => ({
      status: 201,
      body: { id: 'n1', message: 'hi', created_at: 'now', action_number: null, action_icon: null, trigger_source: null, tags: ['deploy'] },
    }),
    'POST /api/agent/rooms/ab12/live': () => ({ status: 201, body: { notification_id: 'n1', correlation_id: 'c1', state: 'started', idempotent: false } }),
    '*': () => ({ body: { data: [], notifications: [], cursor: 'c' } }),
  });
}

test('broadcast sends tags as given and reads them back', async () => {
  const { calls, fetchMock } = pingRoomRecorder();
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const res = await pr.broadcast('ab12', { message: 'hi', tags: ['Deploy ', 'deploy', 'prod_1'] });
  assert.deepEqual(res.tags, ['deploy']);
  // The server normalizes; the SDK does not rewrite the payload.
  assert.deepEqual(JSON.parse(calls[0].init.body).tags, ['Deploy ', 'deploy', 'prod_1']);
});

test('broadcast refuses tags the server would refuse, before any request', async () => {
  const { calls, fetchMock } = pingRoomRecorder();
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const bad = [
    ['bad tag'],
    ['a.b'],
    ['café'],
    ['-lead'],
    ['_lead'],
    [`${TAG_32}a`],
    Array.from({ length: 11 }, (_, i) => `t${i}`),
    'deploy',
    [5],
    [null],
    [['deploy']],
  ];
  for (const tags of bad) {
    assert.throws(() => pr.broadcast('ab12', { message: 'hi', tags }), invalid, JSON.stringify(tags));
  }
  assert.equal(calls.length, 0);
});

test('broadcast accepts the limits and what the server normalizes away', async () => {
  const { calls, fetchMock } = pingRoomRecorder();
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const ten = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(32));
  await pr.broadcast('ab12', { message: 'hi', tags: ten });
  // Eleven that collapse to ten once trimmed, lowercased and de-duplicated.
  await pr.broadcast('ab12', { message: 'hi', tags: [...Array.from({ length: 10 }, (_, i) => `t${i}`), ' T0 '] });
  // Blanks are dropped, as on the server.
  await pr.broadcast('ab12', { message: 'hi', tags: ['', '  ', 'ok'] });
  await pr.broadcast('ab12', { message: 'hi', tags: [] });
  await pr.broadcast('ab12', { message: 'hi', tags: undefined });
  assert.equal(calls.length, 5);
});

test('live.push validates tags and forwards them with the stream', async () => {
  const { calls, fetchMock } = pingRoomRecorder();
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.live.push('ab12', liveStatus.progress('c1', { state: 'running', progress: 0.1 }, { tags: ['nightly', 'prod'] }));
  assert.deepEqual(JSON.parse(calls[0].init.body).tags, ['nightly', 'prod']);

  assert.throws(() => pr.live.push('ab12', liveStatus.done('c1', undefined, { tags: ['bad tag'] })), invalid);
  assert.equal(calls.length, 1);
});

test('liveStatus builders pass tags through as part of the ping', () => {
  assert.deepEqual(liveStatus.status('c1', { state: 'running' }, { tags: ['x'] }).tags, ['x']);
  assert.deepEqual(liveStatus.done('c1', 'ok', { tags: ['x'] }).tags, ['x']);
});

test('sendIncomingWebhook sends tags, also with a live_status stream, and validates them', async () => {
  const sent = [];
  const fetchMock = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const url = 'https://api.pingroom.io/api/webhooks/AB12/secret';

  await sendIncomingWebhook(url, { message: 'green', tags: ['ci', 'main'] }, { fetch: fetchMock });
  await sendIncomingWebhook(url, { correlation_id: 'c1', tags: ['nightly'], live_status: { state: 'running' } }, { fetch: fetchMock });
  assert.deepEqual(sent[0].tags, ['ci', 'main']);
  assert.deepEqual(sent[1].tags, ['nightly']);

  await assert.rejects(
    () => sendIncomingWebhook(url, { message: 'x', tags: ['bad tag'] }, { fetch: fetchMock }),
    invalid,
  );
  assert.equal(sent.length, 2);
});

test('notifications.list sends tag and room_id, and refuses a tag that cannot exist', async () => {
  const { calls, fetchMock } = pingRoomRecorder();
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.notifications.list({ tag: 'deploy', room_id: '0197c3a0-0000-7000-8000-000000000001', limit: 5 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/agent/notifications');
  assert.equal(url.searchParams.get('tag'), 'deploy');
  assert.equal(url.searchParams.get('room_id'), '0197c3a0-0000-7000-8000-000000000001');
  assert.equal(url.searchParams.get('limit'), '5');

  // The server lowercases the filter, so the SDK accepts a padded, mixed-case one.
  await pr.notifications.list({ tag: ' Deploy ' });
  await assert.rejects(() => pr.notifications.list({ tag: 'bad tag' }), invalid);
  await assert.rejects(() => pr.notifications.list({ tag: '' }), invalid);
  await assert.rejects(() => pr.notifications.list({ tag: 5 }), invalid);
  assert.equal(calls.length, 2);
});

test('notifications.list leaves the query alone without a tag', async () => {
  const { calls, fetchMock } = pingRoomRecorder();
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.notifications.list({ type: 'received' });
  assert.equal(new URL(calls[0].url).searchParams.has('tag'), false);
});

test('notifications.wait and listen send the tag', async () => {
  const { calls, fetchMock } = pingRoomRecorder();
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.notifications.wait({ after: 'cur1', timeout: 0, tag: 'billing' });
  assert.equal(new URL(calls[0].url).searchParams.get('tag'), 'billing');
  assert.equal(new URL(calls[0].url).searchParams.get('after'), 'cur1');

  assert.throws(() => pr.notifications.wait({ tag: 'bad tag' }), invalid);

  // listen() reads the head without the filter's help, then polls with it.
  const controller = new AbortController();
  const iterator = pr.notifications.listen({ tag: 'billing', timeout: 0, signal: controller.signal, after: 'cur1' });
  const pending = iterator.next();
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await pending;
  const polled = calls.filter((call) => new URL(call.url).searchParams.get('after') === 'cur1');
  assert.ok(polled.length >= 2);
  assert.equal(new URL(polled[polled.length - 1].url).searchParams.get('tag'), 'billing');

  await assert.rejects(() => pr.notifications.listen({ tag: 'bad tag' }).next(), invalid);
});

test('the SDK tag limits match the server contract', async () => {
  // Mirrors App\Support\PingTagRules (MAX_TAGS = 10, TAG_MAX = 32, ^[a-z0-9][a-z0-9_-]{0,31}$).
  const { calls, fetchMock } = pingRoomRecorder();
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.broadcast('ab12', { message: 'hi', tags: [TAG_32, '0', 'a-b_c'] });
  assert.throws(() => pr.broadcast('ab12', { message: 'hi', tags: [`${TAG_32}0`] }), invalid);
  assert.throws(() => pr.broadcast('ab12', { message: 'hi', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), invalid);
  assert.equal(calls.length, 1);
});
