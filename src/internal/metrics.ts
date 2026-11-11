// Room metric limits and the checks that mirror the server's RoomMetricRules
// (laravel/app/Support/RoomMetricRules.php), so a typo fails here, before a
// request, instead of as a 422. The server stays authoritative: it also knows the
// stored metric (a partial update is judged by the stored format) and the ISO
// 4217 code list, so nothing here is stricter than it. Only the `[A-Z]{3}` shape
// of a currency code is checked, so a code the server accepts is never refused.

import { PingRoomError } from '../errors.js';
import type { MetricFormat } from '../types/metrics.js';

/** Metrics one room can hold (`RoomMetric::MAX_PER_ROOM`). */
export const MAX_METRICS_PER_ROOM = 8;
/** Every format, in the server's order (`RoomMetric::FORMATS`). */
export const METRIC_FORMATS = ['number', 'currency', 'percent', 'unit', 'text'] as const satisfies readonly MetricFormat[];
export const MAX_METRIC_KEY_LENGTH = 40;
/** A key as the server stores it: a lowercase letter or digit first, then lowercase letters, digits, `-` and `_`. */
export const METRIC_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MAX_METRIC_LABEL_LENGTH = 24;
export const MAX_METRIC_UNIT_LENGTH = 8;
export const MAX_METRIC_TEXT_VALUE_LENGTH = 24;
/** Largest magnitude a numeric value may have. */
export const MAX_METRIC_ABSOLUTE_VALUE = 1e15;

const CURRENCY_SHAPE = /^[A-Z]{3}$/;
// A plain decimal, the only text the server reads as a number: no exponent, hex,
// padding, NaN or Infinity.
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

const characterLength = (value: string): number => Array.from(value).length;

function invalid(message: string): PingRoomError {
  return new PingRoomError(message, { code: 'invalid_request' });
}

/**
 * The key the server addresses a metric by: trimmed and lowercased (ASCII only,
 * like PHP's `strtolower`), then checked against {@link METRIC_KEY_PATTERN}.
 */
export function normalizeMetricKey(key: unknown, field = 'key'): string {
  if (typeof key !== 'string') {
    throw invalid(`\`${field}\` must be a string.`);
  }
  const normalized = key.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (!METRIC_KEY_PATTERN.test(normalized)) {
    throw invalid(
      `\`${field}\` must be 1–${MAX_METRIC_KEY_LENGTH} characters: letters, digits, "-" and "_", starting with a letter or digit.`,
    );
  }
  return normalized;
}

function assertShortText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') {
    throw invalid(`\`${field}\` must be a string.`);
  }
  const text = value.trim();
  if (text === '' || characterLength(text) > max) {
    throw invalid(`\`${field}\` must be 1–${max} characters.`);
  }
  if (CONTROL.test(text)) {
    throw invalid(`\`${field}\` must not contain control characters.`);
  }
  return text;
}

/** A numeric value must be a finite number (or a plain decimal string) within ±{@link MAX_METRIC_ABSOLUTE_VALUE}. */
function assertNumericValue(value: unknown, format: string | undefined, field: string): void {
  const label = format === undefined ? 'a number' : `a number for the ${format} format`;
  let number: number;
  if (typeof value === 'number') {
    number = value;
  } else if (typeof value === 'string' && DECIMAL.test(value.trim())) {
    number = Number(value.trim());
  } else {
    throw invalid(`\`${field}\` must be ${label}: a finite number, or a plain decimal string such as "12.5".`);
  }
  if (!Number.isFinite(number)) {
    throw invalid(`\`${field}\` must be a finite number (not NaN or Infinity).`);
  }
  if (Math.abs(number) > MAX_METRIC_ABSOLUTE_VALUE) {
    throw invalid(`\`${field}\` must have an absolute value of at most ${MAX_METRIC_ABSOLUTE_VALUE.toFixed(0)}.`);
  }
}

function assertTextValue(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    throw invalid(`\`${field}\` must be a string for the text format.`);
  }
  if (characterLength(value) > MAX_METRIC_TEXT_VALUE_LENGTH || value.trim() === '') {
    throw invalid(`\`${field}\` must be 1–${MAX_METRIC_TEXT_VALUE_LENGTH} characters for the text format.`);
  }
  if (CONTROL.test(value)) {
    throw invalid(`\`${field}\` must not contain control characters.`);
  }
}

export interface MetricWriteFields {
  value?: unknown;
  label?: unknown;
  format?: unknown;
  unit?: unknown;
}

/**
 * Check the fields of one metric write: the value (required when `requireValue`),
 * and the optional label, format and unit. Used by `metrics.set()` and by the
 * `metric` of `sendIncomingWebhook()`, which share the server rule.
 *
 * A value with no `format` is a number or a string: the server makes a new metric
 * `number` or `text` by its type and judges an existing one by its stored format,
 * so only what holds for either is checked.
 */
export function assertMetricFields(fields: MetricWriteFields, { requireValue }: { requireValue: boolean }, prefix = ''): void {
  const name = (field: string): string => `${prefix}${field}`;
  const { value, label, format, unit } = fields;

  if (format !== undefined && !(METRIC_FORMATS as readonly unknown[]).includes(format)) {
    throw invalid(`\`${name('format')}\` must be one of: ${METRIC_FORMATS.join(', ')}.`);
  }
  if (label !== undefined) {
    assertShortText(label, MAX_METRIC_LABEL_LENGTH, name('label'));
  }

  if (unit !== undefined && unit !== null) {
    if (format !== undefined && format !== 'currency' && format !== 'unit') {
      throw invalid(`\`${name('unit')}\` is only allowed with the currency and unit formats.`);
    }
    const text = assertShortText(unit, MAX_METRIC_UNIT_LENGTH, name('unit'));
    if (format === 'currency' && !CURRENCY_SHAPE.test(text.toUpperCase())) {
      throw invalid(`\`${name('unit')}\` for the currency format must be an ISO 4217 code such as USD.`);
    }
  }

  if (value === undefined || value === null) {
    if (requireValue) {
      throw invalid(`\`${name('value')}\` is required.`);
    }
    return;
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw invalid(`\`${name('value')}\` must be a number or a string.`);
  }
  if (format === 'text') {
    assertTextValue(value, name('value'));
  } else if (format !== undefined || typeof value === 'number') {
    assertNumericValue(value, format as string | undefined, name('value'));
  } else {
    // No format and a string: text for a new metric, a number for an existing
    // numeric one. Hold it to the limits both would.
    if (characterLength(value) > MAX_METRIC_TEXT_VALUE_LENGTH || value.trim() === '' || CONTROL.test(value)) {
      throw invalid(`\`${name('value')}\` must be a number, or a string of 1–${MAX_METRIC_TEXT_VALUE_LENGTH} characters without control characters.`);
    }
  }
}
