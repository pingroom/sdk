import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseWithApproval, ReleaseApprovalError } from './gate.mjs';
import { createOfflineClient, waitUntilAborted } from './mock-transport.mjs';

const scenarios = ['approve', 'deny', 'expire', 'changed', 'cancel', 'timeout', 'mismatch'];
const scenario = process.argv[2] ?? 'approve';
if (process.argv.length > 3 || !scenarios.includes(scenario)) {
  process.stderr.write(`Usage: node examples/release-approval/demo.mjs [${scenarios.join('|')}]\n`);
  process.exitCode = 2;
} else {
  process.stderr.write('OFFLINE DEMO: decisions are simulated; no network, credentials, or real deployment is used.\n');
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-release-'));
  try {
    const artifactPath = join(directory, 'release.txt');
    await writeFile(artifactPath, 'An example release artifact.\n');
    const controller = new AbortController();
    const { client, calls } = createOfflineClient({
      decision: scenario === 'deny' ? 'deny' : 'approve',
      async onWait(approval, signal) {
        if (scenario === 'changed') await writeFile(artifactPath, 'Different bytes after the request.\n');
        if (scenario === 'expire') return { ...approval, status: 'expired', decision: null, decided_at: null };
        if (scenario === 'mismatch') return { ...approval, data: { ...approval.data, destination: 'unexpected-target' } };
        if (scenario === 'cancel') controller.abort();
        if (scenario === 'timeout' || scenario === 'cancel') return waitUntilAborted(signal);
        return approval;
      },
    });
    let actionCount = 0;
    let copiedBytes = 0;
    let result;
    try {
      result = await releaseWithApproval({
        client, room: 'DEMO', artifactPath, destination: 'demo-staging',
        timeoutMs: scenario === 'timeout' ? 100 : 60000, signal: controller.signal,
        async execute({ bytes }) {
          actionCount++;
          const copy = join(directory, 'simulated-release.txt');
          await writeFile(copy, bytes);
          copiedBytes = (await readFile(copy)).length;
        },
      });
    } catch (error) {
      if (!(error instanceof ReleaseApprovalError)) throw error;
      result = { outcome: 'blocked', reason: error.code };
    }
    process.stdout.write(`${JSON.stringify({ offline: true, scenario, ...result, question: calls[0]?.body?.question ?? null, actionCount, copiedBytes, apiCalls: calls.length })}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
