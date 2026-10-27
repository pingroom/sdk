import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError, PingRoomTimeoutError } from '../dist/index.js';
import { isTransientError, transientDelayMs } from '../dist/internal/retry.js';

/** Serve each wait from `script` in order; a function entry may throw to simulate a dropped connection. */
function scripted(script) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push({ at: performance.now(), path: new URL(url).pathname });
    const next = script[Math.min(requests.length - 1, script.length - 1)];
    const step = typeof next === 'function' ? next() : next;
    const { status = 200, body, headers } = step;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  return { requests, pr: new PingRoom({ token: 'fixture-token', fetch: fetchImpl }) };
}

const approvalPending = { id: 'appr-1', status: 'pending', decision: null, decided_at: null };
const approvalDecided = { id: 'appr-1', status: 'decided', decision: 'approve', decided_at: '2026-10-27T10:00:00+00:00' };
const questionPending = { id: 'q-1', kind: 'question', state: 'pending', answer: null };
const questionAnswered = { id: 'q-1', kind: 'question', state: 'answered', answer: { value: 'ship', label: 'Ship' } };
const handoffOpen = { id: 'h-1', kind: 'ack', state: 'open' };
const handoffAcked = { id: 'h-1', kind: 'ack', state: 'acked', acked_at: '2026-10-27T10:00:00+00:00' };

const loops = [
  { name: 'approvals.waitForDecision', pending: approvalPending, done: approvalDecided, run: (pr, o) => pr.approvals.waitForDecision('appr-1', o) },
  { name: 'questions.waitForAnswer', pending: questionPending, done: questionAnswered, run: (pr, o) => pr.questions.waitForAnswer('q-1', o) },
  { name: 'handoffs.waitForResult', pending: handoffOpen, done: handoffAcked, run: (pr, o) => pr.handoffs.waitForResult('h-1', o) },
];

const invalid = (error) => error instanceof PingRoomError && error.code === 'invalid_response';

for (const loop of loops) {
  test(`${loop.name} refuses a malformed 2xx instead of returning it as an outcome`, async () => {
    const stateField = 'status' in loop.pending ? 'status' : 'state';
    const bodies = [
      '<html>captive portal</html>',
      {},
      [],
      { ...loop.done, id: 'someone-else' },
      { ...loop.done, [stateField]: 'approved' },
      { ...loop.done, [stateField]: undefined },
    ];
    for (const body of bodies) {
      const { pr, requests } = scripted([{ body }]);
      await assert.rejects(loop.run(pr), invalid, JSON.stringify(body));
      assert.equal(requests.length, 1, 'a malformed response must not be polled again');
    }
  });

  test(`${loop.name} still returns a terminal response for the requested id in either case`, async () => {
    const { pr } = scripted([{ body: { ...loop.done, id: loop.done.id.toUpperCase() } }]);
    assert.equal((await loop.run(pr)).id, loop.done.id.toUpperCase());
  });
}

test('approvals.waitForDecision refuses a decided approval without a decision and a pending one already decided', async () => {
  for (const body of [
    { ...approvalDecided, decision: null },
    { ...approvalDecided, decision: '' },
    { ...approvalPending, decided_at: '2026-10-27T10:00:00+00:00' },
    { ...approvalDecided, decided_at: undefined },
  ]) {
    const { pr } = scripted([{ body }]);
    await assert.rejects(pr.approvals.waitForDecision('appr-1'), invalid, JSON.stringify(body));
  }
});

test('every wait loop retries a 429 after its Retry-After, then returns the outcome', async () => {
  await Promise.all(loops.map(async (loop) => {
    const { pr, requests } = scripted([
      { status: 429, body: { code: 'rate_limited', message: 'Too Many Attempts.' }, headers: { 'Retry-After': '1' } },
      { body: loop.done },
    ]);
    assert.deepEqual(await loop.run(pr), loop.done);
    assert.equal(requests.length, 2, loop.name);
    assert.ok(requests[1].at - requests[0].at >= 950, `${loop.name} retried after ${requests[1].at - requests[0].at} ms`);
  }));
});

