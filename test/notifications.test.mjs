import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom } from '../dist/index.js';
import { recorder } from './helpers.mjs';

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
