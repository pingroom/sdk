import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature, sendIncomingWebhook, PingRoomError } from '../dist/index.js';

const secret = 'whsec_test_123';
const rawBody = JSON.stringify({ event: 'ping', notification_id: 'n1', message: 'hi' });
const timestamp = String(Math.floor(Date.now() / 1000));
const deliveryId = 'delivery-test-1';
const hex = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
const v2Hex = createHmac('sha256', secret)
  .update(`v2\n${timestamp}\n${deliveryId}\n${rawBody}`)
  .digest('hex');

test('verifyWebhookSignature falls back to a valid legacy sha256= signature', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: `sha256=${hex}`, timestamp, secret }), true);
});

test('verifyWebhookSignature falls back to legacy bare hex without prefix', async () => {
  assert.equal(await verifyWebhookSignature({ payload: rawBody, signature: hex, timestamp, secret }), true);
});

test('verifyWebhookSignature accepts a delivery-bound v2 signature', async () => {
  assert.equal(await verifyWebhookSignature({
    payload: rawBody,
    signatureV2: v2Hex,
    timestamp,
    deliveryId,
    secret,
  }), true);
});

test('verifyWebhookSignature does not downgrade to valid v1 when a supplied v2 signature fails', async () => {
  assert.equal(await verifyWebhookSignature({
    payload: rawBody,
    signature: hex,
    signatureV2: '0'.repeat(64),
    timestamp,
    deliveryId,
    secret,
  }), false);
});

test('changing only the delivery id invalidates v2 but not legacy v1', async () => {
  assert.equal(await verifyWebhookSignature({
    payload: rawBody,
    signature: hex,
    timestamp,
    deliveryId: 'delivery-tampered',
    secret,
  }), true);
  assert.equal(await verifyWebhookSignature({
    payload: rawBody,
    signature: hex,
    signatureV2: v2Hex,
    timestamp,
    deliveryId: 'delivery-tampered',
    secret,
  }), false);
});

test('verifyWebhookSignature requires a safe delivery id whenever v2 is supplied', async () => {
  for (const invalidDeliveryId of [undefined, '', 'delivery\ninjected']) {
    assert.equal(await verifyWebhookSignature({
      payload: rawBody,
      signature: hex,
      signatureV2: v2Hex,
      timestamp,
      deliveryId: invalidDeliveryId,
      secret,
    }), false);
  }
});

test('verifyWebhookSignature accepts a Uint8Array payload', async () => {
  const bytes = new TextEncoder().encode(rawBody);
  assert.equal(await verifyWebhookSignature({ payload: bytes, signature: hex, timestamp, secret }), true);
});

test('verifyWebhookSignature preserves non-UTF-8 raw body bytes', async () => {
  const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x61]);
  const byteHexV1 = createHmac('sha256', secret)
    .update(Buffer.from(`${timestamp}.`))
    .update(bytes)
    .digest('hex');
  const byteHexV2 = createHmac('sha256', secret)
    .update(Buffer.from(`v2\n${timestamp}\n${deliveryId}\n`))
    .update(bytes)
    .digest('hex');
  assert.equal(await verifyWebhookSignature({ payload: bytes, signature: byteHexV1, timestamp, secret }), true);
  assert.equal(await verifyWebhookSignature({
    payload: bytes,
    signatureV2: byteHexV2,
    timestamp,
    deliveryId,
    secret,
  }), true);
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
  assert.equal(await verifyWebhookSignature({
    payload: rawBody,
    signature: hex,
    signatureV2: 'sha256=zzzz',
    timestamp,
    deliveryId,
    secret,
  }), false);
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
