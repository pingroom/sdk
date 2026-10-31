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

test('webhooks can be created without a preset and an existing preset can be cleared', async () => {
  const { pr, calls } = clientReturning({ id: 'custom-hook', name: 'Deploys', action_number: null });
  const independent = { name: 'Deploys', message: 'Deployment complete' };
  assert.equal((await pr.webhooks.create('AB12', independent)).action_number, null);
  await pr.webhooks.create('AB12', { ...independent, action_number: null });
  await pr.webhooks.update('AB12', 'custom-hook', { action_number: null });

  assert.deepEqual(JSON.parse(calls[0].body), independent);
  assert.deepEqual(JSON.parse(calls[1].body), { ...independent, action_number: null });
  assert.deepEqual(JSON.parse(calls[2].body), { action_number: null });
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

test('a poll sends resolution_policy and returns the tally untouched', async () => {
  const results = {
    audience_count: 3,
    response_count: 2,
    options: [{ value: 'pizza', label: 'Pizza', count: 2 }, { value: 'tacos', label: 'Tacos', count: 0 }],
    responses: [{ value: 'pizza', label: 'Pizza', responder: { id: 'u1', display_name: 'Sam', profile_image_url: null, emoji: null, color: null }, answered_at: '2026-10-17T10:31:04+00:00' }],
    viewer: null,
  };
  const { pr, calls } = clientReturning({ id: 'q1', kind: 'question', state: 'answered', resolution_policy: 'all', answer: null, results });
  const poll = await pr.questions.ask('AB12', { prompt: 'Lunch?', options: ['pizza', 'tacos'], resolution_policy: 'all', ttl: 600 });
  assert.deepEqual(JSON.parse(calls[0].body), { prompt: 'Lunch?', options: ['pizza', 'tacos'], resolution_policy: 'all', ttl: 600 });
  assert.equal(calls[0].url.pathname, '/api/agent/rooms/AB12/questions');
  assert.equal(poll.resolution_policy, 'all');
  assert.equal(poll.answer, null);
  assert.deepEqual(poll.results, results);
  assert.deepEqual(await pr.questions.waitForAnswer('q1'), { id: 'q1', kind: 'question', state: 'answered', resolution_policy: 'all', answer: null, results });
});

test('a poll combined with a direct scope, a target or a typed answer fails before sending', async () => {
  const { pr, calls } = clientReturning({ id: 'q1', state: 'pending' });
  for (const extra of [
    { responder_scope: 'direct' },
    { target_user_id: '0190a2b4-0000-7000-8000-000000000001' },
    { text_input: { placeholder: 'Other?' } },
  ]) {
    assert.throws(
      () => pr.questions.ask('AB12', { prompt: 'Lunch?', options: ['pizza', 'tacos'], resolution_policy: 'all', ...extra }),
      (error) => error instanceof PingRoomError && error.code === 'invalid_request',
    );
  }
  assert.equal(calls.length, 0);
  // A room-scope poll and a first-answer question with the same extras are left to the server.
  await pr.questions.ask('AB12', { prompt: 'Lunch?', resolution_policy: 'all', responder_scope: 'room' });
  await pr.questions.ask('AB12', { prompt: 'Why?', resolution_policy: 'first', text_input: { placeholder: 'Reason' } });
  assert.equal(calls.length, 2);
});

test('new management and feed APIs remain typed for TypeScript callers', () => {
  const filename = fileURLToPath(new URL('./agent-contract.mts', import.meta.url));
  const source = `
    import { PingRoom, sendIncomingWebhook, type AgentErrorCode, type AgentNotification, type CommonErrorCode, type QuickActionErrorCode, type Webhook, type RoomIconCatalog } from '../dist/index.js';
    const pr = new PingRoom();
    for (const typed of ['feature_disabled', 'rate_limited', 'location_trigger_owner_only', 'location_trigger_inactive'] as const) {
      const shared: AgentErrorCode = typed;
      void shared;
    }
    const common: CommonErrorCode = 'rate_limited';
    const location: QuickActionErrorCode = 'location_trigger_inactive';
    // @ts-expect-error a per-surface code is not a common one
    const notCommon: CommonErrorCode = 'pro_required';
    // @ts-expect-error the handoff-only vocabulary is not a catch-all string
    const notTyped: AgentErrorCode = 'made_up_code';
    void [common, location, notCommon, notTyped];
    const confirmed = await pr.broadcast('AB12', { message: 'Confirm', requires_ack: true, ack_mode: 'all' });
    await pr.actions.trigger('AB12', 1, { ack_mode: 'any' });
    const mode: 'any' | 'all' | undefined = confirmed.action_state?.mode;
    const count: number | undefined = confirmed.action_state?.confirmed_count;
    const total: number | undefined = confirmed.action_state?.required_count;
    const reach = confirmed.confirmation_reach;
    const unreachable: number | undefined = reach?.checked ? reach.unavailable_count : undefined;
    const unreachableIds: string[] | undefined = reach?.checked ? reach.unavailable_user_ids : undefined;
    // @ts-expect-error nothing was checked, so there is no list to read
    if (reach && !reach.checked) void reach.unavailable_user_ids;
    void [unreachable, unreachableIds];
    // @ts-expect-error unsupported confirmation rule
    pr.broadcast('AB12', { message: 'Confirm', ack_mode: 'majority' });
    const page = await pr.notifications.list({ limit: 25, page: 2 });
    const legacy: AgentNotification = page.data[0]!;
    const code: string | undefined = page.data[0]?.room?.code;
    const invite: string | undefined = page.data[0]?.room?.invite_code;
    const catalog: RoomIconCatalog = await pr.rooms.icons();
    const hook: Webhook = await pr.webhooks.create('AB12', { name: 'Deploys' });
    await pr.webhooks.update('AB12', hook.id, { title: null, regenerate_secret: true });
    const independent: Webhook = await pr.webhooks.create('AB12', { name: 'Custom', action_number: null });
    const preset: number | null = independent.action_number;
    // @ts-expect-error independent webhooks do not always have a numeric preset
    const requiredPreset: number = independent.action_number;
    await pr.webhooks.update('AB12', hook.id, { action_number: null });
    await sendIncomingWebhook(hook.webhook_url, { message: 'Custom content', action: null });
    const question = await pr.questions.ask('AB12', { prompt: 'Ship?', idempotencyKey: 'deploy-42' });
    const notification: string | null | undefined = question.notification_id;
    const poll = await pr.questions.ask('AB12', { prompt: 'Lunch?', options: ['pizza', 'tacos'], resolution_policy: 'all' });
    const audience: number | undefined = poll.results?.audience_count;
    const tally: number | undefined = poll.results?.options[0]?.count;
    const voter: string | null | undefined = poll.results?.responses[0]?.responder.display_name;
    const asked: boolean | undefined = poll.results?.viewer?.asked;
    const policy: string = poll.resolution_policy;
    // @ts-expect-error quorum is reserved, not an accepted policy
    pr.questions.ask('AB12', { prompt: 'Lunch?', resolution_policy: 'quorum' });
    // @ts-expect-error webhook names are required
    pr.webhooks.create('AB12', { enabled: true });
    // @ts-expect-error limits are numeric
    pr.notifications.list({ limit: '25' });
    await pr.actions.update('AB12', 2, { label: 'Where?', icon: '📍', input_type: 'location' });
    const pressed = await pr.actions.trigger('AB12', 2, { data: { location: { latitude: 25.2, longitude: 55.3 } }, attachment_ids: ['a'], quick_action_id: 'id' });
    const dismissed: number | undefined = pressed.action_state?.dismissed_count;
    const silent: boolean | null | undefined = legacy.is_silent;
    const inputType: 'none' | 'location' | 'link' | 'file' | 'photo' | 'pdf' | undefined = (await pr.actions.list('AB12'))[0]?.input_type;
    const limit: 4 | 16 | undefined = (await pr.rooms.get('AB12')).quick_action_limit;
    await pr.actions.updateLayout('AB12', { base_action_ids: [], page_order: [1, null], actions: [] });
    await pr.actions.deletePage('AB12', 2);
    await pr.rooms.createPublic({ name: 'M', icon: 'globe', color: '#0391fe', handle: 'm', location_name: 'D', location_latitude: 1, location_longitude: 2 });
    // @ts-expect-error unknown input type
    pr.actions.update('AB12', 2, { label: 'x', icon: 'y', input_type: 'video' });
    // @ts-expect-error button_label is not accepted on a press
    pr.actions.trigger('AB12', 2, { data: { url: 'https://x.example', button_label: 'Open' } });
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

test('confirmation modes reach broadcasts and quick actions while progress survives every read', async () => {
  const action_state = { status: 'open', mode: 'all', confirmed_count: 1, required_count: 2, confirmed_user_ids: ['member-1'], can_ack: false };
  const { pr, calls } = clientReturning({ id: 'ping-1', action_state });
  for (const mode of ['any', 'all']) {
    await pr.broadcast('AB12', { message: 'Confirm', requires_ack: true, ack_mode: mode });
    await pr.actions.trigger('AB12', 1, { requires_ack: true, ack_mode: mode });
  }
  assert.deepEqual(calls.slice(0, 4).map((call) => JSON.parse(call.body).ack_mode), ['any', 'any', 'all', 'all']);
  assert.deepEqual((await pr.notifications.getNotification('ping-1')).action_state, action_state);
  assert.deepEqual((await pr.notifications.waitForAcknowledgement('ping-1', { timeout: 0 })).action_state, action_state);
  await pr.broadcast('AB12', { message: 'Legacy', requires_ack: true });
  assert.equal(Object.hasOwn(JSON.parse(calls.at(-1).body), 'ack_mode'), false);
});

test('quick action, common and request-limit error codes are exported as runtime unions', async () => {
  const { QUICK_ACTION_ERROR_CODES, COMMON_ERROR_CODES, REQUEST_LIMIT_ERROR_CODES } = await import('../dist/index.js');
  assert.deepEqual([...QUICK_ACTION_ERROR_CODES], [
    'quick_action_input_required', 'quick_action_input_type', 'action_not_configured',
    'pro_required', 'quick_action_layout_changed', 'quick_action_page_in_use',
    // QuickActionDispatcher, the `location` branch of actions.trigger().
    'location_trigger_owner_only', 'location_trigger_inactive',
  ]);
  // Codes any route can answer: the ThrottleRequestsException renderer in
  // bootstrap/app.php and ClientFeatureGate (the `feature:` middleware and the
  // request-level gates of the Ping-creating requests).
  assert.deepEqual([...COMMON_ERROR_CODES], ['rate_limited', 'feature_disabled']);
  assert.deepEqual([...REQUEST_LIMIT_ERROR_CODES], ['payload_too_large', 'attachment_too_large']);
  for (const codes of [QUICK_ACTION_ERROR_CODES, COMMON_ERROR_CODES, REQUEST_LIMIT_ERROR_CODES]) {
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^[a-z][a-z0-9_]*$/);
  }
  // A common code belongs to no per-surface union.
  const { HANDOFF_ERROR_CODES, ROOM_SCOPED_ERROR_CODES, AGENT_INBOX_ERROR_CODES } = await import('../dist/index.js');
  for (const common of COMMON_ERROR_CODES) {
    for (const codes of [HANDOFF_ERROR_CODES, ROOM_SCOPED_ERROR_CODES, AGENT_INBOX_ERROR_CODES, QUICK_ACTION_ERROR_CODES, REQUEST_LIMIT_ERROR_CODES]) {
      assert.equal(codes.includes(common), false, `${common} is common, not per-surface`);
    }
  }
});

test('a location press from a non-owner or with no armed trigger surfaces its typed code', async () => {
  const { QUICK_ACTION_ERROR_CODES } = await import('../dist/index.js');
  const responses = [
    [403, 'location_trigger_owner_only', 'Only the room owner can send a Location Ping'],
    [409, 'location_trigger_inactive', 'Location trigger is not active'],
    [403, 'feature_disabled', 'Location Pings are turned off.'],
  ];
  for (const [status, code, message] of responses) {
    const pr = new PingRoom({
      token: 't',
      fetch: async () => new Response(JSON.stringify({ message, code, ...(code === 'feature_disabled' ? { feature: 'triggers.location' } : {}) }), { status }),
    });
    await assert.rejects(
      () => pr.actions.trigger('AB12', 1, { trigger_source: 'location' }),
      (error) => error instanceof PingRoomError && error.status === status && error.code === code,
    );
    assert.equal(code === 'feature_disabled' || QUICK_ACTION_ERROR_CODES.includes(code), true, `${code} is typed`);
  }
});
