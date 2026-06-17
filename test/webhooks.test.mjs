import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature, sendIncomingWebhook, PingRoomError } from '../dist/index.js';

const secret = 'whsec_test_123';
const rawBody = JSON.stringify({ event: 'ping', notification_id: 'n1', message: 'hi' });
const hex = createHmac('sha256', secret).update(rawBody).digest('hex');

test('verifyWebhookSignature accepts a valid sha256= signature', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: `sha256=${hex}`, secret }), true);
});

test('verifyWebhookSignature accepts bare hex without prefix', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: hex, secret }), true);
});

test('verifyWebhookSignature accepts a Uint8Array payload', async () => {
  const bytes = new TextEncoder().encode(rawBody);
  assert.equal(await verifyWebhookSignature({ payload: bytes, signature: hex, secret }), true);
});

test('verifyWebhookSignature rejects a tampered body', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody + ' ', signature: hex, secret }), false);
});

test('verifyWebhookSignature rejects the wrong secret', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: hex, secret: 'nope' }), false);
});

test('verifyWebhookSignature rejects missing or malformed signatures', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: undefined, secret }), false);
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: '', secret }), false);
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: 'sha256=zzzz', secret }), false);
});

test('sendIncomingWebhook posts JSON and returns the result', async () => {
  let captured;
  const fetchMock = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ success: true, notification_id: 'n9' }), { status: 201 });
  };
  const res = await sendIncomingWebhook(
    'https://api.pingroom.io/api/webhooks/AB12/secret',
    { message: 'hi', action: 2, data: { a: 1 } },
    { fetch: fetchMock, idempotencyKey: 'k1' },
  );
  assert.equal(res.notification_id, 'n9');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.url, 'https://api.pingroom.io/api/webhooks/AB12/secret');
  assert.equal(captured.init.headers['Idempotency-Key'], 'k1');
  assert.deepEqual(JSON.parse(captured.init.body), { message: 'hi', action: 2, data: { a: 1 } });
});

test('sendIncomingWebhook refuses an insecure URL', async () => {
  await assert.rejects(
    () => sendIncomingWebhook('http://evil.example.com/x', { message: 'x' }),
    (e) => e instanceof PingRoomError && e.code === 'insecure_url',
  );
});

test('sendIncomingWebhook validates the action slot', async () => {
  await assert.rejects(
    () => sendIncomingWebhook('https://api.pingroom.io/x', { action: 9 }, { fetch: async () => new Response('{}') }),
    (e) => e instanceof PingRoomError && e.code === 'invalid_request',
  );
});

test('sendIncomingWebhook throws PingRoomError with retryAfter on a failure body', async () => {
  const fetchMock = async () =>
    new Response(JSON.stringify({ success: false, error: 'cooldown_active', message: 'wait', retry_after: 5 }), {
      status: 429,
    });
  await assert.rejects(
    () => sendIncomingWebhook('https://api.pingroom.io/x', { message: 'hi' }, { fetch: fetchMock }),
    (e) => e instanceof PingRoomError && e.code === 'cooldown_active' && e.retryAfter === 5,
  );
});