test('every wait loop retries a 5xx and a dropped connection with backoff', async () => {
  await Promise.all(loops.flatMap((loop) => [
    { status: 503, body: '<html>Service Unavailable</html>' },
    () => { throw new TypeError('fetch failed'); },
  ].map(async (failure) => {
    const { pr, requests } = scripted([failure, { body: loop.done }]);
    assert.deepEqual(await loop.run(pr), loop.done);
    assert.equal(requests.length, 2, loop.name);
    assert.ok(requests[1].at - requests[0].at >= 950, `${loop.name} backed off ${requests[1].at - requests[0].at} ms`);
  })));
});

test('every wait loop throws a permanent failure at once', async () => {
  await Promise.all(loops.flatMap((loop) => [401, 403, 404, 422].map(async (status) => {
    const { pr, requests } = scripted([{ status, body: { message: `HTTP ${status}` } }]);
    await assert.rejects(loop.run(pr), (error) => error instanceof PingRoomError && error.status === status);
    assert.equal(requests.length, 1, `${loop.name} ${status}`);
  })));
});

test('aborting during a transient backoff rejects with the caller reason without another request', async () => {
  await Promise.all(loops.map(async (loop) => {
    const { pr, requests } = scripted([{ status: 503, body: {} }]);
    const controller = new AbortController();
    const reason = new Error('caller stopped waiting');
    setTimeout(() => controller.abort(reason), 100);
    const started = performance.now();
    await assert.rejects(loop.run(pr, { signal: controller.signal }), (error) => error === reason);
    assert.ok(performance.now() - started < 900, `${loop.name} waited out its backoff`);
    assert.equal(requests.length, 1);
  }));
});

test('handoffs.waitForResult spaces immediate polls so timeout: 0 cannot burn the wait throttle', async () => {
  const { pr, requests } = scripted([{ body: handoffOpen }]);
  const controller = new AbortController();
  const reason = new Error('stop');
  setTimeout(() => controller.abort(reason), 1500);
  await assert.rejects(pr.handoffs.waitForResult('h-1', { timeout: 0, signal: controller.signal }), (error) => error === reason);
  // Unspaced, an always-open stub is polled back to back (41 requests before
  // the server's 30/min throttle answered 429 in the audit's repro).
  assert.equal(requests.length, 1);
});

test('transient-failure classification matches the pairing and CLI retry set', () => {
  assert.equal(isTransientError(new PingRoomError('x', { code: 'network_error' })), true);
  assert.equal(isTransientError(new PingRoomTimeoutError()), true);
  assert.equal(isTransientError(new PingRoomError('x', { status: 429, code: 'public_room_rate_limited' })), true);
  assert.equal(isTransientError(new PingRoomError('x', { status: 502 })), true);
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isTransientError(new PingRoomError('x', { status })), false, String(status));
  }
  assert.equal(isTransientError(new PingRoomError('x', { code: 'invalid_response' })), false);
  assert.equal(isTransientError(new PingRoomError('x', { code: 'redirect_refused', status: 307 })), false);
  assert.equal(isTransientError(new Error('plain')), false);
});

test('transient backoff doubles to a 30 s cap and yields to a server Retry-After', () => {
  const error = new PingRoomError('x', { status: 503 });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map((n) => transientDelayMs(error, n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.deepEqual([1, 2, 3].map((n) => transientDelayMs(error, n, 10)), [10, 20, 40]);
  const throttled = new PingRoomError('x', { status: 429, retryAfter: 42 });
  assert.equal(transientDelayMs(throttled, 1), 42_000);
  assert.equal(transientDelayMs(throttled, 9), 42_000);
  // Retry-After: 0 must not turn into a tight loop.
  assert.equal(transientDelayMs(new PingRoomError('x', { status: 429, retryAfter: 0 }), 1), 1000);
});
