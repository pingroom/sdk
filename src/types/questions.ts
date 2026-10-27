import type { JsonObject } from './common.js';

// --- questions ------------------------------------------------------------
//
// The general human-in-the-loop primitive. An approval is the two-option case;
// a Question generalizes it to 2–4 options and/or a short typed answer, with a
// responder scope and a mandatory-but-defaulted expiry. First valid answer wins,
// unless the Question is a poll (`resolution_policy: 'all'`), where everyone
// asked gets one final vote and `results` carries the tally.

/**
 * The authenticated human who answered a Question or handoff (never
 * caller-supplied).
 *
 * Every field is redacted to `null` together when the caller is not entitled to
 * see who answered, which is why `id` is nullable even on a decided question.
 * The server sends all five fields from both `QuestionPresenter::responder` and
 * the handoff presenter; the type previously declared only `id` and
 * `display_name`, and being a closed object type that made the avatar fields
 * unreachable without a cast.
 */
export interface QuestionResponder {
  id: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  emoji: string | null;
  color: string | null;
}

/** The lifecycle states of a Question. Terminal states are immutable. */
export type QuestionState = 'pending' | 'answered' | 'expired' | 'cancelled';

/** Who may answer: `direct` (one named person) or `room` (any eligible member). */
export type ResponderScope = 'direct' | 'room';

/**
 * How a room Question resolves: `first` (the default — the first valid answer
 * wins) or `all` (a poll — everyone asked votes once; it closes when they all
 * have, or at its deadline).
 */
export type QuestionResolutionPolicy = 'first' | 'all';

/** One option offered on a Question. A bare string is shorthand for `{ value, label: value }`. */
export interface QuestionOptionInput {
  /** Stable machine token returned as the answer (1–40 chars, unique per question). */
  value: string;
  /** Human text on the button (defaults to `value`; 1–40 chars). */
  label?: string;
  /** Presentation hint: `primary` = brand-strike affirmative, `danger` = cancel. */
  style?: 'primary' | 'danger' | 'default';
  /** Legacy boolean form of `style: 'primary'`. */
  primary?: boolean;
  /** Legacy boolean form of `style: 'danger'`. */
  destructive?: boolean;
}

export type QuestionOptionSpec = string | QuestionOptionInput;

/** Invite a short typed answer, on its own (text-only) or alongside options. */
export interface QuestionTextInput {
  placeholder?: string;
  /** 1–60 (default 60). A value outside that range is refused with a 422. */
  max_length?: number;
}

export interface QuestionInput {
  /** The question the human reads (required, ≤ 500 chars). */
  prompt: string;
  /** Optional secondary line, e.g. a build number (≤ 40 chars). */
  context?: string;
  /** 2–4 options. Omit for the binary Approve/Deny default (the lock-screen fast path). */
  options?: QuestionOptionSpec[];
  /** Offer a typed answer instead of / alongside options. */
  text_input?: QuestionTextInput;
  /** `direct` (defaults to your bound user) or `room` (any eligible member). Default `direct`. */
  responder_scope?: ResponderScope;
  /**
   * `first` (default) or `all` to poll the room: every member except your bound
   * human gets one final vote. A poll implies `room` scope when
   * `responder_scope` is omitted, and cannot be combined with
   * `responder_scope: 'direct'`, `target_user_id`, or `text_input`. If your
   * bound human is the room's only member the server falls back to a `direct`
   * `first` Question — check `resolution_policy` on the returned Question.
   */
  resolution_policy?: QuestionResolutionPolicy;
  /** For `direct` scope: a specific room member (UUID). Defaults to the bound user. */
  target_user_id?: string;
  /** Seconds until expiry. Omit for the server default (1h); clamped to 30–86400. A poll with at least one vote closes `answered` at this deadline. */
  ttl?: number;
  data?: JsonObject;
  correlation_id?: string;
  reply_to?: string;
  /** Ordered ids from `attachments.upload()` (max 4). Same single-use rules as PingInput. */
  attachment_ids?: string[];
  /**
   * Sent as the `Idempotency-Key` header (1–255 printable ASCII characters,
   * spaces allowed). Reuse this key when retrying the same question creation.
   */
  idempotencyKey?: string;
}

