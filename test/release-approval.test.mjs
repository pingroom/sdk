import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PingRoom } from '../dist/index.js';
import { releaseWithApproval, ReleaseApprovalError, ReleaseExecutionError } from '../examples/release-approval/gate.mjs';
import { createOfflineClient, DEMO_ORIGIN, DEMO_TOKEN, waitUntilAborted } from '../examples/release-approval/mock-transport.mjs';

const DEMO = fileURLToPath(new URL('../examples/release-approval/demo.mjs', import.meta.url));
const BYTES = Buffer.from([0, 1, 2, 3, 127, 128, 254, 255]);

async function fixture(t, transport = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'release-approval-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifactPath = join(directory, 'release.bin');
  await writeFile(artifactPath, BYTES);
  const { client, calls } = createOfflineClient(transport);
  const actions = [];
  const input = {
    client, room: 'DEMO', artifactPath, destination: 'test-staging', timeoutMs: 2000,
    async execute(action) { actions.push(action); },
  };
  return { directory, artifactPath, calls, actions, input };
}

function blocked(code) {
  return (error) => error instanceof ReleaseApprovalError && error.code === code;
}

test('approval executes once with the exact verified bytes and full visible binding', async (t) => {
  const f = await fixture(t);
  f.input.execute = async (action) => {
    // Changing the pathname inside the callback must not change what it gets.
    await writeFile(f.artifactPath, 'replacement after verification');
    f.actions.push(action);
  };
  const result = await releaseWithApproval(f.input);
  assert.equal(result.outcome, 'executed');
  assert.equal(f.actions.length, 1);
  assert.deepEqual(f.actions[0].bytes, BYTES);
  const sha256 = createHash('sha256').update(BYTES).digest('hex');
  assert.equal(f.actions[0].sha256, sha256);
  assert.equal(f.actions[0].destination, 'test-staging');
  const request = f.calls[0].body;
  assert.ok(request.question.includes(sha256));
  assert.ok(request.question.includes('release.bin'));
  assert.ok(request.question.includes('test-staging'));
  assert.ok(Array.from(request.question).length <= 500);
  assert.deepEqual(request.options, ['approve', 'deny']);
  assert.deepEqual(f.calls.map(({ method }) => method), ['POST', 'GET']);
  assert.equal(f.actions[0].signal.aborted, false);
});

test('separate attempts use distinct correlation identifiers', async (t) => {
  const f = await fixture(t);
  await releaseWithApproval(f.input);
  await releaseWithApproval(f.input);
  assert.notEqual(f.calls[0].body.correlation_id, f.calls[2].body.correlation_id);
});

test('a decided denial, expiry, and remote cancellation do not execute', async (t) => {
  for (const scenario of ['denied', 'expired', 'cancelled']) {
    const f = await fixture(t, {
      decision: 'deny',
      onWait: scenario === 'denied' ? undefined : (approval) => ({ ...approval, status: scenario, decision: null, decided_at: null }),
    });
    await assert.rejects(releaseWithApproval(f.input), blocked(scenario));
    assert.equal(f.actions.length, 0);
  }
});

test('changed bytes after the request cannot use the old approval', async (t) => {
  let path;
  const f = await fixture(t, { async onWait(approval) { await writeFile(path, Buffer.alloc(BYTES.length, 42)); return approval; } });
  path = f.artifactPath;
  await assert.rejects(releaseWithApproval(f.input), blocked('changed'));
  assert.equal(f.actions.length, 0);
});

test('created and decided envelopes must match every request binding', async (t) => {
  const corruptions = [
    (a) => ({ ...a, id: '' }),
    (a) => ({ ...a, room_code: 'OTHER' }),
    (a) => ({ ...a, correlation_id: 'different-attempt' }),
    (a) => ({ ...a, question: 'A different question?' }),
    (a) => ({ ...a, title: 'Different title' }),
    (a) => ({ ...a, options: ['approve', 'other'] }),
    (a) => ({ ...a, options: ['deny', 'approve'] }),
    (a) => ({ ...a, options: ['approve', 'deny', 'extra'] }),
    (a) => ({ ...a, data: null }),
    (a) => ({ ...a, data: { ...a.data, sha256: '0'.repeat(64) } }),
    (a) => ({ ...a, data: { ...a.data, destination: 'production' } }),
    (a) => ({ ...a, data: { ...a.data, artifact_name: 'other.bin' } }),
  ];
  for (const stage of ['onCreate', 'onWait']) {
    for (const corrupt of corruptions) {
      const f = await fixture(t, { [stage]: corrupt });
      await assert.rejects(releaseWithApproval(f.input), blocked('invalid_approval'));
      assert.equal(f.actions.length, 0);
      assert.equal(f.calls.length, stage === 'onCreate' ? 1 : 2);
    }
  }
  const wrongId = await fixture(t, { onWait: (a) => ({ ...a, id: 'another-valid-id' }) });
  await assert.rejects(releaseWithApproval(wrongId.input), blocked('invalid_approval'));
  assert.equal(wrongId.actions.length, 0);
});

