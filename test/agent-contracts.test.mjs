import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PingRoom, PingRoomError } from '../dist/index.js';

function clientReturning(body) {
  const calls = [];
  const pr = new PingRoom({ token: 'test-token', fetch: async (url, init) => {
    calls.push({ url: new URL(url), ...init });
    return new Response(JSON.stringify(body));
  } });
  return { pr, calls };
}

test('notification history forwards limit/page and adds room.code without losing REST metadata', async () => {
  const room = { id: 'r1', invite_code: 'AB12', name: 'Deploys', icon: 'bell', color: '#ff0000', is_public: false };
  const payload = { data: [{ id: 'n1', message: 'Ready', room, action_state: null }], current_page: 2, per_page: 10, total: 23, last_page: 3, has_more: true, next_page_url: '/api/agent/notifications?page=3' };
  const { pr, calls } = clientReturning(payload);
  const result = await pr.notifications.list({ limit: 10, page: 2, room_id: 'r1', type: 'received' });
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { limit: '10', page: '2', room_id: 'r1', type: 'received' });
  assert.equal(calls[0].url.pathname, '/api/agent/notifications');
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.deepEqual(result, { ...payload, data: [{ ...payload.data[0], room: { ...room, code: 'AB12' } }] });
});

test('notification history maps the deprecated size alias and gives explicit limit precedence', async () => {
  const { pr, calls } = clientReturning({ data: [] });
  await pr.notifications.list({ notifications_per_page: 10 });
  await pr.notifications.list({ notifications_per_page: 10, limit: 25, page: 3 });
  await pr.notifications.list();
  assert.equal(calls[0].url.search, '?limit=10');
  assert.equal(calls[1].url.searchParams.get('limit'), '25');
  assert.equal(calls[1].url.searchParams.get('page'), '3');
  assert.equal(calls[2].url.search, '');
  assert.ok(calls.every((call) => !call.url.searchParams.has('notifications_per_page')));
});

test('room icons expose the catalog ids, categories and asset metadata', async () => {
  const catalog = { version: 4, base_url: 'https://api.example/assets/room-icons/v3', categories: [{ id: 'work', label: 'Work', icons: ['bell'] }], icons: { bell: { file: 'bell.svg', tags: ['alert'] } } };
  const { pr, calls } = clientReturning(catalog);
  assert.deepEqual(await pr.rooms.icons(), catalog);
  assert.equal(calls[0].url.pathname, '/api/agent/room-icons');
  assert.equal(calls[0].method, 'GET');
});

test('webhook CRUD unwraps lists and preserves flat credentials, nullable fields and rotation', async () => {
  const calls = [];
  const hook = { id: 'hook/1', name: 'Deploys', webhook_url: 'https://api.example/api/webhooks/AB12/secret', enabled: true };
  const pr = new PingRoom({ token: 'test-token', fetch: async (url, init) => {
    calls.push({ url: new URL(url), ...init });
    const body = init.method === 'GET' ? { webhooks: [hook], count: 1 }
      : init.method === 'DELETE' ? { message: 'Webhook deleted' }
      : { ...hook, ...JSON.parse(init.body) };
    return new Response(JSON.stringify(body));
  } });
  assert.deepEqual(await pr.webhooks.list('AB/12'), [hook]);
  const create = { name: 'Deploys', title: 'Done', message: 'Shipped', emoji: '🚀', icon: 'bell', color: '#ff0000', sound: 'ting', haptic: 'light', action_number: 2, enabled: false, cooldown_seconds: 0 };
  assert.equal((await pr.webhooks.create('AB/12', create)).webhook_url, hook.webhook_url);
  const update = { title: null, message: null, emoji: null, icon: null, color: null, sound: null, haptic: null, enabled: false, regenerate_secret: true };
  assert.equal((await pr.webhooks.update('AB/12', 'hook/1', update)).title, null);
  assert.equal(await pr.webhooks.delete('AB/12', 'hook/1'), undefined);
  assert.deepEqual(calls.map((call) => [call.method, call.url.pathname]), [
    ['GET', '/api/agent/rooms/AB%2F12/webhooks'],
    ['POST', '/api/agent/rooms/AB%2F12/webhooks'],
    ['PUT', '/api/agent/rooms/AB%2F12/webhooks/hook%2F1'],
    ['DELETE', '/api/agent/rooms/AB%2F12/webhooks/hook%2F1'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), create);
  assert.deepEqual(JSON.parse(calls[2].body), update);
  assert.ok(calls.every((call) => call.headers.Authorization === 'Bearer test-token'));
});

test('questions carry retry keys in headers and reject empty keys before sending', async () => {
  const { pr, calls } = clientReturning({ id: 'q1', state: 'pending' });
  const input = { prompt: 'Ship?', options: ['yes', 'no'], idempotencyKey: 'deploy-42' };
  await pr.questions.ask('AB12', input);
  await pr.questions.ask('AB12', input);
  for (const call of calls) {
    assert.equal(call.headers['Idempotency-Key'], 'deploy-42');
    assert.deepEqual(JSON.parse(call.body), { prompt: 'Ship?', options: ['yes', 'no'] });
  }
  for (const idempotencyKey of ['', '  ', 'x'.repeat(256)]) {
    assert.throws(() => pr.questions.ask('AB12', { prompt: 'Ship?', idempotencyKey }), PingRoomError);
  }
  assert.equal(calls.length, 2);
});

test('new management and feed APIs remain typed for TypeScript callers', () => {
  const filename = fileURLToPath(new URL('./agent-contract.mts', import.meta.url));
  const source = `
    import { PingRoom, type AgentNotification, type Webhook, type RoomIconCatalog } from '../dist/index.js';
    const pr = new PingRoom();
    const page = await pr.notifications.list({ limit: 25, page: 2 });
    const legacy: AgentNotification = page.data[0]!;
    const code: string | undefined = page.data[0]?.room?.code;
    const invite: string | undefined = page.data[0]?.room?.invite_code;
    const catalog: RoomIconCatalog = await pr.rooms.icons();
    const hook: Webhook = await pr.webhooks.create('AB12', { name: 'Deploys' });
    await pr.webhooks.update('AB12', hook.id, { title: null, regenerate_secret: true });
    const question = await pr.questions.ask('AB12', { prompt: 'Ship?', idempotencyKey: 'deploy-42' });
    const notification: string | null | undefined = question.notification_id;
    // @ts-expect-error webhook names are required
    pr.webhooks.create('AB12', { enabled: true });
    // @ts-expect-error limits are numeric
    pr.notifications.list({ limit: '25' });
  `;
  const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (path) => path === filename ? source : read(path);
  host.fileExists = (path) => path === filename || exists(path);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
});
