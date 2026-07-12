/**
 * Error types. PingRoomError carries the HTTP status and the API's machine
 * `code` (e.g. `pings_closed`, `cooldown`, `rate_limited`) so callers can branch
 * without string-matching messages. The agent token is NEVER stored on or
 * serialized through an error.
 */

export interface ApiErrorBody {
  code?: string;
  error?: string;
  message?: string;
  retry_after?: number;
  [key: string]: unknown;
}

/**
 * The machine `code`s a handoff create/read can surface on a {@link PingRoomError}.
 * Branch on `error.code` (and `error.status`) instead of the message:
 *
 *   422 `feature_temporarily_unavailable` — handoffs disabled for this account.
 *   422 `handoff_room_unsupported`        — target room can't host a handoff.
 *   409 `recipient_not_ready`             — the human's device can't act (legacy-only).
 *   409 `idempotency_conflict`            — Idempotency-Key reused with a different body.
 *   503 `capability_check_unavailable`    — device-capability check couldn't run; retry.
 *   403 (scope/permission)               — missing `pingroom:handoffs:create` or not reachable.
 */
export type HandoffErrorCode =
  | 'feature_temporarily_unavailable'
  | 'handoff_room_unsupported'
  | 'recipient_not_ready'
  | 'idempotency_conflict'
  | 'capability_check_unavailable';

export interface PingRoomErrorInit {
  status?: number;
  code?: string | null;
  retryAfter?: number | null;
  body?: unknown;
}

export class PingRoomError extends Error {
  /** HTTP status, or 0 for client-side/network errors. */
  readonly status: number;
  /** Machine-readable code from the API body (`code` or `error`), or a client code. */
  readonly code: string | null;
  /** Seconds to wait before retrying, when the API or a Retry-After header provides it. */
  readonly retryAfter: number | null;
  /** The parsed response body (or raw text), for inspection. Contains no credentials. */
  readonly body: unknown;

  constructor(message: string, init: PingRoomErrorInit = {}) {
    super(message);
    this.name = 'PingRoomError';
    this.status = init.status ?? 0;
    this.code = init.code ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.body = init.body ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static fromResponse(status: number, body: unknown, headers?: Headers): PingRoomError {
    const b: ApiErrorBody = body && typeof body === 'object' ? (body as ApiErrorBody) : {};
    const code =
      (typeof b.code === 'string' && b.code) ||
      (typeof b.error === 'string' && b.error) ||
      null;
    const message =
      (typeof b.message === 'string' && b.message) ||
      (code ? code : `HTTP ${status}`);

    let retryAfter: number | null = typeof b.retry_after === 'number' ? b.retry_after : null;
    if (retryAfter === null && headers) {
      const h = headers.get('retry-after');
      if (h && /^\d+$/.test(h.trim())) {
        retryAfter = Number(h.trim());
      }
    }

    return new PingRoomError(message, { status, code, retryAfter, body });
  }
}

/** Thrown when a request exceeds its timeout. */
export class PingRoomTimeoutError extends PingRoomError {
  constructor(message = 'Request timed out') {
    super(message, { code: 'timeout' });
    this.name = 'PingRoomTimeoutError';
  }
}

/** Thrown when the underlying fetch fails (DNS, connection, TLS, etc.). */
export class PingRoomNetworkError extends PingRoomError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'network_error' });
    this.name = 'PingRoomNetworkError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}