test('a decision requires exact decided status and a permitted decision', async (t) => {
  const mutations = [
    { status: 'approved' }, { status: 'denied' }, { status: 'pending' },
    { status: 'unknown' }, { decision: 'Approve' }, { decision: null },
    { decision: 'allow' }, { status: 'expired', decision: 'approve' },
  ];
  for (const mutation of mutations) {
    const f = await fixture(t, { onWait: (a) => ({ ...a, ...mutation }) });
    await assert.rejects(releaseWithApproval(f.input), blocked('invalid_approval'));
    assert.equal(f.actions.length, 0);
  }
  const earlyDecision = await fixture(t, { onCreate: (a) => ({ ...a, status: 'decided', decision: 'approve' }) });
  await assert.rejects(releaseWithApproval(earlyDecision.input), blocked('invalid_approval'));
  assert.equal(earlyDecision.actions.length, 0);
});

test('malformed, stale, future, and changed timestamps fail closed', async (t) => {
  for (const value of [null, 'yesterday', '2026-02-30T12:00:00Z', '2026-10-10T12:00:00', '2026-10-10T99:00:00Z']) {
    const f = await fixture(t, { onWait: (a) => ({ ...a, decided_at: value }) });
    await assert.rejects(releaseWithApproval(f.input), blocked('invalid_approval'));
    assert.equal(f.actions.length, 0);
  }
  for (const mutation of [
    (a) => ({ ...a, decided_at: '2000-01-01T00:00:00Z' }),
    (a) => ({ ...a, decided_at: new Date(Date.now() + 120000).toISOString() }),
    (a) => ({ ...a, expires_at: new Date(Date.parse(a.expires_at) + 1000).toISOString() }),
  ]) {
    const f = await fixture(t, { onWait: mutation });
    await assert.rejects(releaseWithApproval(f.input), blocked('invalid_approval'));
    assert.equal(f.actions.length, 0);
  }
  for (const expiry of ['invalid', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 86400000).toISOString()]) {
    const f = await fixture(t, { onCreate: (a) => ({ ...a, expires_at: expiry }) });
    await assert.rejects(releaseWithApproval(f.input), blocked('invalid_approval'));
    assert.equal(f.actions.length, 0);
  }
});

test('whole-second decisions tolerate small server clock differences without extending expiry', async (t) => {
  for (const skewMs of [-1000, 2000]) {
    const f = await fixture(t, {
      onWait: (a) => ({ ...a, decided_at: new Date(Math.floor(Date.now() / 1000) * 1000 + skewMs).toISOString() }),
    });
    const result = await releaseWithApproval(f.input);
    assert.equal(result.outcome, 'executed');
    assert.equal(f.actions.length, 1);
  }
  let expiry;
  const expired = await fixture(t, {
    onCreate(a) { expiry = new Date(Date.now() + 250).toISOString(); return { ...a, expires_at: expiry }; },
    async onWait(a) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now()) + 20));
      return { ...a, expires_at: expiry, decided_at: expiry };
    },
  });
  await assert.rejects(releaseWithApproval(expired.input), blocked('expired'));
  assert.equal(expired.actions.length, 0);
});

test('transport failure and malformed JSON never reach the action', async (t) => {
  // A dropped connection is transient: the SDK retries the wait with backoff
  // until the gate's own deadline ends it, and the action never starts.
  const disconnected = await fixture(t, { onWait() { throw new Error('simulated disconnected transport'); } });
  await assert.rejects(releaseWithApproval({ ...disconnected.input, timeoutMs: 1500 }), blocked('timeout'));
  assert.equal(disconnected.actions.length, 0);
  assert.ok(disconnected.calls.length >= 3, `expected the wait to be retried, saw ${disconnected.calls.length} calls`);
  assert.deepEqual(disconnected.calls.slice(1).map(({ method }) => method), Array(disconnected.calls.length - 1).fill('GET'));
  for (const stage of ['POST', 'GET']) {
    const f = await fixture(t);
    const offline = createOfflineClient();
    const client = new PingRoom({
      token: DEMO_TOKEN, baseUrl: DEMO_ORIGIN,
      fetch: (url, init) => init.method === stage ? Promise.resolve(new Response('not JSON')) : offline.fetch(url, init),
    });
    await assert.rejects(releaseWithApproval({ ...f.input, client }), blocked('invalid_approval'));
    assert.equal(f.actions.length, 0);
  }
});

