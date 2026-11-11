// Runs the SDK's button rules against docs/contracts/ping-actions.json.
//
// Laravel writes that file from App\Support\PingActionRules
// (laravel/tests/Unit/PingActionsContractTest.php): the limits, the reserved
// labels, and the verdict the real rules gave every label and URL vector. The
// SDK re-implements those rules by hand (src/internal/pingActions.ts), so a
// disagreement fails here instead of surfacing as a 422 in production.
//
// The fixture lives in the PingRoom workspace's docs/ repo, which a GitHub
// checkout of sdk/ alone does not have. There every test below is SKIPPED with
// a message; run it from the workspace. Set REQUIRE_CONTRACT_FIXTURES=1 to turn
// a missing fixture into a failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_PING_ACTIONS,
  MAX_PING_ACTION_BODY_BYTES,
  MAX_PING_ACTION_BODY_KEYS,
  MAX_PING_ACTION_LABEL_LENGTH,
  MAX_PING_ACTION_URL_LENGTH,
  PING_ACTION_ID_PATTERN,
  PING_ACTION_RUN_WINDOW_HOURS,
  PING_ACTION_STYLES,
  PING_ACTION_TYPES,
} from '../dist/index.js';
import * as rules from '../dist/internal/pingActions.js';

const FIXTURE_PATH = fileURLToPath(new URL('../../docs/contracts/ping-actions.json', import.meta.url));
const fixtureMissing = !existsSync(FIXTURE_PATH);
if (fixtureMissing && process.env.REQUIRE_CONTRACT_FIXTURES) {
  throw new Error(`REQUIRE_CONTRACT_FIXTURES is set but ${FIXTURE_PATH} does not exist`);
}
const skip = fixtureMissing
  ? 'docs/contracts/ping-actions.json is not checked out beside sdk/ (run this from the PingRoom workspace)'
  : false;
const fixture = fixtureMissing ? null : JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const REGENERATE = 'Regenerate the fixture only from Laravel: WRITE_PING_ACTIONS_CONTRACT=1 php artisan test --compact tests/Unit/PingActionsContractTest.php';

// Where the SDK and the server disagree TODAY, asserted exactly. Empty.
const KNOWN_DRIFT = { labels: [], urls: [] };

test('ping actions: the SDK limits are the server\'s', { skip }, () => {
  assert.deepEqual({
    max_actions: MAX_PING_ACTIONS,
    id_pattern: PING_ACTION_ID_PATTERN.source,
    label_max: MAX_PING_ACTION_LABEL_LENGTH,
    url_max: MAX_PING_ACTION_URL_LENGTH,
    body_max_bytes: MAX_PING_ACTION_BODY_BYTES,
    body_max_keys: MAX_PING_ACTION_BODY_KEYS,
    run_window_hours: PING_ACTION_RUN_WINDOW_HOURS,
    types: [...PING_ACTION_TYPES],
    styles: [...PING_ACTION_STYLES],
  }, fixture.limits, `sdk/src/internal/pingActions.ts disagrees with docs/contracts/ping-actions.json limits. ${REGENERATE}`);
});

test('ping actions: the SDK refuses exactly the server\'s reserved labels', { skip }, () => {
  assert.deepEqual([...rules.RESERVED_PING_ACTION_LABELS], fixture.reserved_labels, `RESERVED_PING_ACTION_LABELS drifted. ${REGENERATE}`);
  for (const label of fixture.reserved_labels) {
    assert.equal(rules.pingActionComparisonForm(label), label, `${label} is not in its comparison form`);
  }
});

test('ping actions: every label vector gets the server\'s verdict and cleaned text', { skip }, () => {
  assert.ok(fixture.label_vectors.length > 10, 'label vectors are missing');
  const observed = [];
  for (const vector of fixture.label_vectors) {
    const verdict = rules.cleanPingActionLabel(vector.label);
    const accepted = verdict.error === null;
    if (accepted !== vector.accepted) {
      observed.push({ label: vector.label, check: 'accepted', client: accepted, server: vector.accepted });
    } else if (accepted && verdict.label !== vector.cleaned) {
      observed.push({ label: vector.label, check: 'cleaned', client: verdict.label, server: vector.cleaned });
    } else if (!accepted && verdict.error !== vector.reason) {
      observed.push({ label: vector.label, check: 'reason', client: verdict.error, server: vector.reason });
    }
  }
  assert.deepEqual(observed, KNOWN_DRIFT.labels, `unexpected SDK/server disagreement on a label. ${REGENERATE}`);
});

test('ping actions: every URL vector gets the server\'s verdict and host', { skip }, () => {
  assert.ok(fixture.url_vectors.length > 10, 'url vectors are missing');
  const observed = [];
  for (const vector of fixture.url_vectors) {
    const verdict = rules.pingActionUrlVerdict(vector.url, vector.type);
    const accepted = verdict.error === null;
    if (accepted !== vector.accepted) {
      observed.push({ url: vector.url, type: vector.type, check: 'accepted', client: accepted, server: vector.accepted });
    } else if (accepted && verdict.host !== vector.host) {
      observed.push({ url: vector.url, type: vector.type, check: 'host', client: verdict.host, server: vector.host });
    } else if (!accepted && verdict.error !== vector.reason) {
      observed.push({ url: vector.url, type: vector.type, check: 'reason', client: verdict.error, server: vector.reason });
    }
  }
  assert.deepEqual(observed, KNOWN_DRIFT.urls, `unexpected SDK/server disagreement on a URL. ${REGENERATE}`);
});
