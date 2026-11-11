// Pins the SDK's live-status template list and limits to
// docs/contracts/live-templates.json.
//
// Laravel writes that file from App\Support\LiveStatusRules
// (laravel/tests/Unit/LiveTemplatesContractTest.php). The SDK keeps its own
// copies, LIVE_TEMPLATES and LIVE_STATUS_LIMITS, and a template the server
// learned that the SDK did not would have no builder and no type. A
// disagreement fails here instead of surfacing as a 422 in production.
//
// The fixture lives in the PingRoom workspace's docs/ repo, which a GitHub
// checkout of sdk/ alone does not have. There every test below is SKIPPED with a
// message; run it from the workspace. Set REQUIRE_CONTRACT_FIXTURES=1 to turn a
// missing fixture into a failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIVE_STATUS_LIMITS, LIVE_TEMPLATES, liveStatus } from '../dist/index.js';

const FIXTURE_PATH = fileURLToPath(new URL('../../docs/contracts/live-templates.json', import.meta.url));
const fixtureMissing = !existsSync(FIXTURE_PATH);
if (fixtureMissing && process.env.REQUIRE_CONTRACT_FIXTURES) {
  throw new Error(`REQUIRE_CONTRACT_FIXTURES is set but ${FIXTURE_PATH} does not exist`);
}
const skip = fixtureMissing
  ? 'docs/contracts/live-templates.json is not checked out beside sdk/ (run this from the PingRoom workspace)'
  : false;
const fixture = fixtureMissing ? null : JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const REGENERATE = fixture?.regenerate ?? '';

// A template with no builder of its own, sent through live.push() with
// `template` set by hand. Empty today: every template has a builder.
const BUILT_THROUGH_GENERIC_PUSH = [];

test('LIVE_TEMPLATES is the fixture list, names and order', { skip }, () => {
  assert.deepEqual(
    [...LIVE_TEMPLATES],
    fixture.templates,
    `the SDK's LIVE_TEMPLATES (sdk/src/liveStatus.ts) disagrees with docs/contracts/live-templates.json. The server's list is the truth: add or remove the template and its builder. Regenerate the fixture only from Laravel: ${REGENERATE}`,
  );
});

test('every fixture template has a builder that stamps it', { skip }, () => {
  for (const template of fixture.templates) {
    if (BUILT_THROUGH_GENERIC_PUSH.includes(template)) continue;
    assert.equal(typeof liveStatus[template], 'function', `liveStatus.${template}() is missing`);
    assert.equal(liveStatus[template]('c', { state: 'running' }).live_status.template, template);
  }
});

test('the template an unknown one folds back onto is a template the SDK lists', { skip }, () => {
  assert.ok(LIVE_TEMPLATES.includes(fixture.fallback_template));
});

test('every field a template owns is a field the SDK types accept, and the fixture knows its limits', { skip }, () => {
  // `live_status` is passed through untouched, so a field the server owns for a
  // template must survive a builder round trip.
  for (const [template, fields] of Object.entries(fixture.template_fields)) {
    for (const field of fields) {
      assert.ok(fixture.fields[field], `docs/contracts/live-templates.json owns ${template}.${field} but gives it no limits`);
      const body = liveStatus[template]('c', { state: 'running', [field]: 'x' });
      assert.equal(body.live_status[field], 'x', `liveStatus.${template}() dropped ${field}`);
    }
  }
});

test('the limits the SDK exports are the fixture limits', { skip }, () => {
  const { fields } = fixture;
  const expected = {
    valueLength: fields.value.max,
    valueLabelLength: fields.value_label.max,
    deltaLength: fields.delta.max,
    statsMin: fields.stats.min,
    statsMax: fields.stats.max,
    statLabelLength: fields.stats.item.label.max,
    statValueLength: fields.stats.item.value.max,
    segmentsMin: fields.segments.min,
    segmentsMax: fields.segments.max,
  };
  assert.deepEqual(
    { ...LIVE_STATUS_LIMITS },
    expected,
    `LIVE_STATUS_LIMITS (sdk/src/liveStatus.ts) disagrees with docs/contracts/live-templates.json. Regenerate the fixture only from Laravel: ${REGENERATE}`,
  );
});

test('the immutable fields are the ones the SDK documents', { skip }, () => {
  // steps (steps_immutable), segments (segments_immutable), started_at
  // (started_at_immutable). The SDK carries these in the LiveStatus doc
  // comments, so a new immutable field means a doc change here first.
  assert.deepEqual(fixture.immutable_fields, {
    steps: ['steps'],
    progress: ['segments'],
    timer: ['started_at'],
  });
});