/** A resolved option on the Question wire shape. */
export interface QuestionOption {
  value: string;
  label: string;
  primary?: boolean;
  destructive?: boolean;
  [key: string]: unknown;
}

/**
 * The resolution, present once `state === 'answered'` — except on a tied poll,
 * which is `answered` with a null `answer` (read `results` instead).
 */
export interface QuestionAnswer {
  /** The chosen option's `value` (a poll's leading option), or null for a text-only answer. */
  value: string | null;
  /** The chosen option's `label`. */
  label: string | null;
  /** The typed answer, when the question invited one. Always null on a poll. */
  text: string | null;
  /**
   * The authenticated human who answered (never caller-supplied). Present once
   * the question is decided — but every field is redacted to `null` when the
   * caller is not entitled to see who answered, so `id` is nullable even here.
   * Null on a poll: the room chose the answer, and the voters are in
   * `results.responses`. Matches `HandoffAnswer.responder`.
   */
  responder: QuestionResponder | null;
  answered_at: string | null;
}

/** One option's tally in a poll's {@link QuestionPollResults}. */
export interface QuestionPollOptionResult {
  value: string;
  label: string;
  /** Votes cast for this option (0 when nobody chose it). */
  count: number;
}

/** One cast vote in a poll's {@link QuestionPollResults.responses}. */
export interface QuestionPollResponse {
  value: string;
  label: string;
  /** Who voted. Every field is `null` when the caller may not see who answered. */
  responder: QuestionResponder;
  answered_at: string | null;
}

/** The reading person's own seat in a poll. */
export interface QuestionPollViewer {
  /** Whether the poll asked this person. */
  asked: boolean;
  /** The value they voted, or null until they vote. */
  response: string | null;
}

/**
 * A poll's tally (`resolution_policy: 'all'`). Present on every read of a poll
 * — including while it is still `pending` — and `null` on a `first` Question.
 */
export interface QuestionPollResults {
  /** People the poll asked, fixed when it was created. */
  audience_count: number;
  /** Votes cast so far (exact). */
  response_count: number;
  /** Every option, in display order, with its count. */
  options: QuestionPollOptionResult[];
  /** Up to the 100 most recent votes, oldest first. */
  responses: QuestionPollResponse[];
  /** Only on a signed-in person's own surfaces; always `null` on agent reads and webhook events. */
  viewer: QuestionPollViewer | null;
}

/** The public Question wire shape — identical across ask / get / wait / list. */
export interface Question {
  id: string;
  /** Canonical delivery notification when supplied by the server. */
  notification_id?: string | null;
  kind: 'question';
  prompt: string;
  context: string | null;
  options: QuestionOption[];
  text_input: { placeholder: string | null; max_length: number } | null;
  responder_scope: ResponderScope;
  target_user_id: string | null;
  /** `first` or `all` (a poll). Open-ended so a future policy does not break callers. */
  resolution_policy: QuestionResolutionPolicy | (string & {});
  state: QuestionState;
  /** Null until answered, and on a tied poll even once `answered`. */
  answer: QuestionAnswer | null;
  /** A poll's tally; `null` on a `first` Question (absent on servers before Question Protocol 1.3). */
  results?: QuestionPollResults | null;
  expires_at: string | null;
  resolved_at: string | null;
  correlation_id: string | null;
  reply_to: string | null;
  data: JsonObject | null;
  created_at: string | null;
  room?: { code: string; name: string; icon: string | null; color: string | null };
  room_code?: string;
  asker?: {
    /**
     * `'user'` for a human-asked Question (composer "Add Options"), `'agent'`
     * when an agent asked it. Both reach an agent's listen/list feed, so this
     * cannot be narrowed to `'agent'`.
     */
    type: 'agent' | 'user';
    id: string | null;
    handle: string | null;
    display_name: string | null;
    avatar_url: string | null;
  };
  [key: string]: unknown;
}

export interface WaitQuestionInput {
  /** Seconds the server holds the connection (0–30, default 20). */
  timeout?: number;
  signal?: AbortSignal;
}

export interface ListQuestionsInput {
  /** Filter by state; `all` returns every state. Omit for the recent window across states. */
  state?: QuestionState | 'all';
}
