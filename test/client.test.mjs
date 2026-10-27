import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_INBOX_ERROR_CODES,
  HANDOFF_ERROR_CODES,
  PingRoom,
  PingRoomError,
  ROOM_SCOPED_ERROR_CODES,
  VERSION,
} from '../dist/index.js';
import { recorder } from './helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('package and lockfile versions stay aligned', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'));
  assert.equal(pkg.version, '0.8.0');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  // A VERSION that drifts from package.json makes the SDK misreport itself in
  // the User-Agent and the MCP clientInfo.
  assert.equal(VERSION, pkg.version);
});

test('rooms.list GETs with bearer auth', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/rooms': () => ({ body: [{ id: 'r1', name: 'A', invite_code: 'ab12', icon: null, color: null }] }),
  });
  const pr = new PingRoom({ token: 'tok_abc', fetch: fetchMock });
  const rooms = await pr.rooms.list();
  assert.equal(rooms[0].id, 'r1');
  assert.equal(calls[0].init.headers['Authorization'], 'Bearer tok_abc');
});

test('directory.list is public (no Authorization header)', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agents/directory': () => ({
      body: { data: [], current_page: 1, per_page: 50, total: 0, last_page: 1, next_page_url: null, prev_page_url: null },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await pr.directory.list({ tag: 'ci' });
  assert.equal(calls[0].init.headers['Authorization'], undefined);
  assert.match(calls[0].url, /tag=ci/);
});

test('maps the API error code and never leaks the token', async () => {
  const fetchMock = async () =>
    new Response(JSON.stringify({ code: 'pings_closed', message: 'closed' }), { status: 403 });
  const pr = new PingRoom({ token: 'super_secret_token', fetch: fetchMock });
  await assert.rejects(
    () => pr.agents.ping('agt_x', { message: 'hi' }),
    (e) => {
      assert.ok(e instanceof PingRoomError);
      assert.equal(e.code, 'pings_closed');
      assert.equal(e.status, 403);
      assert.equal(JSON.stringify(e).includes('super_secret_token'), false);
      assert.equal(String(e.message).includes('super_secret_token'), false);
      return true;
    },
  );
});

test('refuses an insecure base URL at construction', () => {
  assert.throws(
    () => new PingRoom({ baseUrl: 'http://api.evil.com' }),
    (e) => e instanceof PingRoomError && e.code === 'insecure_url',
  );
});

test('allows http for localhost dev', () => {
  assert.doesNotThrow(() => new PingRoom({ baseUrl: 'http://localhost:8000', fetch: async () => new Response('{}') }));
});

test('setToken updates the bearer used on subsequent calls', async () => {
  const { calls, fetchMock } = recorder({ 'GET /api/agent/rooms': () => ({ body: [] }) });
  const pr = new PingRoom({ fetch: fetchMock });
  pr.setToken('tok2');
  await pr.rooms.list();
  assert.equal(calls[0].init.headers['Authorization'], 'Bearer tok2');
});

test('a call needing auth without a token throws no_token before fetching', async () => {
  let fetched = false;
  const pr = new PingRoom({ fetch: async () => ((fetched = true), new Response('{}')) });
  await assert.rejects(
    () => pr.rooms.list(),
    (e) => e instanceof PingRoomError && e.code === 'no_token',
  );
  assert.equal(fetched, false);
});

// The exported unions are a promise about the server's `code` vocabulary, so
// they are pinned here exactly. Each entry below was verified against a live
// emitter in the API source; a code with no emitter is worse than an untyped
// one, because it invites callers to write a branch that can never run.
test('the handoff error codes match the codes the handoff endpoints emit', () => {
  assert.deepEqual([...HANDOFF_ERROR_CODES], [
    'feature_temporarily_unavailable', // AgentHandoffController::store
    'handoff_room_unsupported', //        AgentHandoffController::store
    'invalid_target', //                  shared send-guard vocabulary
    'no_room_configured', //              AgentHandoffController::store
    'target_not_permitted', //            AgentHandoffController::resolveTarget
    'recipient_not_ready', //             RecipientNotReadyException renderer
    'idempotency_conflict', //            HandoffService / RequestIdempotency
    'invalid_idempotency_key', //         RequestIdempotency
    'capability_check_unavailable', //    CapabilityCheckUnavailableException renderer
    'insufficient_scope', //              agent.scope middleware
    'free_limit_reached', //              agent.quota middleware
  ]);

  // These four had ZERO emitters anywhere in the API and were removed.
  for (const dead of ['target_not_found', 'target_unavailable', 'pings_closed', 'not_room_member']) {
    assert.equal(HANDOFF_ERROR_CODES.includes(dead), false, `${dead} has no server emitter`);
  }

  // `room_not_granted` comes from the `agent.room` gate, and POST /handoffs is
  // not behind it — it belongs to the room-scoped union instead.
  assert.equal(HANDOFF_ERROR_CODES.includes('room_not_granted'), false);
});

test('the room-scoped and inbox error codes match their server emitters', () => {
  assert.deepEqual([...ROOM_SCOPED_ERROR_CODES], ['room_not_granted']);

  assert.deepEqual([...AGENT_INBOX_ERROR_CODES], [
    'activation_evidence_unavailable', // AgentInboxController::activate
    'no_room_configured', //              AgentInboxController::activate
    'activation_room_muted', //           AgentInboxController::activate
    'activation_delivery_unavailable', // AgentInboxController
    'feature_temporarily_unavailable', // AgentInboxController
  ]);

  // No union may carry a duplicate or a non-snake_case code.
  for (const codes of [HANDOFF_ERROR_CODES, ROOM_SCOPED_ERROR_CODES, AGENT_INBOX_ERROR_CODES]) {
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^[a-z][a-z0-9_]*$/);
  }
});
