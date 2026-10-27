import { PingRoomError } from '../errors.js';
import { sleep, throwIfAborted } from './async.js';

/** First retry delay after a transient failure, in ms. */
export const TRANSIENT_BACKOFF_BASE_MS = 1000;
/** Ceiling on the exponential backoff (a server Retry-After may ask for longer). */
export const TRANSIENT_BACKOFF_CAP_MS = 30_000;
/** setTimeout fires immediately above this, so no delay may exceed it. */
const MAX_TIMER_MS = 2_147_483_647;

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
}

/**
 * The shared human-in-the-loop wait loop. Polls until a validated response is
 * terminal; retries transient failures with backoff; rejects with the
 * signal's reason once it aborts. A response that fails validation is never
 * returned as an outcome.
 */
export async function pollUntilSettled<T>(options: PollUntilSettledOptions<T>): Promise<T> {
  const { poll, validate, settled, signal, minIntervalMs = 0 } = options;
  let failures = 0;
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
      await sleep(transientDelayMs(error, failures), signal);
      continue;
    }
    failures = 0;
    if (settled(value)) {
      return value;
    }
    // An injected transport can resolve pending polls immediately. Yield
    // between them so timer-driven cancellation and deadlines can run.
    await sleep(Math.max(0, minIntervalMs - (Date.now() - startedAt)), signal);
  }
}
