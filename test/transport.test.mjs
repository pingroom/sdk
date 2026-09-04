import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HttpClient } from '../dist/http.js';
import { PingRoomTimeoutError, sendIncomingWebhook } from '../dist/index.js';

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

for (const status of [307, 308]) {
  test(`HTTP ${status} cannot forward credentials or attachment/webhook bodies`, async (t) => {
    const received = [];
    const target = await serve(t, async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push({ body, authorization: req.headers.authorization });
      res.end('{"success":true}');
    });
    const source = await serve(t, (_req, res) => {
      res.writeHead(status, { Location: `${target}/collect` });
      res.end();
    });
    const client = new HttpClient({ baseUrl: source, token: 'fixture-token' });
    await assert.rejects(client.request('POST', '/auth', {
      auth: false, body: { assertion: 'fixture-identity-assertion' },
    }), { code: 'network_error' });
    await assert.rejects(client.request('POST', '/claim', {
      body: { email: 'fixture@example.test', otp: '123456' },
    }), { code: 'network_error' });
    const body = new FormData();
    body.append('file', new Blob(['fixture-private-attachment']), 'notes.txt');
    await assert.rejects(client.request('POST', '/attachments', { body }), { code: 'network_error' });
    await assert.rejects(sendIncomingWebhook(`${source}/hook/fixture-secret`, {
      message: 'fixture-private-message',
    }), { code: 'network_error' });
    assert.deepEqual(received, []);
  });
}

for (const transport of ['api', 'webhook', 'raw-error']) {
  test(`${transport} deadline includes a response body stalled after headers`, async (t) => {
    let headersSent = false;
    const baseUrl = await serve(t, (_req, res) => {
      res.writeHead(transport === 'raw-error' ? 503 : 200, { 'Content-Type': 'application/json' });
      res.flushHeaders();
      headersSent = true;
    });
    const signal = AbortSignal.timeout(1500); // bounds the test if the request deadline regresses
    const client = new HttpClient({ baseUrl, token: 'fixture-token', timeoutMs: 100 });
    const request = transport === 'webhook'
      ? sendIncomingWebhook(`${baseUrl}/hook`, {}, { timeoutMs: 100, signal })
      : transport === 'raw-error'
        ? client.raw('GET', '/content', { signal })
        : client.request('GET', '/rooms', { signal });
    await assert.rejects(request, (error) => error instanceof PingRoomTimeoutError && error.code === 'timeout');
    assert.equal(headersSent, true);
  });
}

test('aborting while reading JSON preserves the caller cancellation reason', async (t) => {
  const controller = new AbortController();
  const reason = new Error('fixture cancellation');
  const baseUrl = await serve(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    setTimeout(() => controller.abort(reason), 20);
  });
  const client = new HttpClient({ baseUrl, token: 'fixture-token', timeoutMs: 1000 });
  await assert.rejects(client.request('GET', '/rooms', { signal: controller.signal }), (error) => error === reason);
});

test('JSON body parsing retains API errors and completes before the deadline', async (t) => {
  const baseUrl = await serve(t, (req, res) => {
    res.writeHead(req.url === '/error' ? 403 : 200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    setTimeout(() => res.end(req.url === '/error' ? '{"code":"room_not_granted"}' : '{"success":true}'), 20);
  });
  const client = new HttpClient({ baseUrl, token: 'fixture-token', timeoutMs: 1000 });
  assert.deepEqual(await client.request('GET', '/ok'), { success: true });
  await assert.rejects(client.request('GET', '/error'), { status: 403, code: 'room_not_granted' });
  assert.deepEqual(await sendIncomingWebhook(`${baseUrl}/ok`, {}, { timeoutMs: 1000 }), { success: true });
  await assert.rejects(sendIncomingWebhook(`${baseUrl}/error`, {}, { timeoutMs: 1000 }), { status: 403, code: 'room_not_granted' });
});
