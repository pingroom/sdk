// Request building shared by the PingRoom namespaces: path segments, bodies,
// the Idempotency-Key header, ping input checks and long-poll timing.

import { PingRoomError } from '../errors.js';
import {
  assertActionNumber,
  assertMaxLength,
  assertStructuredData,
  MAX_PING_TITLE_LENGTH,
  MAX_PUBLIC_PING_MESSAGE_LENGTH,
  normalizeIdempotencyKey,
  requireNonEmpty,
} from './guards.js';
import type { PingInput } from '../types.js';

/** Extra wall-clock allowance over the server's hold window for long-poll calls. */
const LONG_POLL_BUFFER_MS = 10_000;
const DEFAULT_WAIT_SECONDS = 20;

/**
 * Minimum spacing between the starts of two handoff-wait polls. The route is
 * throttled at 30 requests a minute per human; a short or zero `timeout`
 * would otherwise let one loop exhaust it.
 */
export const MIN_HANDOFF_POLL_INTERVAL_MS = 2100;
/**
 * Minimum spacing between the starts of two `listen()` polls after an empty
 * answer. `notifications/wait` is throttled at 30 requests a minute per human,
 * shared with every other listener on the account (the CLI, other agents); a
 * zero hold or a proxy that answers early would otherwise spin the loop and
 * keep that bucket exhausted. Same floor as the handoff wait.
 */
export const MIN_LISTEN_POLL_INTERVAL_MS = MIN_HANDOFF_POLL_INTERVAL_MS;
/**
 * Minimum spacing between the starts of two approval or question wait polls.
 * The server normally holds each one, but a proxy or a zero hold that answers
 * `pending` at once would otherwise spin the loop and keep the human's shared
 * 30-per-minute wait bucket exhausted. Same floor as the CLI.
 */
export const MIN_WAIT_POLL_INTERVAL_MS = 1000;

export function enc(segment: string): string {
  // encodeURIComponent leaves `.` and `..` alone, and URL parsing then
  // resolves them as dot segments: `live.get('AB12', '..')` would request the
  // room itself. No id is empty or a dot segment, so refuse them.
  if (segment === '' || segment === '.' || segment === '..') {
    throw new PingRoomError('A path parameter may not be empty, `.` or `..`.', { code: 'invalid_request' });
  }
  return encodeURIComponent(segment);
}

/**
 * Lift the SDK-only `idempotencyKey` out of an input and into the
 * `Idempotency-Key` header the server reads. The server trims the key and
 * accepts 1–255 characters; as a header it must also be printable ASCII.
 */
export function splitIdempotencyKey<T extends { idempotencyKey?: string }>(
  input: T,
): { body: Omit<T, 'idempotencyKey'>; headers?: Record<string, string> } {
  const { idempotencyKey, ...body } = input;
  if (idempotencyKey === undefined) {
    return { body };
  }
  return { body, headers: { 'Idempotency-Key': normalizeIdempotencyKey(idempotencyKey) } };
}

/** `onRetry`, when given, must be callable: a TypeError mid-outage would hide the real failure. */
export function assertOnRetry(onRetry: unknown): void {
  if (onRetry !== undefined && typeof onRetry !== 'function') {
    throw new PingRoomError('`onRetry` must be a function.', { code: 'invalid_request' });
  }
}

export function dropUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

export function assertPing(ping: PingInput): void {
  requireNonEmpty(ping.message, 'message');
  // The invite code does not expose room visibility. Permit the public-room
  // ceiling locally; Laravel applies 120 for private and 160 for public rooms.
  assertMaxLength(ping.message, MAX_PUBLIC_PING_MESSAGE_LENGTH, 'message');
  assertMaxLength(ping.title, MAX_PING_TITLE_LENGTH, 'title');
  assertActionNumber(ping.action_number);
  assertStructuredData(ping.data);
}

export function waitTimeoutMs(seconds: number | undefined): number {
  return (seconds ?? DEFAULT_WAIT_SECONDS) * 1000 + LONG_POLL_BUFFER_MS;
}
