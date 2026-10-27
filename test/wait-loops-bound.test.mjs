import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError } from '../dist/index.js';
import { WAIT_EXPIRY_GRACE_MS, WAIT_UNKNOWN_EXPIRY_OUTAGE_MS } from '../dist/internal/retry.js';

// Fake time throughout: the bounds are minutes long. Only setTimeout and Date
// are mocked, so setImmediate still flushes the fetch/JSON promise chain
// between ticks.
const START = Date.parse('2026-10-27T10:00:00.000Z');
const MINUTE = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * A transport whose answer is chosen by `respond(n, now)` for the n-th request
 * (1-based). Returns `{ status, body }`; a function body is thrown instead, to
 * simulate a dropped connection.
 */
function transport(respond) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push({ at: Date.now(), path: new URL(url).pathname });
    const { status = 200, body, throws } = respond(requests.length, Date.now());
    if (throws) throw throws;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { requests, pr: new PingRoom({ token: 'fixture-token', fetch: fetchImpl }) };
}

/** Drive fake time in `stepMs` ticks until `promise` settles; return its outcome and the settle time. */
async function settle(t, promise, { stepMs = 1000, maxMs = 3 * 60 * MINUTE } = {}) {
  const outcome = { done: false };
  promise.then(
    (value) => Object.assign(outcome, { done: true, value, at: Date.now() }),
    (error) => Object.assign(outcome, { done: true, error, at: Date.now() }),
  );
  for (let elapsed = 0; elapsed <= maxMs; elapsed += stepMs) {
    for (let i = 0; i < 4 && !outcome.done; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (outcome.done) return outcome;
    t.mock.timers.tick(stepMs);
  }
  assert.fail(`the wait did not settle within ${maxMs} ms of fake time`);
}

function fakeTime(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
}

const unavailable503 = { status: 503, body: '<html>Service Unavailable</html>' };

const loops = [
  {
    name: 'approvals.waitForDecision',
    what: 'approval appr-1',
    pending: (expiresAt) => ({ id: 'appr-1', status: 'pending', decision: null, decided_at: null, expires_at: expiresAt }),
    done: { id: 'appr-1', status: 'decided', decision: 'approve', decided_at: '2026-10-27T10:00:00+00:00', expires_at: null },
    run: (pr, o) => pr.approvals.waitForDecision('appr-1', o),
  },
  {
    name: 'questions.waitForAnswer',
    what: 'question q-1',
    pending: (expiresAt) => ({ id: 'q-1', kind: 'question', state: 'pending', answer: null, expires_at: expiresAt }),
    done: { id: 'q-1', kind: 'question', state: 'answered', answer: { value: 'ship', label: 'Ship' }, expires_at: null },
    run: (pr, o) => pr.questions.waitForAnswer('q-1', o),
  },
  {
    name: 'handoffs.waitForResult',
    what: 'handoff h-1',
    pending: (expiresAt) => ({ id: 'h-1', kind: 'ack', state: 'open', expires_at: expiresAt }),
    done: { id: 'h-1', kind: 'ack', state: 'acked', acked_at: '2026-10-27T10:00:00+00:00', expires_at: null },
    run: (pr, o) => pr.handoffs.waitForResult('h-1', o),
  },
];

const gaveUp = (loop, cause) => (error) => (
  error instanceof PingRoomError
  && error.code === 'unavailable'
  && error.status === 0
  && error.cause === cause
  && error.message.includes(`stopped waiting for ${loop.what}`)
);

test('the outage bounds match the CLI: expiry plus 5 minutes, or 15 minutes of failures', () => {
  assert.equal(WAIT_EXPIRY_GRACE_MS, 5 * MINUTE);
  assert.equal(WAIT_UNKNOWN_EXPIRY_OUTAGE_MS, 15 * MINUTE);
});

for (const loop of loops) {
  test(`${loop.name} without a signal gives up after 15 minutes of unbroken failures when no expiry was seen`, async (t) => {
    fakeTime(t);
    const { pr, requests } = transport(() => unavailable503);
    const outcome = await settle(t, loop.run(pr));
    assert.ok(outcome.error, 'a permanently failing API must end the wait');
    assert.equal(outcome.error.code, 'unavailable', outcome.error.message);
    assert.ok(outcome.error.cause instanceof PingRoomError);
    assert.equal(outcome.error.cause.status, 503);
    assert.ok(gaveUp(loop, outcome.error.cause)(outcome.error), outcome.error.message);
    assert.match(outcome.error.message, new RegExp(`since ${iso(START).replace(/\./g, '\\.')} \\(HTTP 503\\)`));
    const outage = outcome.at - START;
    assert.ok(outage >= 15 * MINUTE, `gave up after ${outage} ms`);
    assert.ok(outage <= 15 * MINUTE + 2000, `overshot the bound: ${outage} ms`);
    // The last attempt lands on the bound rather than one backoff after it.
    assert.ok(outcome.at - requests.at(-1).at <= 1000);
  });

  test(`${loop.name} gives up at the last-seen expires_at plus 5 minutes, not before`, async (t) => {
    fakeTime(t);
    // Expiry 30 min out: the bound is 35 min, well past the 15-minute
    // unknown-expiry cap, so this proves the expiry is what is used.
    const expiresAt = START + 30 * MINUTE;
    const { pr } = transport((n) => (n === 1 ? { body: loop.pending(iso(expiresAt)) } : unavailable503));
    const outcome = await settle(t, loop.run(pr));
    assert.equal(outcome.error?.code, 'unavailable', outcome.error?.message);
    assert.ok(outcome.at >= expiresAt + 5 * MINUTE, `gave up at +${(outcome.at - START) / 1000} s`);
    assert.ok(outcome.at <= expiresAt + 5 * MINUTE + 2000, `overshot: +${(outcome.at - START) / 1000} s`);
  });

  test(`${loop.name} with an expiry soon gives up before the 15-minute cap`, async (t) => {
    fakeTime(t);
    const expiresAt = START + 1 * MINUTE;
    const { pr } = transport((n) => (n === 1 ? { body: loop.pending(iso(expiresAt)) } : { throws: new TypeError('fetch failed') }));
    const outcome = await settle(t, loop.run(pr));
    assert.equal(outcome.error?.code, 'unavailable', outcome.error?.message);
    assert.equal(outcome.error.cause.code, 'network_error');
    assert.match(outcome.error.message, /\(network_error\)/);
    assert.ok(outcome.at >= expiresAt + 5 * MINUTE && outcome.at <= expiresAt + 5 * MINUTE + 2000, `+${(outcome.at - START) / 1000} s`);
  });

  test(`${loop.name} restarts the outage clock after any valid response`, async (t) => {
    fakeTime(t);
    // 10 min of 503, one pending read with no expiry, 10 more min of 503, then
    // the outcome. No unbroken 15-minute outage, so the wait never gives up.
    let recovered = false;
    const { pr } = transport((n, now) => {
      const elapsed = now - START;
      if (elapsed < 10 * MINUTE) return unavailable503;
      if (!recovered) {
        recovered = true;
        return { body: loop.pending(null) };
      }
      if (elapsed < 21 * MINUTE) return unavailable503;
      return { body: loop.done };
    });
    const outcome = await settle(t, loop.run(pr));
    assert.ifError(outcome.error);
    assert.deepEqual(outcome.value, loop.done);
    assert.ok(outcome.at - START >= 21 * MINUTE);
  });

  test(`${loop.name} reports each retry to onRetry with the consecutive attempt number`, async (t) => {
    fakeTime(t);
    const script = [unavailable503, unavailable503, { body: loop.pending(null) }, unavailable503, { body: loop.done }];
    const { pr } = transport((n) => script[Math.min(n, script.length) - 1]);
    const seen = [];
    const outcome = await settle(t, loop.run(pr, { onRetry: (error, attempt) => seen.push([error.status, attempt]) }));
    assert.ifError(outcome.error);
    assert.deepEqual(outcome.value, loop.done);
    // The count restarts after the pending read in the middle.
    assert.deepEqual(seen, [[503, 1], [503, 2], [503, 1]]);
  });

  test(`${loop.name} ends with the error onRetry throws`, async (t) => {
    fakeTime(t);
    const { pr, requests } = transport(() => unavailable503);
    const stop = new Error('three strikes');
    const outcome = await settle(t, loop.run(pr, {
      onRetry: (_error, attempt) => { if (attempt === 3) throw stop; },
    }));
    assert.equal(outcome.error, stop);
    assert.equal(requests.length, 3);
  });

  test(`${loop.name} refuses an onRetry that is not a function before sending`, async () => {
    const { pr, requests } = transport(() => ({ body: loop.done }));
    await assert.rejects(
      async () => loop.run(pr, { onRetry: 'log' }),
      (error) => error instanceof PingRoomError && error.code === 'invalid_request' && /onRetry/.test(error.message),
    );
    assert.equal(requests.length, 0);
  });
}

test('approval and question waits start polls at least 1 s apart when the server answers pending at once', async (t) => {
  fakeTime(t);
  for (const loop of loops.slice(0, 2)) {
    const { pr, requests } = transport((n) => ({ body: n < 4 ? loop.pending(null) : loop.done }));
    const outcome = await settle(t, loop.run(pr), { stepMs: 50 });
    assert.ifError(outcome.error);
    assert.equal(requests.length, 4, loop.name);
    const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
    assert.ok(gaps.every((gap) => gap >= 1000), `${loop.name} poll gaps ${gaps.join(', ')} ms`);
    assert.ok(gaps.every((gap) => gap < 1100), `${loop.name} waited longer than the floor: ${gaps.join(', ')} ms`);
  }
});

test('the 1 s floor applies between pending polls only: a terminal answer returns at once', async (t) => {
  fakeTime(t);
  for (const loop of loops.slice(0, 2)) {
    const { pr, requests } = transport(() => ({ body: loop.done }));
    const outcome = await settle(t, loop.run(pr), { stepMs: 50 });
    assert.deepEqual(outcome.value, loop.done);
    assert.equal(outcome.at, START, loop.name);
    assert.equal(requests.length, 1);
  }
});

test('handoff waits keep their 2.1 s spacing', async (t) => {
  fakeTime(t);
  const loop = loops[2];
  const { pr, requests } = transport((n) => ({ body: n < 3 ? loop.pending(null) : loop.done }));
  const outcome = await settle(t, loop.run(pr, { timeout: 0 }), { stepMs: 50 });
  assert.ifError(outcome.error);
  const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
  assert.ok(gaps.every((gap) => gap >= 2100), `handoff poll gaps ${gaps.join(', ')} ms`);
});