test('the overall deadline bounds a stalled create without starting an action', async (t) => {
  let lateCreateFinished = false;
  const f = await fixture(t, {
    async onCreate(approval) {
      await new Promise((resolve) => setTimeout(resolve, 650));
      lateCreateFinished = true;
      return approval;
    },
  });
  const started = performance.now();
  await assert.rejects(releaseWithApproval({ ...f.input, timeoutMs: 500 }), blocked('timeout'));
  assert.ok(performance.now() - started < 1500);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(lateCreateFinished, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.actions.length, 0);
});

test('timeout and caller cancellation stop the wait and never start an action', async (t) => {
  for (const scenario of ['timeout', 'cancelled']) {
    const controller = new AbortController();
    let waitSignal;
    const f = await fixture(t, {
      onWait(_approval, signal) {
        waitSignal = signal;
        if (scenario === 'cancelled') controller.abort();
        return waitUntilAborted(signal);
      },
    });
    await assert.rejects(releaseWithApproval({ ...f.input, signal: controller.signal, timeoutMs: 500 }), blocked(scenario));
    assert.equal(waitSignal.aborted, true);
    assert.equal(f.actions.length, 0);
  }
  const f = await fixture(t);
  await assert.rejects(releaseWithApproval({ ...f.input, signal: AbortSignal.abort() }), blocked('cancelled'));
  assert.equal(f.calls.length, 0);
});

test('only bounded regular files reach the approval request', async (t) => {
  const f = await fixture(t);
  const directoryPath = join(f.directory, 'subdir');
  await mkdir(directoryPath);
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(1024 * 1024 + 1)]) {
    await writeFile(f.artifactPath, bytes);
    await assert.rejects(releaseWithApproval(f.input), blocked('invalid_artifact'));
  }
  await assert.rejects(releaseWithApproval({ ...f.input, artifactPath: directoryPath }), blocked('invalid_artifact'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.actions.length, 0);
});

test('invalid destination, name, and deadline are rejected before requesting approval', async (t) => {
  const f = await fixture(t);
  for (const destination of ['', 'a\nb', 'a'.repeat(121), ' target ']) {
    await assert.rejects(releaseWithApproval({ ...f.input, destination }), blocked('invalid_input'));
  }
  for (const timeoutMs of [0, -1, Infinity, 1.5, 300001]) {
    await assert.rejects(releaseWithApproval({ ...f.input, timeoutMs }), blocked('invalid_input'));
  }
  await assert.rejects(releaseWithApproval({ ...f.input, signal: {} }), blocked('invalid_input'));
  await assert.rejects(releaseWithApproval({ ...f.input, artifactPath: join(f.directory, 'bad\nname') }), blocked('invalid_input'));
  assert.equal(f.calls.length, 0);
});

test('an action failure is reported as started and is never retried', async (t) => {
  const f = await fixture(t);
  const failure = new Error('simulated action failed after a side effect');
  f.input.execute = async (action) => { f.actions.push(action); throw failure; };
  await assert.rejects(releaseWithApproval(f.input), (error) => error instanceof ReleaseExecutionError && error.actionStarted && error.cause === failure);
  assert.equal(f.actions.length, 1);
  assert.equal(f.calls.length, 2);
});

test('a deadline after action start cannot be reported as an approval block', async (t) => {
  const f = await fixture(t);
  f.input.execute = async (action) => { f.actions.push(action); await waitUntilAborted(action.signal); };
  await assert.rejects(releaseWithApproval({ ...f.input, timeoutMs: 500 }), (error) => error instanceof ReleaseExecutionError && error.actionStarted && error.cause.code === 'timeout');
  assert.equal(f.actions.length, 1);
});

test('offline demo scenarios ignore real-looking environment credentials and never call global fetch', async (t) => {
  const f = await fixture(t);
  const preload = join(f.directory, 'no-network.mjs');
  await writeFile(preload, 'globalThis.fetch = async () => { throw new Error("GLOBAL_FETCH_WAS_CALLED"); };');
  const reasons = { deny: 'denied', expire: 'expired', changed: 'changed', cancel: 'cancelled', timeout: 'timeout', mismatch: 'invalid_approval' };
  for (const scenario of ['approve', ...Object.keys(reasons)]) {
    const result = spawnSync(process.execPath, ['--import', preload, DEMO, scenario], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PINGROOM_TOKEN: 'private-test-token', PINGROOM_API_URL: 'https://private-target.invalid', PINGROOM_WEBHOOK_URL: 'https://private-target.invalid/secret' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /OFFLINE DEMO/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-test-token|private-target|GLOBAL_FETCH/);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.offline, true);
    assert.equal(outcome.actionCount, scenario === 'approve' ? 1 : 0);
    assert.equal(outcome.outcome, scenario === 'approve' ? 'executed' : 'blocked');
    if (scenario !== 'approve') assert.equal(outcome.reason, reasons[scenario]);
  }
  assert.equal(new URL(DEMO_ORIGIN).hostname.endsWith('.invalid'), true);
});
