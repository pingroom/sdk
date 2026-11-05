// Runs the SDK's real guards against docs/contracts/structured-ping-vectors.json.
//
// Laravel writes that file: every vector is an input plus the verdict the real
// server gave it (laravel/tests/Feature/StructuredPingVectorsContractTest.php).
// The SDK re-implements those rules by hand, and each has been wrong before: the
// 8 KB `data` cap was measured in UTF-8 until f682fa7, an idempotencyKey was
// accepted but never sent (62e0c7e) and a non-ASCII one made fetch throw, which
// read as a retryable network_error (601dc72). A disagreement fails here instead
// of surfacing as a 422 in production.
//
// The fixture lives in the PingRoom workspace's docs/ repo, which a GitHub
// checkout of sdk/ alone does not have. There every test below is SKIPPED with a
// message; run it from the workspace. Set REQUIRE_CONTRACT_FIXTURES=1 to turn a
// missing fixture into a failure.
//
// Everything goes through the public client with a recording fetch, so the test
// follows the key and the data all the way to the wire. Only the byte count
// itself is read from dist/internal/guards.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PingRoom, PingRoomError, linkPing, sendIncomingWebhook } from '../dist/index.js';
import * as guards from '../dist/internal/guards.js';

const FIXTURE_PATH = fileURLToPath(new URL('../../docs/contracts/structured-ping-vectors.json', import.meta.url));
const fixtureMissing = !existsSync(FIXTURE_PATH);
if (fixtureMissing && process.env.REQUIRE_CONTRACT_FIXTURES) {
  throw new Error(`REQUIRE_CONTRACT_FIXTURES is set but ${FIXTURE_PATH} does not exist`);
}
const skip = fixtureMissing
  ? 'docs/contracts/structured-ping-vectors.json is not checked out beside sdk/ (run this from the PingRoom workspace)'
  : false;
const fixture = fixtureMissing ? null : JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const REGENERATE = fixture?.regenerate ?? '';

// Where the SDK and the server disagree TODAY, asserted exactly: a new
// disagreement fails the test, and so does a fixed one still listed here.
// Nothing here is a runtime change; each is a fact about the current SDK.
const KNOWN_DRIFT = {
  // Byte counts that differ although the SDK's measure is the server's formula:
  // TrimStrings / ConvertEmptyStringsToNull run before the 8 KB rule, so "" is
  // measured as null (4 bytes) and surrounding whitespace is not measured.
  measure: [
    { id: 'empty-string-becomes-null', check: 'serverBytes', client: 22, server: 24 },
    { id: 'empty-string-null-expansion-at-limit', check: 'serverBytes', client: 8192, server: 8194 },
    { id: 'padded-string-is-trimmed', check: 'serverBytes', client: 29, server: 23 },
  ],
  // Verdicts that differ, for every sender that takes `data`.
  data: [
    // The server decodes {"0":..,"1":..} to a PHP list and refuses it as one.
    { id: 'numeric-keys-look-like-list', check: 'accepted', client: true, server: false },
    // The empty string becomes null before the 8 KB rule runs: 8192 bytes as sent, 8194 as measured.
    { id: 'empty-string-null-expansion-at-limit', check: 'accepted', client: true, server: false },
  ],
  // The server accepts any bytes and counts code points. The SDK narrows the key
  // to printable ASCII on purpose, because it travels as an HTTP header: fetch
  // throws outside Latin-1 (601dc72) and a Latin-1 byte above 0x7E reaches the
  // server as invalid UTF-8. Each of these is "the server would accept it, the
  // SDK refuses it"; none is the other way round.
  idempotencyKey: [
    'form-feed-edges', 'nbsp-edges', 'non-ascii-persian', 'non-ascii-latin1', 'persian-130-chars',
    'emoji-255-chars', 'inner-control-char', 'inner-tab', 'inner-del',
  ].map((id) => ({ id, check: 'accepted', client: false, server: true })),
  // Only these two senders test the key for truthiness (`input.idempotencyKey ? ... : {}`,
  // `if (options.idempotencyKey)`), so an empty string is not refused: the request goes
  // out with no Idempotency-Key at all, where the server would have said 422.
  idempotencyKeyBySender: {
    'handoffs.requestAck': [{ id: 'empty', check: 'accepted', client: 'sent without the key', server: false }],
    sendIncomingWebhook: [{ id: 'empty', check: 'accepted', client: 'sent without the key', server: false }],
  },
  buttonLabel: [],
};

