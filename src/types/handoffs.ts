import type { JsonObject } from './common.js';
import type { QuestionResponder } from './questions.js';

// --- handoffs -------------------------------------------------------------
//
// A handoff is the Agent → one-human loop: DIRECT (exactly one human) and
// PRIVATE (no other room member can read it). It's a façade over the ack and
// question primitives, so its state space is the union of the two — kept
// DISTINCT per kind:
//
//   ack      → open | acked | expired
//   question → pending | answered | expired | cancelled
//
// A negative answer to a question handoff (e.g. `hold`/`deny`) is a SUCCESSFUL
// `answered` state, not an error.

/** Which primitive backs a handoff: an acknowledgement or a multi-option question. */
export type HandoffKind = 'ack' | 'question';

/** The lifecycle states of an `ack` handoff. Terminal: `acked`, `expired`. */
export type HandoffAckState = 'open' | 'acked' | 'expired';

/** The lifecycle states of a `question` handoff. Terminal: `answered`, `expired`, `cancelled`. */
export type HandoffQuestionState = 'answered' | 'expired' | 'cancelled' | 'pending';

/** The full handoff state space (union of ack + question states). */
export type HandoffState = HandoffAckState | HandoffQuestionState;

/**
 * Whether the ping was enqueued, remains pending dispatch, or exhausted its
 * retry budget (`failed`). Only populated on create; null on reads.
 */
export type HandoffDeliveryState = 'enqueued' | 'pending' | 'failed';

/** One option offered on a `question` handoff. A bare string is shorthand for `{ value, label: value }`. */
export interface HandoffOptionInput {
  /** Stable machine token returned as the answer. */
  value: string;
  /** Human text on the button (defaults to `value`). */
  label?: string;
  /** Presentation hint: `primary` = affirmative, `danger` = cancel/negative. */
  style?: 'primary' | 'danger' | 'default';
}

export type HandoffOptionSpec = string | HandoffOptionInput;

/** A resolved option on the handoff wire shape. */
export interface HandoffOption {
  value: string;
  label: string;
  [key: string]: unknown;
}

/** The human who acknowledged an `ack` handoff (present once `state === 'acked'`). */
export interface HandoffAcker {
  /** Null when the actor is redacted (reader-privacy). */
  id: string | null;
  display_name: string | null;
}

/** The resolution of a `question` handoff (present once `state === 'answered'`). */
export interface HandoffAnswer {
  /** The chosen option's `value`, or null for a text-only answer. */
  value: string | null;
  /** The chosen option's `label`. */
  label: string | null;
  /** The typed answer, when the question invited one. */
  text: string | null;
  /** The authenticated human who answered. */
  responder: QuestionResponder | null;
  answered_at: string | null;
}

/**
 * The public handoff wire shape — identical across create / get / wait / list.
 * `options`/`answer` appear on question handoffs; `acked_by`/`acked_at` on ack
 * handoffs.
 */
export interface Handoff {
  id: string;
  kind: HandoffKind;
  prompt: string;
  state: HandoffState;
  /** Delivery status, populated only on create; null on reads. */
  delivery_state: HandoffDeliveryState | null;
  correlation_id: string | null;
  reply_to: string | null;
  data: JsonObject | null;
  expires_at: string | null;
  created_at: string | null;
  /** ack handoff: the human who acknowledged (once `state === 'acked'`). */
  acked_by?: HandoffAcker | null;
  /** ack handoff: when it was acknowledged. */
  acked_at?: string | null;
  /** question handoff: the offered options. */
  options?: HandoffOption[];
  /** question handoff: the resolution (once `state === 'answered'`). */
  answer?: HandoffAnswer | null;
  /**
   * Question handoffs used for Agent Inbox onboarding expose whether the
   * server recorded the exact delivery + answer + agent-observation event.
   */
  activation_completed?: boolean;
  [key: string]: unknown;
}

/** Ask a human to acknowledge (the ack handoff). Resolves on the first acknowledgement. */
export interface RequestAckInput {
  /** What the human reads (required, ≤ 500 chars). */
  prompt: string;
  /**
   * Who to reach: `me`, the bound human (the default). The bound human's own
   * user id is accepted as an alias; any other id is refused with 403
   * `target_not_permitted`.
   */
  target?: string;
  /** Seconds until expiry. Clamped server-side to 120–86400; default 900. */
  expiresIn?: number;
  /** Interruption level — `active` (default) or `passive`. */
  urgency?: 'active' | 'passive';
  correlationId?: string;
  replyTo?: string;
  data?: JsonObject;
  /**
   * Idempotency key — same key + same body replays the original resource; a
   * different body for the same key returns a 409 `idempotency_conflict`.
   * Reuse it verbatim on network retries. 1–255 printable ASCII characters
   * (spaces allowed); an empty string sends no key.
   */
  idempotencyKey?: string;
}

/** Ask a human a multi-option question (the question handoff). Resolves on the first tapped answer. */
export interface AskInput extends RequestAckInput {
  /** 2–4 options. A bare string is shorthand for `{ value, label: value }`. */
  options: HandoffOptionSpec[];
}

export interface WaitHandoffInput {
  /** Seconds the server holds the connection (server caps at 25s; default 20). */
  timeout?: number;
  signal?: AbortSignal;
}

export interface ListHandoffsInput {
  /** `open` for unresolved work, or `all` for recent history (up to 200 per kind). */
  state?: 'open' | 'all';
}
