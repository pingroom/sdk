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
 * Authentication and schema-validation failures may have no machine code; use
 * `status` for those responses. This union covers every coded Handoff response.
 */
export type HandoffErrorCode =
  | 'feature_temporarily_unavailable'
  | 'handoff_room_unsupported'
  | 'invalid_target'
  | 'target_not_found'
  | 'target_unavailable'
  | 'pings_closed'
  | 'not_room_member'
  | 'recipient_not_ready'
  | 'idempotency_conflict'
  | 'invalid_idempotency_key'
  | 'capability_check_unavailable'
  | 'insufficient_scope'
  // The room is outside the grant the human gave this agent when connecting.
  | 'room_not_granted'
  | 'free_limit_reached';

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

export type AgentInboxActivationIncompleteReason =
  | 'deadline_exceeded'
  | 'answered_without_completion'
  | 'expired'
  | 'cancelled';

/**
 * The onboarding Question reached a non-activating terminal outcome, or the
 * caller's overall activation deadline elapsed. The client's credential is not
 * changed or revoked when this error is thrown.
 */
export class PingRoomActivationIncompleteError extends PingRoomError {
  readonly reason: AgentInboxActivationIncompleteReason;

  constructor(
    reason: AgentInboxActivationIncompleteReason,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message, {
      code: 'inbox_activation_incomplete',
      body: { reason, ...details },
    });
    this.name = 'PingRoomActivationIncompleteError';
    this.reason = reason;
  }
}