const SENDERS_BY_NAME = {
  broadcast: (ctx, extra) => ctx.pr.broadcast('AB12', { message: 'hi', ...extra }),
  'handoffs.requestAck': (ctx, extra) => ctx.pr.handoffs.requestAck({ prompt: 'hi', ...extra }),
  'approvals.request': (ctx, extra) => ctx.pr.approvals.request('AB12', { question: 'Ship?', ...extra }),
  'questions.ask': (ctx, extra) => ctx.pr.questions.ask('AB12', { prompt: 'Ship?', ...extra }),
  'live.push': (ctx, extra) => ctx.pr.live.push('AB12', { correlation_id: 'c1', live_status: { state: 'active', message: 'x' }, ...extra }),
  'actions.trigger': (ctx, extra) => ctx.pr.actions.trigger('AB12', 2, { ...extra }),
  sendIncomingWebhook: (ctx, extra) => sendIncomingWebhook(
    'https://example.test/webhooks/room/secret',
    { message: 'hi', ...(extra.data === undefined ? {} : { data: extra.data }) },
    { fetch: ctx.fetch, ...(extra.idempotencyKey === undefined ? {} : { idempotencyKey: extra.idempotencyKey }) },
  ),
};
const DATA_SENDERS = ['broadcast', 'handoffs.requestAck', 'approvals.request', 'questions.ask', 'live.push', 'sendIncomingWebhook'];
const KEY_SENDERS = ['broadcast', 'handoffs.requestAck', 'approvals.request', 'questions.ask', 'actions.trigger', 'sendIncomingWebhook'];

function newContext() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: 'x', state: 'pending', success: true }), { status: 201 });
  };
  return { calls, fetch, pr: new PingRoom({ token: 't', fetch }) };
}

/** Send once. Returns what the SDK did: refused (with the error) or sent (with the request). */
async function attempt(name, extra) {
  const ctx = newContext();
  try {
    await SENDERS_BY_NAME[name](ctx, extra);
  } catch (error) {
    if (!(error instanceof PingRoomError)) throw error;
    assert.equal(ctx.calls.length, 0, `${name}: refused locally but a request was made anyway`);
    return { sent: false, error, call: undefined };
  }
  assert.equal(ctx.calls.length, 1, `${name}: expected exactly one request`);
  return { sent: true, error: undefined, call: ctx.calls[0] };
}

function dataReason(error) {
  if (error.code !== 'invalid_data') return `unknown: ${error.code} ${error.message}`;
  if (/at most 25 keys/.test(error.message)) return 'too_many_keys';
  if (/too large/.test(error.message)) return 'too_large';
  if (/JSON object/.test(error.message)) return 'not_object';
  return `unknown: ${error.message}`;
}

test('structured-ping vectors: the fixture is the shape this test reads', { skip }, () => {
  assert.equal(fixture.contract, 'structured-ping-vectors');
  assert.equal(fixture.version, 1);
  assert.deepEqual(fixture.limits, {
    dataMaxBytes: 8192, dataMaxKeys: 25, idempotencyKeyMaxCodePoints: 255, buttonLabelMaxCodePoints: 26,
  });
  for (const section of ['data', 'idempotencyKey', 'buttonLabel']) {
    assert.ok(fixture[section].length > 5, `${section} vectors are missing`);
  }
});

