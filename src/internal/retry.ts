import { PingRoomError } from '../errors.js';
import { sleep, throwIfAborted } from './async.js';

/** First retry delay after a transient failure, in ms. */
export const TRANSIENT_BACKOFF_BASE_MS = 1000;
/** Ceiling on the exponential backoff (a server Retry-After may ask for longer). */
export const TRANSIENT_BACKOFF_CAP_MS = 30_000;
/** setTimeout fires immediately above this, so no delay may exceed it. */
const MAX_TIMER_MS = 2_147_483_647;
/**
 * How long past the last-seen `expires_at` a wait keeps retrying an
 * unreachable API. The server reports `expired` once expires_at passes, so
 * after this the only outcome left is one that cannot be read. Covers clock
 * skew. Same bound as the CLI.
 */
export const WAIT_EXPIRY_GRACE_MS = 5 * 60_000;
/** The bound on an unbroken outage while no response has carried `expires_at`. */
export const WAIT_UNKNOWN_EXPIRY_OUTAGE_MS = 15 * 60_000;

/**
 * A failure a read loop may retry: a dropped connection, a request deadline,
 * a 429 (the wait routes share one 30/min bucket per human), or a 5xx.
 * Everything else — 401/403/404/422, a refused redirect, a malformed response —
 * is permanent and must surface to the caller.
 */
export function isTransientError(error: unknown): error is PingRoomError {
  return (
    error instanceof PingRoomError
    && (error.code === 'network_error'
      || error.code === 'timeout'
      || error.status === 429
      || error.status >= 500)
  );
}

/**
 * Delay before retrying after the `failures`-th consecutive transient failure:
 * exponential from `baseMs`, capped at 30 s. A server `retryAfter` replaces the
 * exponential step, but is never waited for less than `baseMs`.
 */
export function transientDelayMs(
  error: PingRoomError,
  failures: number,
  baseMs: number = TRANSIENT_BACKOFF_BASE_MS,
): number {
  const base = Number.isFinite(baseMs) && baseMs >= 0 ? baseMs : TRANSIENT_BACKOFF_BASE_MS;
  const retryAfter = error.retryAfter;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(MAX_TIMER_MS, Math.max(retryAfter * 1000, base));
  }
  const step = Math.min(Math.max(0, failures - 1), 5);
  return Math.min(MAX_TIMER_MS, Math.max(base, TRANSIENT_BACKOFF_CAP_MS), base * 2 ** step);
}

export interface PollUntilSettledOptions<T> {
  /** One bounded long-poll. Its errors are retried only when transient. */
  poll: () => Promise<unknown>;
  /** Check the response's minimal shape; throw `invalid_response` otherwise. */
  validate: (value: unknown) => T;
  /** True once the validated value is terminal. */
  settled: (value: T) => boolean;
  signal?: AbortSignal;
  /** Minimum time between the starts of two polls, in ms. Default 0. */
  minIntervalMs?: number;
  /** Read `expires_at` (an ISO time) from a validated response; it bounds an outage. */
  expiresAt?: (value: T) => unknown;
  /** Names what is waited on in the give-up message, e.g. `approval a1`. */
  what: string;
  /** Called before each retry of a transient failure; `attempt` counts consecutive failures from 1. */
  onRetry?: (error: PingRoomError, attempt: number) => void;
}

function timeOf(value: unknown): number | null {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

function unavailable(last: PingRoomError, since: number, what: string): PingRoomError {
  const reason = last.status > 0 ? `HTTP ${last.status}` : (last.code ?? 'network error');
  return new PingRoomError(
    `PingRoom unavailable since ${new Date(since).toISOString()} (${reason}); stopped waiting for ${what}.`,
    { code: 'unavailable', cause: last },
  );
}

/**
 * The shared human-in-the-loop wait loop. Polls until a validated response is
 * terminal; retries transient failures with backoff; rejects with the
 * signal's reason once it aborts. A response that fails validation is never
 * returned as an outcome.
 *
 * The retries are bounded even without a signal. Once only failures have come
 * back since the last valid response, and the last-seen `expires_at` plus
 * {@link WAIT_EXPIRY_GRACE_MS} has passed (or, before any `expires_at` was
 * seen, after {@link WAIT_UNKNOWN_EXPIRY_OUTAGE_MS} of unbroken failures), the
 * wait rejects with `unavailable`, the last failure as its `cause`.
 */
export async function pollUntilSettled<T>(options: PollUntilSettledOptions<T>): Promise<T> {
  const { poll, validate, settled, signal, minIntervalMs = 0, expiresAt, what, onRetry } = options;
  let failures = 0;
  let failingSince: number | null = null;
  // expires_at plus grace, from the last valid response that carried one.
  let deadline: number | null = null;
  for (;;) {
    throwIfAborted(signal);
    const startedAt = Date.now();
    let value: T;
    try {
      value = validate(await poll());
    } catch (error) {
      throwIfAborted(signal);
      if (!isTransientError(error)) {
        throw error;
      }
      failures += 1;
      failingSince ??= Date.now();
      const remaining = (deadline ?? failingSince + WAIT_UNKNOWN_EXPIRY_OUTAGE_MS) - Date.now();
      if (remaining <= 0) {
        throw unavailable(error, failingSince, what);
      }
      onRetry?.(error, failures);
      // Never sleep past the bound: the last attempt lands on it, not after it.
      await sleep(Math.min(transientDelayMs(error, failures), remaining), signal);
      continue;
    }
    failures = 0;
    failingSince = null;
    const expiry = expiresAt ? timeOf(expiresAt(value)) : null;
    if (expiry !== null) {
      deadline = expiry + WAIT_EXPIRY_GRACE_MS;
    }
    if (settled(value)) {
      return value;
    }
    // An injected transport can resolve pending polls immediately. Yield
    // between them so timer-driven cancellation and deadlines can run.
    await sleep(Math.max(0, minIntervalMs - (Date.now() - startedAt)), signal);
  }
}
