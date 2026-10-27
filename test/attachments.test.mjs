import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError } from '../dist/index.js';
import { recorder } from './helpers.mjs';

test('attachments.upload posts multipart and lets the runtime own the boundary', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/attachments': () => ({
      status: 201,
      body: {
        attachment: {
          id: 'att_1',
          filename: 'brief.pdf',
          mime_type: 'application/pdf',
          size_bytes: 5,
          created_at: '2026-08-10T08:00:00Z',
        },
      },
    }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  const attachment = await pr.attachments.upload({
    content: new Uint8Array([37, 80, 68, 70, 45]),
    filename: 'brief.pdf',
    contentType: 'application/pdf',
  });

  assert.equal(attachment.id, 'att_1');
  const { init } = calls[0];
  assert.ok(init.body instanceof FormData, 'body should be FormData');
  // Setting Content-Type ourselves would strip the generated boundary.
  assert.equal(init.headers['Content-Type'], undefined);
  assert.equal(init.headers['Authorization'], 'Bearer tok_abc');

  const part = init.body.get('file');
  assert.equal(part.name, 'brief.pdf');
  assert.equal(part.type, 'application/pdf');
  assert.equal(await part.text(), '%PDF-');
});

test('attachments.manifest returns a zip listing and null for a non-archive', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/attachments/att_zip/manifest': () => ({
      status: 200,
      body: {
        manifest: {
          entries: [
            { name: 'src', size_bytes: null, is_directory: true },
            { name: 'src/index.js', size_bytes: 300, is_directory: false },
          ],
          total_entries: 2,
          truncated: false,
          total_uncompressed_bytes: 300,
        },
      },
    }),
    'GET /api/agent/attachments/att_pdf/manifest': () => ({
      status: 200,
      body: { manifest: null },
    }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  const manifest = await pr.attachments.manifest('att_zip');
  assert.equal(manifest.total_entries, 2);
  assert.equal(manifest.entries[1].name, 'src/index.js');
  assert.equal(manifest.entries[0].size_bytes, null);

  assert.equal(await pr.attachments.manifest('att_pdf'), null);
  assert.equal(calls.length, 2);
});

test('up to four attachment ids ride the ping body while the bytes do not', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/rooms/AB12/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  await pr.broadcast('AB12', {
    message: 'report attached',
    attachment_ids: ['att_1', 'att_2', 'att_3', 'att_4'],
  });

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.attachment_ids, ['att_1', 'att_2', 'att_3', 'att_4']);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('attachments.content returns raw bytes but still throws on a refusal', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/attachments/att_1/content': () => ({
      body: undefined,
      headers: { 'Content-Type': 'application/pdf' },
    }),
    'GET /api/agent/attachments/att_gone/content': () => ({ status: 404, body: { message: 'Not found' } }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  const res = await pr.attachments.content('att_1');
  assert.equal(res.headers.get('Content-Type'), 'application/pdf');

  await assert.rejects(
    () => pr.attachments.content('att_gone'),
    (err) => err instanceof PingRoomError && err.status === 404,
  );
});

test('a 402 upload surfaces the Pro gate rather than a generic failure', async () => {
  const { fetchMock } = recorder({
    'POST /api/agent/attachments': () => ({
      status: 402,
      body: { error: 'pro_required', code: 'pro_required', message: 'Ping attachments are a Pro feature.' },
    }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });

  await assert.rejects(
    () => pr.attachments.upload({ content: 'notes', filename: 'notes.txt' }),
    (err) => err instanceof PingRoomError && err.status === 402 && err.code === 'pro_required',
  );
});
