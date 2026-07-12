import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature, sendIncomingWebhook, PingRoomError } from '../dist/index.js';

const secret = 'whsec_test_123';
const rawBody = JSON.stringify({ event: 'ping', notification_id: 'n1', message: 'hi' });
const timestamp = String(Math.floor(Date.now() / 1000));
const hex = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

test('verifyWebhookSignature accepts a valid sha256= signature', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: `sha256=${hex}`, timestamp, secret }), true);
});

test('verifyWebhookSignature accepts bare hex without prefix', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: hex, timestamp, secret }), true);
});

test('verifyWebhookSignature accepts a Uint8Array payload', async () => {
  const bytes = new TextEncoder().encode(rawBody);
  assert.equal(await verifyWebhookSignature({ payload: bytes, signature: hex, timestamp, secret }), true);
});

test('verifyWebhookSignature preserves non-UTF-8 raw body bytes', async () => {
  const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x61]);
  const byteHex = createHmac('sha256', secret)
    .update(Buffer.from(`${timestamp}.`))
    .update(bytes)
    .digest('hex');
  assert.equal(await verifyWebhookSignature({ payload: bytes, signature: byteHex, timestamp, secret }), true);
});

test('verifyWebhookSignature rejects a tampered body', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody + ' ', signature: hex, timestamp, secret }), false);
});

test('verifyWebhookSignature rejects a tampered or missing timestamp', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: hex, timestamp: String(Number(timestamp) - 1), secret }), false);
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: hex, timestamp: undefined, secret }), false);
});

test('verifyWebhookSignature rejects the wrong secret', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: hex, timestamp, secret: 'nope' }), false);
});

test('verifyWebhookSignature rejects missing or malformed signatures', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: undefined, timestamp, secret }), false);
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: '', timestamp, secret }), false);
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: 'sha256=zzzz', timestamp, secret }), false);
});

test('verifyWebhookSignature enforces the default and custom replay windows', async () => {
  const oldTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  const oldHex = createHmac('sha256', secret).update(`${oldTimestamp}.${rawBody}`).digest('hex');
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: oldHex, timestamp: oldTimestamp, secret }), false);
  assert.equal(await verifyWebhookSignature({
    payload: rawBody,
    signature: oldHex,
    timestamp: oldTimestamp,
    secret,
    maxAgeSeconds: 600,
  }), true);
});

test('sendIncomingWebhook posts JSON and returns the result', async () => {
  let captured;
  const fetchMock = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ success: true, notification_id: 'n9' }), { status: 201 });
  };
  const res = await sendIncomingWebhook(
    'https://api.pingroom.io/api/webhooks/AB12/secret',
    { message: 'hi', action: 2, data: { a: 1 }, requires_ack: true, ack_timeout_seconds: 120 },
    { fetch: fetchMock, idempotencyKey: 'k1' },
  );
  assert.equal(res.notification_id, 'n9');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.url, 'https://api.pingroom.io/api/webhooks/AB12/secret');
  assert.equal(captured.init.headers['Idempotency-Key'], 'k1');
  assert.deepEqual(JSON.parse(captured.init.body), {
    message: 'hi',
    action: 2,
    data: { a: 1 },
    requires_ack: true,
    ack_timeout_seconds: 120,
  });
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
