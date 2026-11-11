import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PING_ACTION_ERROR_CODES, PingRoom, PingRoomError, pingAction, sendIncomingWebhook, verifyWebhookSignature } from '../dist/index.js';
import { recorder } from './helpers.mjs';

const OPEN = { label: 'Open dashboard', type: 'open_url', url: 'https://grafana.example.com/d/disk' };
const HOOK = { id: 'clean', label: 'Clean up now', type: 'webhook', url: 'https://ops.example.com/cleanup', body: { host: 'db-2' }, style: 'danger' };

function client(response = { id: 'n1', message: 'x', created_at: 'now' }, status = 201) {
  const { calls, fetchMock } = recorder({ '*': () => ({ status, body: response }) });
  return { calls, pr: new PingRoom({ token: 't', fetch: fetchMock }) };
}

function refusedLocally(error, pattern) {
  assert.ok(error instanceof PingRoomError, `expected a PingRoomError, got ${error}`);
  assert.equal(error.code, 'invalid_data');
  if (pattern) assert.match(error.message, pattern);
  return true;
}

test('pingAction builds the wire objects data.actions takes', () => {
  assert.deepEqual(
    pingAction.openUrl('Open dashboard', 'https://grafana.example.com/d/disk'),
    { label: 'Open dashboard', type: 'open_url', url: 'https://grafana.example.com/d/disk' },
  );
  assert.deepEqual(
    pingAction.webhook('Clean up now', 'https://ops.example.com/cleanup', { id: 'clean', style: 'danger', body: { host: 'db-2' } }),
    { label: 'Clean up now', type: 'webhook', url: 'https://ops.example.com/cleanup', id: 'clean', style: 'danger', body: { host: 'db-2' } },
  );
  // The label every recipient sees: NFC, spaces collapsed, trimmed.
  assert.equal(pingAction.openUrl('  Open  it ', 'https://example.com/').label, 'Open it');
});

