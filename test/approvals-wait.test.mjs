import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PingRoom } from '../dist/index.js';

const SDK_URL = new URL('../dist/index.js', import.meta.url).href;
const GATE_URL = new URL('../examples/release-approval/gate.mjs', import.meta.url).href;
const OFFLINE_URL = new URL('../examples/release-approval/mock-transport.mjs', import.meta.url).href;

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

test('immediately pending approval polls allow timer-driven cancellation', () => {
  const result = subprocess(`
    import { PingRoom } from ${JSON.stringify(SDK_URL)};
    const controller = new AbortController();
    const reason = new Error('stop this approval wait');
    let polls = 0;
    let timer;
    const client = new PingRoom({
      token: 'synthetic-offline-token', baseUrl: 'https://approval-demo.invalid',
      fetch: async () => {
        polls++;
        if (polls === 2) timer = setTimeout(() => controller.abort(reason), 100);
        return new Response(JSON.stringify({ id: 'offline', status: 'pending', decided_at: null }));
      },
    });
    try {
      await client.approvals.waitForDecision('offline', { signal: controller.signal });
      throw new Error('pending approval unexpectedly resolved');
    } catch (error) {
      process.stdout.write(JSON.stringify({ cancelled: controller.signal.aborted, sameReason: error === reason, polls }));
    } finally {
      clearTimeout(timer);
    }
  `);
  assert.equal(result.cancelled, true);
  assert.equal(result.sameReason, true);
  assert.ok(result.polls >= 2);
});

test('immediately pending approval polls respect the release gate deadline without executing', (t) => {
  // Parent ownership guarantees cleanup even when the watchdog kills a
  // regressed child before its own finally blocks could run.
  const directory = mkdtempSync(join(tmpdir(), 'approval-poll-deadline-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifactPath = join(directory, 'release.txt');
  writeFileSync(artifactPath, 'offline artifact');
  const result = subprocess(`
    import { releaseWithApproval, ReleaseApprovalError } from ${JSON.stringify(GATE_URL)};
    import { createOfflineClient } from ${JSON.stringify(OFFLINE_URL)};
    let polls = 0;
    let executions = 0;
    const { client } = createOfflineClient({
      onWait(approval) {
        polls++;
        return { ...approval, status: 'pending', decision: null, decided_at: null };
      },
    });
    try {
      await releaseWithApproval({
        client, room: 'DEMO', artifactPath: ${JSON.stringify(artifactPath)}, destination: 'test-staging', timeoutMs: 500,
        execute: async () => { executions++; },
      });
      throw new Error('pending approval unexpectedly released');
    } catch (error) {
      process.stdout.write(JSON.stringify({
        timedOut: error instanceof ReleaseApprovalError && error.code === 'timeout', polls, executions,
      }));
    }
  `);
  assert.equal(result.timedOut, true);
  assert.ok(result.polls >= 2);
  assert.equal(result.executions, 0);
});

test('approval polling still returns a decision after pending responses', async () => {
  const pending = { id: 'offline', status: 'pending', decision: null, decided_at: null };
  const decided = { ...pending, status: 'decided', decision: 'approve', decided_at: new Date().toISOString() };
  let polls = 0;
  const client = new PingRoom({
    token: 'synthetic-offline-token', baseUrl: 'https://approval-demo.invalid',
    fetch: async () => new Response(JSON.stringify(++polls < 3 ? pending : decided)),
  });
  assert.deepEqual(await client.approvals.waitForDecision('offline'), decided);
  assert.equal(polls, 3);
});

test('a terminal approval returns before another timer turn', async () => {
  for (const status of ['decided', 'expired', 'cancelled']) {
    const approval = { id: 'offline', status, decision: status === 'decided' ? 'deny' : null, decided_at: null };
    const client = new PingRoom({
      token: 'synthetic-offline-token', baseUrl: 'https://approval-demo.invalid',
      fetch: async () => new Response(JSON.stringify(approval)),
    });
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    try {
      assert.deepEqual(await client.approvals.waitForDecision('offline'), approval);
      assert.equal(timerRan, false, 'terminal responses should not wait for the pending-poll timer');
    } finally {
      clearTimeout(timer);
    }
  }
});
