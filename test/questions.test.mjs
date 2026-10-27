import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom } from '../dist/index.js';
import { recorder } from './helpers.mjs';

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