test('pingAction refuses what the server would refuse, before any request', () => {
  assert.throws(() => pingAction.openUrl('paypal.com', 'https://evil.example.com/'), (e) => refusedLocally(e, /web address, domain name or IP/));
  assert.throws(() => pingAction.openUrl('👍 Pong Back', 'https://example.com/'), (e) => refusedLocally(e, /PingRoom's own buttons/));
  assert.throws(() => pingAction.openUrl('Pay ‮lapyap', 'https://example.com/'), (e) => refusedLocally(e, /invisible formatting/));
  assert.throws(() => pingAction.openUrl('Go', 'http://example.com/'), (e) => refusedLocally(e, /https:\/\//));
  assert.throws(() => pingAction.openUrl('Go', 'https://paypal.com@evil.example.com/'), (e) => refusedLocally(e, /plain hostname/));
  assert.throws(() => pingAction.openUrl('Go', 'https://pаypal.com/'), (e) => refusedLocally(e, /punycode/));
  assert.throws(() => pingAction.openUrl('Go', 'https://127.0.0.1/'), (e) => refusedLocally(e, /public hostname/));
  assert.throws(() => pingAction.webhook('Run', 'https://ops.example.com:8443/'), (e) => refusedLocally(e, /cannot name a port/));
  assert.throws(() => pingAction.webhook('Run', 'https://db.internal/'), (e) => refusedLocally(e, /public hostname/));
  assert.throws(() => pingAction.webhook('Run', 'https://ops.example.com/', { body: ['x'] }), (e) => refusedLocally(e, /JSON object/));
  assert.throws(() => pingAction.webhook('Run', 'https://ops.example.com/', { body: { x: 'é'.repeat(200) } }), (e) => refusedLocally(e, /1024 bytes/));
  assert.throws(() => pingAction.openUrl('Go', 'https://example.com/', { id: 'Bad Id' }), (e) => refusedLocally(e, /button id/));
  assert.throws(() => pingAction.openUrl('Go', 'https://example.com/', { style: 'red' }), (e) => refusedLocally(e, /style/));
  assert.throws(() => pingAction.openUrl('Go', 'https://example.com/', { body: { x: 1 } }), (e) => refusedLocally(e, /only a webhook button takes a body/));
});

test('broadcast sends buttons in data.actions and resolves with the signing secret', async () => {
  const response = {
    id: 'n1', message: 'Disk 91%', created_at: 'now',
    actions: [{ ...OPEN, id: 'a1', style: 'default', host: 'grafana.example.com' }, { id: 'clean', label: 'Clean up now', type: 'webhook', style: 'danger' }],
    actions_expire_at: '2026-11-12T10:00:00+00:00',
    action_runs: [],
    action_signing_secret: 'ab'.repeat(32),
  };
  const { calls, pr } = client(response);
  const result = await pr.broadcast('AB12', {
    message: 'Disk 91%',
    data: { actions: [pingAction.openUrl(OPEN.label, OPEN.url), pingAction.webhook(HOOK.label, HOOK.url, { id: 'clean', style: 'danger', body: { host: 'db-2' } })] },
  });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.data.actions, [OPEN, { label: HOOK.label, type: 'webhook', url: HOOK.url, id: 'clean', style: 'danger', body: { host: 'db-2' } }]);
  assert.equal(result.action_signing_secret, 'ab'.repeat(32));
  assert.equal(result.actions[1].url, undefined);
});

test('broadcast refuses invalid raw data.actions locally, naming every field', async () => {
  const { calls, pr } = client();
  await assert.rejects(
    async () => pr.broadcast('AB12', { message: 'x', data: { actions: [{ label: 'paypal.com', type: 'open_url', url: 'http://x' }] } }),
    (e) => refusedLocally(e, /data\.actions\.0\.label: .*data\.actions\.0\.url:/),
  );
  await assert.rejects(async () => pr.broadcast('AB12', { message: 'x', data: { actions: [OPEN, OPEN, OPEN, OPEN] } }), (e) => refusedLocally(e, /1 to 3 buttons/));
  await assert.rejects(async () => pr.broadcast('AB12', { message: 'x', data: { actions: [{ ...OPEN, id: 'x' }, { ...OPEN, id: 'x' }] } }), (e) => refusedLocally(e, /data\.actions\.1\.id: Each button on a Ping needs its own id/));
  await assert.rejects(async () => pr.broadcast('AB12', { message: 'x', data: { actions: [{ ...OPEN, method: 'POST' }] } }), (e) => refusedLocally(e, /Unknown button field: method/));
  await assert.rejects(async () => pr.broadcast('AB12', { message: 'x', data: { actions: {} } }), (e) => refusedLocally(e, /must be a list/));
  assert.equal(calls.length, 0);
  // `null` is absent, as on the server.
  await pr.broadcast('AB12', { message: 'x', data: { actions: null } });
  assert.equal(calls.length, 1);
});

test('the doors that never carry buttons refuse data.actions before the request', async () => {
  const { calls, pr } = client({ id: 'q', state: 'pending' });
  const data = { actions: [OPEN] };
  const doors = [
    ['A replacement', () => pr.notifications.replace('AB12', 'n1', { message: 'x', data })],
    ['A Question', () => pr.questions.ask('AB12', { prompt: 'Ship?', data })],
    ['An approval', () => pr.approvals.request('AB12', { question: 'Ship?', data })],
    ['A handoff', () => pr.handoffs.requestAck({ prompt: 'Look', data })],
    ['A handoff', () => pr.handoffs.ask({ prompt: 'Which?', options: ['a', 'b'], data })],
    ['A live-progress stream', () => pr.live.push('AB12', { correlation_id: 'c1', live_status: { state: 'active', message: 'x' }, data })],
  ];
  for (const [where, send] of doors) {
    await assert.rejects(async () => send(), (e) => refusedLocally(e, new RegExp(`^${where} cannot carry buttons`)));
  }
  // A quick-action press already takes only location and url.
  await assert.rejects(async () => pr.actions.trigger('AB12', 2, { data }), (e) => e instanceof PingRoomError && /data\.actions/.test(e.message));
  assert.equal(calls.length, 0);
});

test('sendIncomingWebhook carries buttons on an ordinary Ping and refuses them on a stream', async () => {
  const { calls, fetchMock } = recorder({ '*': () => ({ body: { success: true, notification_id: 'n1', actions: [{ id: 'clean', label: 'Clean up now', type: 'webhook', style: 'danger' }], action_signing_secret: 'cd'.repeat(32) } }) });
  const url = 'https://api.example.test/api/webhooks/AB12/secret';
  const result = await sendIncomingWebhook(url, { message: 'Disk 91%', data: { actions: [HOOK] } }, { fetch: fetchMock });
  assert.deepEqual(JSON.parse(calls[0].init.body).data.actions, [HOOK]);
  assert.equal(result.action_signing_secret, 'cd'.repeat(32));

  await assert.rejects(
    async () => sendIncomingWebhook(url, { data: { actions: [HOOK] }, live_status: { state: 'active', message: 'x' }, correlation_id: 'c' }, { fetch: fetchMock }),
    (e) => refusedLocally(e, /live-progress stream cannot carry buttons/),
  );
  await assert.rejects(
    async () => sendIncomingWebhook(url, { message: 'x', data: { actions: [{ ...HOOK, url: 'https://10.0.0.5/' }] } }, { fetch: fetchMock }),
    (e) => refusedLocally(e, /public hostname/),
  );
  assert.equal(calls.length, 1);
});

test('a button delivery verifies with verifyWebhookSignature and the Ping\'s secret', async () => {
  // The bytes and headers PingRoom's Worker sends a webhook button's URL.
  const secret = '81a29861609a0f98edae7253d871a336aa20ef1df78d1dac0da521d983b54623';
  const payload = JSON.stringify({
    event: 'notification.action', notification_id: '9b2f5c1e-0000-4000-8000-000000000001', action_id: 'clean',
    room: { code: 'AB12CD', name: 'Ops' }, actor: { id: '0123456789abcdef0123456789abcdef', display_name: 'Sam' },
    correlation_id: null, body: { host: 'db-2' }, timestamp: '2026-11-11T10:00:00+00:00',
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const deliveryId = '6c5b1a2e-0000-4000-8000-00000000000a';
  const signatureV2 = createHmac('sha256', secret).update(`v2\n${timestamp}\n${deliveryId}\n${payload}`).digest('hex');

  assert.equal(await verifyWebhookSignature({ payload, signatureV2, timestamp, deliveryId, secret, requireV2: true }), true);
  assert.equal(await verifyWebhookSignature({ payload, signatureV2, timestamp, deliveryId, secret: 'ff'.repeat(32), requireV2: true }), false);
  assert.equal(await verifyWebhookSignature({ payload: payload.replace('db-2', 'db-3'), signatureV2, timestamp, deliveryId, secret, requireV2: true }), false);
  assert.equal(await verifyWebhookSignature({ payload, signatureV2, timestamp: String(Number(timestamp) - 3600), deliveryId, secret, requireV2: true }), false);
});

test('every button refusal surfaces its status and code on the error', async () => {
  const refusals = [
    [422, 'ping_buttons_agents_only'],
    [422, 'ping_buttons_unsupported_room'],
    [422, 'ping_buttons_with_ack'],
    [403, 'ping_buttons_require_pro'],
  ];
  assert.deepEqual(refusals.map(([, code]) => code), [...PING_ACTION_ERROR_CODES]);
  for (const [status, code] of refusals) {
    const pr = new PingRoom({ token: 't', fetch: async () => new Response(JSON.stringify({ code, message: code }), { status }) });
    await assert.rejects(
      () => pr.broadcast('AB12', { message: 'x', data: { actions: [OPEN] } }),
      (error) => error instanceof PingRoomError && error.status === status && error.code === code,
    );
  }
});

// The codes are the server's own: each must be spelled in PingActionRules.
const RULES_PATH = fileURLToPath(new URL('../../laravel/app/Support/PingActionRules.php', import.meta.url));
test('the button error codes exist on the server', { skip: existsSync(RULES_PATH) ? false : 'laravel/ is not checked out beside sdk/' }, () => {
  const source = readFileSync(RULES_PATH, 'utf8');
  for (const code of PING_ACTION_ERROR_CODES) {
    assert.ok(source.includes(`'${code}'`), `${code} is not a code in laravel/app/Support/PingActionRules.php`);
  }
});
