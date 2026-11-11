import { PingRoomError } from '../errors.js';

/** Mirrors the server's structured-`data` limits so oversized payloads fail fast, locally. */
export const MAX_DATA_BYTES = 8 * 1024;
export const MAX_DATA_KEYS = 25;
export const MAX_PRIVATE_PING_MESSAGE_LENGTH = 120;
export const MAX_PUBLIC_PING_MESSAGE_LENGTH = 160;
export const MAX_PING_TITLE_LENGTH = 40;

/** Count Unicode code points, matching Laravel's multibyte string validation. */
function characterLength(value: string): number {
  return Array.from(value).length;
}

export function assertMaxLength(value: unknown, max: number, field: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'string') {
    throw new PingRoomError(`\`${field}\` must be a string.`, { code: 'invalid_request' });
  }
  const length = characterLength(value);
  if (length > max) {
    throw new PingRoomError(
      `\`${field}\` may have at most ${max} characters (got ${length}).`,
      { code: 'invalid_request' },
    );
  }
}

/**
 * Bytes a JSON string takes as PHP's default json_encode() writes it, which is
 * what the server's 8 KB cap measures: every non-ASCII UTF-16 unit becomes a
 * six-byte `\uXXXX` escape and `/` becomes `\/`. Non-Latin text is several
 * times larger there than its UTF-8 size.
 */
export function serverJsonByteLength(json: string): number {
  let bytes = 0;
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    if (code > 0x7f) bytes += 6;
    else if (code === 0x2f) bytes += 2;
    else bytes += 1;
  }
  return bytes;
}

export function assertStructuredData(data: unknown): void {
  if (data === undefined || data === null) {
    return;
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new PingRoomError('`data` must be a JSON object (not an array or scalar).', { code: 'invalid_data' });
  }
  const keys = Object.keys(data as object);
  if (keys.length > MAX_DATA_KEYS) {
    throw new PingRoomError(`\`data\` may have at most ${MAX_DATA_KEYS} keys (got ${keys.length}).`, { code: 'invalid_data' });
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(data);
  } catch {
    throw new PingRoomError('`data` must be JSON-serializable.', { code: 'invalid_data' });
  }
  const bytes = serverJsonByteLength(encoded);
  if (bytes > MAX_DATA_BYTES) {
    throw new PingRoomError(`\`data\` is too large (${bytes} bytes, max ${MAX_DATA_BYTES}).`, { code: 'invalid_data' });
  }
}

/** Mirrors `App\Support\PingTagRules`: at most 10 tags, each 1–32 characters. */
export const MAX_PING_TAGS = 10;
export const MAX_PING_TAG_LENGTH = 32;
/** A letter or digit first, then letters, digits, `-` and `_`. Matches a tag as the server stores it. */
export const PING_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * What the server does to a tag before it checks it: trim, then lowercase
 * ASCII only (PHP 8's `strtolower`), so a non-ASCII letter never folds into a
 * valid one. The trim set is a superset of the server's, so this is never
 * stricter than the route behind it.
 */
function normalizeTag(tag: string): string {
  return tag.replace(/^[\s\uFEFF\u200B]+|[\s\uFEFF\u200B]+$/g, '').replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function tagShape(): string {
  return `a tag is 1 to ${MAX_PING_TAG_LENGTH} characters: lowercase letters, digits, "-" and "_", starting with a letter or digit`;
}

function assertTagText(tag: string, field: string): void {
  if (!PING_TAG_PATTERN.test(tag)) {
    throw new PingRoomError(
      `\`${field}\` ${JSON.stringify(tag.length > 40 ? `${tag.slice(0, 40)}…` : tag)} is not a valid tag: ${tagShape()}.`,
      { code: 'invalid_request' },
    );
  }
}

/**
 * Check a ping's `tags` the way the server does: trimmed, lowercased, blanks
 * dropped and duplicates removed first, then at most 10, each matching the tag
 * rule. The payload is sent as given; the server normalizes it the same way, so
 * `['Deploy ', 'deploy']` is one tag.
 */
export function assertTags(tags: unknown, field = 'tags'): void {
  if (tags === undefined || tags === null) {
    return;
  }
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new PingRoomError(`\`${field}\` must be an array of strings.`, { code: 'invalid_request' });
  }
  const normalized = [...new Set((tags as string[]).map(normalizeTag).filter((tag) => tag !== ''))];
  if (normalized.length > MAX_PING_TAGS) {
    throw new PingRoomError(
      `\`${field}\` may have at most ${MAX_PING_TAGS} tags (got ${normalized.length}).`,
      { code: 'invalid_request' },
    );
  }
  for (const tag of normalized) {
    assertTagText(tag, field);
  }
}

/** Check the single `tag` a read filters by, with the same rule as one entry of `tags`. */
export function assertTag(tag: unknown, field = 'tag'): void {
  if (tag === undefined) {
    return;
  }
  if (typeof tag !== 'string') {
    throw new PingRoomError(`\`${field}\` must be a string.`, { code: 'invalid_request' });
  }
  assertTagText(normalizeTag(tag), field);
}

export function assertActionNumber(n: unknown): void {
  if (n === undefined || n === null) {
    return;
  }
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 16) {
    throw new PingRoomError('action_number must be an integer 1–16.', { code: 'invalid_request' });
  }
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
/** PHP trim()'s default set: what the server strips from both ends of a key. */
const SERVER_TRIM = /^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g;

/**
 * Normalize an idempotency key the way the server reads it
 * (`RequestIdempotency::keyFrom`): trimmed, then 1–255 characters. It travels
 * as the `Idempotency-Key` header, so it must also be printable ASCII (space
 * included): fetch throws on a character outside Latin-1, which surfaced as a
 * retryable `network_error` that every retry repeated, and a Latin-1 byte above
 * 0x7E reaches the server as invalid UTF-8.
 */
export function normalizeIdempotencyKey(value: unknown, field = 'idempotencyKey'): string {
  if (typeof value !== 'string') {
    throw new PingRoomError(`\`${field}\` must be a string.`, { code: 'invalid_request' });
  }
  const key = value.replace(SERVER_TRIM, '');
  if (key.length < 1 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[\x20-\x7E]+$/.test(key)) {
    throw new PingRoomError(
      `\`${field}\` must be 1–${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters (letters, digits, punctuation or spaces).`,
      { code: 'invalid_request' },
    );
  }
  return key;
}

export function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PingRoomError(`\`${field}\` is required.`, { code: 'invalid_request' });
  }
}

/** Validate before uppercasing so Unicode case expansion cannot become a code. */
export function normalizeRedeemCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{12}$/.test(value.trim())) {
    throw new PingRoomError('The code must contain exactly 12 letters or digits.', { code: 'invalid_request' });
  }
  return value.trim().toUpperCase();
}

/**
 * The field must be sent, but may be empty — the server rule is `present`,
 * not `required`. A quick action's `label` is the case: a Ping can be named by
 * its emoji alone, so `''` is a deliberate value rather than a missing one.
 */
export function requirePresentString(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    throw new PingRoomError(`\`${field}\` must be a string.`, { code: 'invalid_request' });
  }
}
