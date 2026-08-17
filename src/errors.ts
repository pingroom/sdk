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
 * The codes the `agent.room` gate emits on every ROOM-SCOPED route — the ones
 * whose path carries an invite code: `rooms.get()`, `actions.list()`,
 * `actions.trigger()`, `broadcast()`, the webhook calls, and
 * `liveStatus.get()`/`liveStatus.push()`. HTTP 403.
 *
 * NOT reachable from `handoffs.create()`: `POST /api/agent/handoffs` names no
 * room in its path and so is not behind that gate.
 *
 * Server: `EnsureAgentRoomAccess` middleware.
 */
export const ROOM_SCOPED_ERROR_CODES = [
  // The room is outside the grant the human gave this agent when connecting.
  'room_not_granted',
] as const;

/**
 * The machine `code`s a handoff create/read can surface on a {@link PingRoomError}.
 * Branch on `error.code` (and `error.status`) instead of the message.
 *
 * Authentication and schema-validation failures may have no machine code; use
 * `status` for those responses. This union covers every coded Handoff response.
 *
 * Server: `AgentHandoffController`, `HandoffService`, `RequestIdempotency`, the
 * `agent.scope`/`agent.quota` middleware, and the `RecipientNotReady` /
 * `CapabilityCheckUnavailable` renderers in `bootstrap/app.php`.
 */
export const HANDOFF_ERROR_CODES = [
  'feature_temporarily_unavailable',
  'handoff_room_unsupported',
  'invalid_target',
  // The agent has no delivery room designated; the human must pick one.
  'no_room_configured',
  // An agent may hand off only to the account that connected it.
  'target_not_permitted',
  'recipient_not_ready',
  'idempotency_conflict',
  'invalid_idempotency_key',
  'capability_check_unavailable',
  'insufficient_scope',
  'free_limit_reached',
] as const;

/**
 * The coded failures of the Inbox activation path (`inbox.ensure()` /
 * `inbox.activate()`). All HTTP 409 except `feature_temporarily_unavailable`,
 * which is 422.
 *
 * Server: `AgentInboxController`.
 */
export const AGENT_INBOX_ERROR_CODES = [
  // Already activated, but the original connection-test record is gone.
  'activation_evidence_unavailable',
  // The human must pick the room this agent pings them in.
  'no_room_configured',
  // The chosen room is muted, or the human is no longer a member of it.
  'activation_room_muted',
  // No device could render the activation Question.
  'activation_delivery_unavailable',
  'feature_temporarily_unavailable',
] as const;

/** @see ROOM_SCOPED_ERROR_CODES */
export type RoomScopedErrorCode = (typeof ROOM_SCOPED_ERROR_CODES)[number];

/** @see HANDOFF_ERROR_CODES */
export type HandoffErrorCode = (typeof HANDOFF_ERROR_CODES)[number];

/** @see AGENT_INBOX_ERROR_CODES */
export type AgentInboxErrorCode = (typeof AGENT_INBOX_ERROR_CODES)[number];

/**
 * Every machine `code` this SDK's typed unions cover, for callers that branch
 * once across surfaces instead of per-endpoint.
 */
export type AgentErrorCode = HandoffErrorCode | RoomScopedErrorCode | AgentInboxErrorCode;

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
