import test from 'node:test';
import assert from 'node:assert/strict';
import { liveStatus } from '../dist/index.js';

test('liveStatus builders stamp their template and pass content through', () => {
  assert.deepEqual(
    liveStatus.progress('deploy-1', { state: 'running', progress: 0.4, message: 'Building' }),
    {
      correlation_id: 'deploy-1',
      live_status: { template: 'progress', state: 'running', progress: 0.4, message: 'Building' },
    },
  );
});

test('liveStatus.steps carries its labels', () => {
  const ping = liveStatus.steps('rel-1', { state: 'running', steps: ['Build', 'Ship'], current_step: 0 });
  assert.equal(ping.live_status.template, 'steps');
  assert.deepEqual(ping.live_status.steps, ['Build', 'Ship']);
});

test('liveStatus.alert sets the category, not a template', () => {
  // `alert` has no template equivalent and is the only way to start a stream
  // time-sensitive without also demanding an acknowledgement.
  const ping = liveStatus.alert('incident-1', { state: 'running', message: '5xx climbing' });
  assert.equal(ping.live_status.category, 'alert');
  assert.equal(ping.live_status.template, undefined);
});

test('liveStatus terminal builders stay sparse', () => {
  // The server merges a terminal leg over the stored stream, so a bare
  // {state: done} keeps the scoreboard/metrics on the final frame.
  assert.deepEqual(liveStatus.done('deploy-1', 'Live'), {
    correlation_id: 'deploy-1',
    live_status: { state: 'done', message: 'Live' },
  });
  assert.deepEqual(liveStatus.failed('deploy-1').live_status, { state: 'failed' });
});

test('liveStatus builders merge the rest of the ping body', () => {
  const ping = liveStatus.status('c1', { state: 'running' }, { title: 'Deploy', action: 2, requires_ack: true });
  assert.equal(ping.title, 'Deploy');
  assert.equal(ping.action, 2);
  assert.equal(ping.requires_ack, true);
});

test('liveStatus covers every template the server validates', () => {
  // Kept in lockstep with App\Support\LiveStatusRules::rules()'s
  // live_status.template enum — a builder missing here is a template no SDK
  // caller can discover.
  for (const template of ['status', 'steps', 'progress', 'metrics', 'countdown', 'question', 'matchup']) {
    assert.equal(typeof liveStatus[template], 'function', `missing builder: ${template}`);
    assert.equal(liveStatus[template]('c', { state: 'running' }).live_status.template, template);
  }
});
