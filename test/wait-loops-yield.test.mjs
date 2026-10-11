import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SDK_URL = new URL('../dist/index.js', import.meta.url).href;

function subprocess(script) {
  // A regressed loop starves timers, including node:test's own timeout. The
  // parent must enforce this bound outside the child event loop.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Each loop polls a transport that answers immediately with a non-terminal
// result. A timer aborts the signal; the loop must yield for it to fire.
function abortableLoop(body, call) {
  return subprocess(`
    import { PingRoom } from ${JSON.stringify(SDK_URL)};
    const controller = new AbortController();
    const reason = new Error('stop this wait');
    let polls = 0;
    let timer;
    const client = new PingRoom({
      token: 'synthetic-offline-token', baseUrl: 'https://wait-loops.invalid',
      fetch: async () => {
        polls++;
        if (polls === 2) timer = setTimeout(() => controller.abort(reason), 100);
        return new Response(JSON.stringify(${JSON.stringify(body)}));
      },
    });
    let threw = null;
    try {
      ${call}
    } catch (error) {
      threw = error;
    } finally {
      clearTimeout(timer);
    }
    process.stdout.write(JSON.stringify({ cancelled: controller.signal.aborted, sameReason: threw === reason, threw: threw !== null, polls }));
  `);
}

test('immediately pending question polls allow timer-driven cancellation', () => {
  const result = abortableLoop(
    { id: 'offline', state: 'pending' },
    `await client.questions.waitForAnswer('offline', { signal: controller.signal });`,
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.sameReason, true);
  assert.ok(result.polls >= 2);
});

test('immediately pending handoff polls allow timer-driven cancellation', () => {
  const result = abortableLoop(
    { id: 'offline', kind: 'ack', state: 'pending' },
    `await client.handoffs.waitForResult('offline', { signal: controller.signal });`,
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.sameReason, true);
  assert.ok(result.polls >= 2);
});

test('immediately empty listen batches allow timer-driven cancellation', () => {
  const result = abortableLoop(
    { notifications: [], cursor: 'c1' },
    `for await (const _ of client.notifications.listen({ after: 'c0', signal: controller.signal })) {}`,
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.threw, false);
  assert.ok(result.polls >= 2);
});