test('data: the SDK measures every vector the way the server does', { skip }, () => {
  assert.equal(typeof guards.serverJsonByteLength, 'function', 'dist/internal/guards.js no longer exports serverJsonByteLength');
  const observed = [];
  for (const vector of fixture.data) {
    if (vector.serverBytes === null) continue;
    const bytes = guards.serverJsonByteLength(JSON.stringify(vector.data));
    if (bytes !== vector.serverBytes) {
      observed.push({ id: vector.id, check: 'serverBytes', client: bytes, server: vector.serverBytes });
    }
  }
  assert.deepEqual(observed, KNOWN_DRIFT.measure, `unexpected SDK/server disagreement on the byte count. ${REGENERATE}`);
});

test('data: every public method that takes `data` agrees with the server on every vector', { skip }, async () => {
  const observed = [];
  for (const name of DATA_SENDERS) {
    for (const vector of fixture.data) {
      const result = await attempt(name, { data: vector.data });
      if (result.sent !== vector.accepted) {
        observed.push({ sender: name, id: vector.id, check: 'accepted', client: result.sent, server: vector.accepted });
      } else if (result.sent) {
        assert.deepEqual(JSON.parse(result.call.init.body).data, vector.data, `${name} ${vector.id}: data changed on the wire`);
      } else {
        // Both refuse: the SDK must name a reason the server also found.
        const reason = dataReason(result.error);
        assert.ok(vector.reasons.includes(reason), `${name} ${vector.id}: the SDK refused as ${reason}; the server's reasons are ${vector.reasons}. ${REGENERATE}`);
      }
    }
  }
  const expected = DATA_SENDERS.flatMap((sender) => KNOWN_DRIFT.data.map((entry) => ({ sender, ...entry })));
  assert.deepEqual(observed, expected, `unexpected SDK/server disagreement on data. ${REGENERATE}`);
});

test('idempotency key: every public method that takes one agrees with the server, and sends the trimmed key', { skip }, async () => {
  const observed = [];
  for (const name of KEY_SENDERS) {
    for (const vector of fixture.idempotencyKey) {
      const result = await attempt(name, { idempotencyKey: vector.key });
      // A key the SDK refuses must be a typed error, never a network failure.
      if (!result.sent) {
        assert.equal(result.error.code, 'invalid_request', `${name} ${vector.id}: ${result.error.code}`);
        assert.match(result.error.message, /idempotencyKey/, `${name} ${vector.id}`);
      }
      const header = result.sent ? result.call.init.headers['Idempotency-Key'] : undefined;
      // true: sent with the key. false: refused. A string: sent, but the key is not on the wire.
      const client = !result.sent ? false : header === undefined ? 'sent without the key' : true;
      if (client !== vector.accepted) {
        observed.push({ sender: name, id: vector.id, check: 'accepted', client, server: vector.accepted });
      } else if (client === true && header !== vector.trimmed) {
        observed.push({ sender: name, id: vector.id, check: 'trimmed', client: header, server: vector.trimmed });
      }
    }
  }

  const position = (id) => fixture.idempotencyKey.findIndex((vector) => vector.id === id);
  const expected = KEY_SENDERS.flatMap((sender) => [
    ...KNOWN_DRIFT.idempotencyKey,
    ...(KNOWN_DRIFT.idempotencyKeyBySender[sender] ?? []),
  ].sort((a, b) => position(a.id) - position(b.id)).map((entry) => ({ sender, ...entry })));
  assert.deepEqual(observed, expected, `unexpected SDK/server disagreement on Idempotency-Key. ${REGENERATE}`);
});

test('button label: linkPing counts code points like the server', { skip }, () => {
  const observed = [];
  for (const vector of fixture.buttonLabel) {
    let accepted = true;
    let built;
    try {
      built = linkPing({ url: 'https://example.com/build/512', buttonLabel: vector.label });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      accepted = false;
    }
    if (accepted !== vector.accepted) {
      observed.push({ id: vector.id, check: 'accepted', client: accepted, server: vector.accepted });
    } else if (accepted) {
      assert.equal(built.button_label, vector.label, `${vector.id}: label changed`);
    }
  }
  assert.deepEqual(observed, KNOWN_DRIFT.buttonLabel, `unexpected SDK/server disagreement on button_label. ${REGENERATE}`);
});
