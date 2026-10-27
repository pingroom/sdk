import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError } from '../dist/index.js';
import { recorder } from './helpers.mjs';

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
