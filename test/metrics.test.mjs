import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_METRICS_PER_ROOM,
  METRIC_ERROR_CODES,
  METRIC_FORMATS,
  PingRoom,
  PingRoomError,
  normalizeMetricKey,
  sendIncomingWebhook,
} from '../dist/index.js';
import { recorder } from './helpers.mjs';

// Room metrics: `pr.metrics.list|set|delete` and the `metric` of an incoming
// webhook body. Setting a metric sends no Ping and no push.

const stored = (overrides = {}) => ({
  key: 'mrr',
  label: 'MRR',
  format: 'currency',
  unit: 'USD',
  value: 12400,
  value_updated_at: '2026-11-11T08:12:30.000000Z',
  ...overrides,
});

const invalid = (e) => e instanceof PingRoomError && e.code === 'invalid_request';

test('the limits mirror the server', () => {
  assert.equal(MAX_METRICS_PER_ROOM, 8);
  assert.deepEqual([...METRIC_FORMATS], ['number', 'currency', 'percent', 'unit', 'text']);
  assert.deepEqual([...METRIC_ERROR_CODES], ['metrics_limit_reached', 'metric_not_found', 'metric_exists']);
});

test('metrics.list returns the metrics and the per-room limit', async () => {
  const { calls, fetchMock } = recorder({
    'GET /api/agent/rooms/ab12/metrics': () => ({ body: { metrics: [stored(), stored({ key: 'status', format: 'text', unit: null, value: 'All clear' })], limit: 8 } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const result = await pr.metrics.list('ab12');

  assert.equal(result.limit, 8);
  assert.deepEqual(result.metrics.map((m) => m.key), ['mrr', 'status']);
  assert.equal(result.metrics[0].value, 12400);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
});

test('metrics.set PUTs the lowercased key with only the fields given', async () => {
  const { calls, fetchMock } = recorder({
    'PUT /api/agent/rooms/ab12/metrics/mrr': ({ init }) => ({ status: 201, body: stored({ ...JSON.parse(init.body) }) }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  const created = await pr.metrics.set('ab12', ' MRR ', { value: 12400, label: 'MRR', format: 'currency', unit: 'usd' });
  assert.equal(created.key, 'mrr');
  assert.deepEqual(JSON.parse(calls[0].init.body), { value: 12400, label: 'MRR', format: 'currency', unit: 'usd' });

  await pr.metrics.set('ab12', 'mrr', { value: 12650, label: undefined });
  assert.deepEqual(JSON.parse(calls[1].init.body), { value: 12650 });
});

test('metrics.set accepts every value the server accepts', async () => {
  const { calls, fetchMock } = recorder({ '*': ({ init }) => ({ body: stored({ ...JSON.parse(init.body) }) }) });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  for (const [input, value] of [
    [{ value: 0 }, 0],
    [{ value: -3.5 }, -3.5],
    [{ value: 1e15 }, 1e15],
    [{ value: -1e15 }, -1e15],
    [{ value: '12.50' }, '12.50'],
    [{ value: '-0.5', format: 'percent' }, '-0.5'],
    [{ value: 'All clear' }, 'All clear'],
    [{ value: 'é'.repeat(24), format: 'text' }, 'é'.repeat(24)],
    [{ value: '42', format: 'text' }, '42'],
    [{ value: 'NaN', format: 'text' }, 'NaN'],
    [{ value: 240, format: 'unit', unit: 'abcdefgh' }, 240],
  ]) {
    await pr.metrics.set('ab12', 'k', input);
    assert.equal(JSON.parse(calls.at(-1).init.body).value, value, JSON.stringify(input));
  }
  assert.equal(calls.length, 11);
});

test('metrics.set refuses a write the server would refuse, before any request', async () => {
  const { calls, fetchMock } = recorder({});
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  for (const [key, input, expected] of [
    ['', { value: 1 }, /`key` must be 1–40/],
    ['bad key', { value: 1 }, /`key` must be 1–40/],
    ['a.b', { value: 1 }, /`key` must be 1–40/],
    ['-a', { value: 1 }, /`key` must be 1–40/],
    ['a'.repeat(41), { value: 1 }, /`key` must be 1–40/],
    [5, { value: 1 }, /`key` must be a string/],
    ['k', {}, /`value` is required/],
    ['k', { value: null }, /`value` is required/],
    ['k', { value: true }, /`value` must be a number or a string/],
    ['k', { value: [1] }, /`value` must be a number or a string/],
    ['k', { value: {} }, /`value` must be a number or a string/],
    ['k', { value: NaN }, /finite number/],
    ['k', { value: Infinity }, /finite number/],
    ['k', { value: -Infinity, format: 'number' }, /finite number/],
    ['k', { value: 1e15 + 1e6 }, /absolute value of at most 1000000000000000/],
    ['k', { value: 'abc', format: 'number' }, /`value` must be a number for the number format/],
    ['k', { value: '1e5', format: 'number' }, /must be a number/],
    ['k', { value: 'NaN', format: 'percent' }, /must be a number/],
    ['k', { value: '0x10', format: 'unit', unit: 'ms' }, /must be a number/],
    ['k', { value: 'x'.repeat(25) }, /1–24 characters/],
    ['k', { value: 'a\nb' }, /control characters/],
    ['k', { value: 5, format: 'text' }, /must be a string for the text format/],
    ['k', { value: 'x'.repeat(25), format: 'text' }, /1–24 characters for the text format/],
    ['k', { value: 1, format: 'money' }, /`format` must be one of: number, currency, percent, unit, text/],
    ['k', { value: 1, label: '' }, /`label` must be 1–24/],
    ['k', { value: 1, label: 'x'.repeat(25) }, /`label` must be 1–24/],
    ['k', { value: 1, label: 'a\tb' }, /`label` must not contain control characters/],
    ['k', { value: 1, label: 5 }, /`label` must be a string/],
    ['k', { value: 1, format: 'number', unit: 'ms' }, /only allowed with the currency and unit formats/],
    ['k', { value: 'a', format: 'text', unit: 'ms' }, /only allowed with the currency and unit formats/],
    ['k', { value: 1, format: 'percent', unit: '%' }, /only allowed with the currency and unit formats/],
    ['k', { value: 1, format: 'currency', unit: 'US' }, /ISO 4217 code/],
    ['k', { value: 1, format: 'currency', unit: 'USDX' }, /ISO 4217 code/],
    ['k', { value: 1, format: 'currency', unit: '123' }, /ISO 4217 code/],
    ['k', { value: 1, format: 'unit', unit: 'abcdefghi' }, /`unit` must be 1–8/],
    ['k', { value: 1, format: 'unit', unit: '' }, /`unit` must be 1–8/],
  ]) {
    assert.throws(() => pr.metrics.set('ab12', key, input), (e) => invalid(e) && expected.test(e.message), `${String(key)} ${JSON.stringify(input)}`);
  }
  assert.equal(calls.length, 0);
});

test('the label, unit and text limits count code points, as the server does', async () => {
  const { fetchMock } = recorder({ '*': ({ init }) => ({ body: stored({ ...JSON.parse(init.body) }) }) });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  await pr.metrics.set('ab12', 'k', { value: 1, label: '😀'.repeat(24) });
  assert.throws(() => pr.metrics.set('ab12', 'k', { value: 1, label: '😀'.repeat(25) }), invalid);
  await pr.metrics.set('ab12', 'k', { value: '😀'.repeat(24), format: 'text' });
  assert.throws(() => pr.metrics.set('ab12', 'k', { value: '😀'.repeat(25), format: 'text' }), invalid);
});

test('a currency code is checked for its shape only; the server owns the list', async () => {
  const { calls, fetchMock } = recorder({ '*': ({ init }) => ({ body: stored({ ...JSON.parse(init.body) }) }) });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  // ZZZ is not an ISO 4217 code and the server will refuse it, but a code ISO
  // adds later must not be refused here first.
  await pr.metrics.set('ab12', 'k', { value: 1, format: 'currency', unit: 'zzz' });
  assert.equal(JSON.parse(calls[0].init.body).unit, 'zzz');
});

test('metrics.delete sends DELETE for the lowercased key and resolves with nothing', async () => {
  const { calls, fetchMock } = recorder({
    'DELETE /api/agent/rooms/ab12/metrics/mrr': () => ({ body: { message: 'Metric deleted successfully' } }),
    'DELETE /api/agent/rooms/ab12/metrics/gone': () => ({ status: 404, body: { message: 'Metric not found', code: 'metric_not_found' } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  assert.equal(await pr.metrics.delete('ab12', 'MRR'), undefined);
  assert.equal(calls[0].init.method, 'DELETE');
  await assert.rejects(
    () => pr.metrics.delete('ab12', 'gone'),
    (e) => e instanceof PingRoomError && e.status === 404 && e.code === 'metric_not_found',
  );
  await assert.rejects(() => pr.metrics.delete('ab12', '..'), invalid);
  await assert.rejects(() => pr.metrics.delete('ab12', 'bad key'), invalid);
});

test('a refusal carries its code, status and the server message', async () => {
  const { fetchMock } = recorder({
    'PUT /api/agent/rooms/ab12/metrics/full': () => ({ status: 422, body: { message: 'Maximum of 8 metrics per room reached.', code: 'metrics_limit_reached' } }),
    'PUT /api/agent/rooms/ab12/metrics/off': () => ({ status: 403, body: { message: 'Room metrics are turned off.', code: 'feature_disabled', feature: 'rooms.metrics' } }),
    'PUT /api/agent/rooms/ab12/metrics/scope': () => ({ status: 403, body: { code: 'insufficient_scope', message: 'This credential lacks pingroom:metrics:write' } }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  await assert.rejects(() => pr.metrics.set('ab12', 'full', { value: 1 }), (e) => e.code === 'metrics_limit_reached' && e.status === 422 && METRIC_ERROR_CODES.includes(e.code));
  await assert.rejects(() => pr.metrics.set('ab12', 'off', { value: 1 }), (e) => e.code === 'feature_disabled' && e.status === 403);
  await assert.rejects(() => pr.metrics.set('ab12', 'scope', { value: 1 }), (e) => e.code === 'insufficient_scope');
});

test('normalizeMetricKey trims, lowercases ASCII only and checks the stored shape', () => {
  assert.equal(normalizeMetricKey('  Open-Tickets_2 '), 'open-tickets_2');
  assert.throws(() => normalizeMetricKey('É'), invalid);
  assert.throws(() => normalizeMetricKey('İ'), invalid);
  assert.throws(() => normalizeMetricKey(undefined), invalid);
});

// --- the incoming webhook's `metric` body -----------------------------------

const HOOK = 'https://api.pingroom.io/api/webhooks/AB12/secret';

test('sendIncomingWebhook posts a top-level metric and returns the stored metric', async () => {
  let captured;
  const fetchMock = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ success: true, metric: stored() }), { status: 201 });
  };

  const result = await sendIncomingWebhook(HOOK, { metric: { key: 'MRR', value: 12400, label: 'MRR', format: 'currency', unit: 'USD' } }, { fetch: fetchMock });

  assert.equal(result.success, true);
  assert.equal(result.metric.key, 'mrr');
  assert.equal(result.unchanged, undefined);
  assert.deepEqual(JSON.parse(captured.init.body), { metric: { key: 'MRR', value: 12400, label: 'MRR', format: 'currency', unit: 'USD' } });
  assert.equal(captured.init.headers.Authorization, undefined);
});

test('sendIncomingWebhook reports a repeated metric value as unchanged', async () => {
  const fetchMock = async () => new Response(JSON.stringify({ success: true, unchanged: true, metric: stored() }), { status: 200 });
  const result = await sendIncomingWebhook(HOOK, { metric: { key: 'mrr', value: 12400 } }, { fetch: fetchMock });
  assert.equal(result.unchanged, true);
});

test('sendIncomingWebhook validates a metric like metrics.set and refuses it with live_status', async () => {
  let requests = 0;
  const fetchMock = async () => {
    requests += 1;
    return new Response('{"success":true}', { status: 200 });
  };

  for (const [payload, expected] of [
    [{ metric: { key: 'bad key', value: 1 } }, /`metric.key` must be 1–40/],
    [{ metric: { key: 'mrr' } }, /`metric.value` is required/],
    [{ metric: { key: 'mrr', value: NaN } }, /finite number/],
    [{ metric: { key: 'mrr', value: 1, format: 'currency', unit: 'US' } }, /`metric.unit` for the currency format/],
    [{ metric: { key: 'mrr', value: 1, format: 'number', unit: 'ms' } }, /`metric.unit` is only allowed/],
    [{ metric: { key: 'mrr', value: 'x'.repeat(25), format: 'text' } }, /`metric.value` must be 1–24/],
    [{ metric: 'mrr' }, /`metric` must be an object/],
    [{ metric: null }, /`metric` must be an object/],
    [{ metric: [1] }, /`metric` must be an object/],
    [{ metric: { key: 'mrr', value: 1 }, live_status: { state: 'running' }, correlation_id: 'c' }, /cannot be combined with `live_status`/],
  ]) {
    await assert.rejects(
      () => sendIncomingWebhook(HOOK, payload, { fetch: fetchMock }),
      (e) => invalid(e) && expected.test(e.message),
      JSON.stringify(payload),
    );
  }
  assert.equal(requests, 0);
});

test('sendIncomingWebhook surfaces the webhook envelope refusals of a metric', async () => {
  const fetchMock = async () => new Response(JSON.stringify({
    success: false, error: 'metrics_limit_reached', code: 'metrics_limit_reached', message: 'Maximum of 8 metrics per room reached.',
  }), { status: 422 });

  await assert.rejects(
    () => sendIncomingWebhook(HOOK, { metric: { key: 'ninth', value: 1 } }, { fetch: fetchMock }),
    (e) => e instanceof PingRoomError && e.status === 422 && e.code === 'metrics_limit_reached',
  );
});
