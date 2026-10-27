import type { PingRoomError } from '../errors.js';
import type { JsonObject } from './common.js';

// --- approvals ------------------------------------------------------------

export interface ApprovalInput {
  question: string;
  title?: string;
  options?: string[];
  correlation_id?: string;
  data?: JsonObject;
  ttl?: number;
  /**
   * Sent as the `Idempotency-Key` header (1–255 printable ASCII characters,
   * spaces allowed), never in the body.
   * Reuse the same key when retrying after a timeout or network error: the
   * server replays the first result instead of asking the human a second time.
   */
  idempotencyKey?: string;
}

export interface Approval {
  id: string;
  /**
   * A human answer has status `decided`; inspect `decision` for the chosen
   * option. `approved`/`denied` are never sent.
   */
  status: 'pending' | 'decided' | 'expired' | 'cancelled' | (string & {});
  question: string;
  title: string | null;
  options: string[];
  decision: string | null;
  decided_at: string | null;
  expires_at: string | null;
  correlation_id: string | null;
  data: JsonObject | null;
  /** Null when the approval's room no longer exists. */
  room_code: string | null;
  [key: string]: unknown;
}

export interface WaitApprovalInput {
  /** Seconds the server holds the connection (0–30, default 20). */
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Options for the blocking waits: `approvals.waitForDecision()`,
 * `questions.waitForAnswer()` and `handoffs.waitForResult()`.
 *
 * Network errors, request timeouts, 429 and 5xx are retried with backoff. The
 * retries stop with `PingRoomError` code `unavailable` (the last failure as
 * its `cause`) once only failures have come back since the last valid
 * response and the last-seen `expires_at` is more than 5 minutes past, or,
 * before any `expires_at` was seen, after 15 minutes of unbroken failures.
 */
export interface WaitForOutcomeOptions {
  /** Abort to stop waiting; the wait rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Called before each retry of a transient failure, with that failure and
   * the number of consecutive failures so far (1 on the first). Throwing from
   * it ends the wait with the thrown error.
   */
  onRetry?: (error: PingRoomError, attempt: number) => void;
}
