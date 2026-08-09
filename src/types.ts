/**
 * Public types for the PingRoom SDK.
 *
 * Request payload field names mirror the HTTP API verbatim (snake_case) so the
 * SDK is a faithful, reviewable wrapper — what you pass is what the API sees.
 * SDK-only knobs (timeouts, signals, callbacks) use camelCase.
 */

/** A plain JSON object — the shape the API accepts for structured `data`. */
export type JsonObject = Record<string, unknown>;

/** Minimal fetch signature the SDK depends on (Node >= 18, browsers, workers, Deno, Bun). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The scopes an agent credential can hold. */
export type AgentScope =
  | 'pingroom:rooms:read'
  | 'pingroom:rooms:write'
  | 'pingroom:rooms:publish'
  | 'pingroom:rooms:join'
  | 'pingroom:actions:write'
  | 'pingroom:actions:trigger'
  | 'pingroom:broadcast:send'
  | 'pingroom:notifications:read'
  | 'pingroom:webhooks:read'
  | 'pingroom:webhooks:write'
  | 'pingroom:webhooks:delete'
  | 'pingroom:agents:ping'
  | 'pingroom:approvals:request'
  | 'pingroom:questions:ask'
  | 'pingroom:handoffs:create'
  | 'pingroom:live:write'
  | 'pingroom:profile:write';

/** A known scope, or any forward-compatible string (keeps autocomplete on the knowns). */
export type ScopeInput = AgentScope | (string & {});

// --- client options -------------------------------------------------------

export interface PingRoomOptions {
  /** Agent credential (Bearer JWT). Optional — public reads (directory) work without it. */
  token?: string | null;
  /** API base URL. Defaults to env PINGROOM_API_URL/PINGROOM_BASE_URL, else https://api.pingroom.io. */
  baseUrl?: string;
  /** Default per-request timeout in ms (long-poll calls extend this automatically). Default 30000. */
  timeoutMs?: number;
  /** Custom fetch implementation (for tests or non-global-fetch runtimes). */
  fetch?: FetchLike;
  /** Override the User-Agent header. */
  userAgent?: string;
  /** Allow plain-http base URLs to non-loopback hosts. Off by default — credentials require https. */
  allowInsecure?: boolean;
}

// --- auth -----------------------------------------------------------------

export type AgentRegisterType = 'identity_assertion' | 'anonymous';
export type AgentAssertionType = 'urn:ietf:params:oauth:token-type:id-jag' | 'verified_email';

export interface RegisterParams {
  type: AgentRegisterType;
  assertion_type?: AgentAssertionType;
  assertion?: string;
  scopes?: ScopeInput[];
  agent_label?: string;
}

export interface Credential {
  credential: string;
  credential_type: 'pre_claim' | 'active';
  expires_in: number | null;
  scopes: string[];
  handle?: string;
  claim?: { start_uri: string; complete_uri: string };
  account?: { name?: string | null } | null;
  room?: { invite_code: string; name?: string | null } | null;
}

export interface ClaimStartParams {
  email: string;
}

export interface ClaimCompleteParams {
  email: string;
  otp: string;
  scopes?: ScopeInput[];
}

/** Start an app-approved pairing without copying an API token or room code. */
export interface StartPairingParams {
  /** Defaults to room lookup and broadcast, both shown on the approval screen. */
  scopes?: ScopeInput[];
  agent_label?: string;
}

/** Short-lived app link returned when a pairing session starts. */
export interface PairingStart {
  pair_token: string;
  pair_url: string;
  expires_in: number;
  poll_interval_ms: number;
}

export interface PairedCredential extends Credential {
  credential_type: 'active';
  room: { invite_code: string; name?: string | null };
}

export type PairingStatus =
  | { status: 'pending' }
  | { status: 'expired' }
  | (PairedCredential & { status: 'active' });

export interface WaitForPairingOptions {
  /** Stop waiting without consuming the pairing session. */
  signal?: AbortSignal;
  /** Override the server-suggested polling interval (clamped to 1–10 seconds). */
  pollIntervalMs?: number;
}

// --- rooms & quick actions ------------------------------------------------

export interface QuickActionInput {
  action_number: number;
  label: string;
  icon: string;
  sound?: string | null;
  haptic_style?: string | null;
  /** Every fire of this reusable action opens the acknowledgement lifecycle. */
  requires_ack?: boolean;
}

export interface CreateRoomInput {
  name: string;
  icon: string;
  color: string;
  description?: string;
  everyone_can_trigger?: boolean;
  is_password_protected?: boolean;
  password?: string;
  actions?: QuickActionInput[];
}

export interface CreatePublicRoomInput extends CreateRoomInput {
  handle: string;
  category?: string;
  show_owner?: boolean;
}

export interface JoinRoomInput {
  invite_code: string;
  password?: string;
}

export interface UpdateQuickActionInput {
  label: string;
  icon: string;
  sound?: string | null;
  haptic_style?: string | null;
  /** Every fire of this reusable action opens the acknowledgement lifecycle. */
  requires_ack?: boolean;
}

export interface QuickAction {
  id?: string;
  action_number: number;
  label: string;
  icon: string;
  sound?: string | null;
  haptic_style?: string | null;
  /** Every fire of this reusable action opens the acknowledgement lifecycle. */
  requires_ack?: boolean;
  [key: string]: unknown;
}

export interface Room {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  invite_code: string;
  is_public?: boolean;
  handle?: string | null;
  quick_actions?: QuickAction[];
  [key: string]: unknown;
}

// --- pings / notifications ------------------------------------------------

/** The body of a ping — used for broadcasts and the retired direct-ping compatibility method. */
export interface PingInput {
  message: string;
  action_number?: number;
  action_icon?: string;
  /**
   * Structured data echoed on every read surface (<= 25 keys / 8KB).
   * Reserved keys `url` + `button_label` make the ping a tappable link —
   * see the `linkPing()` helper.
   */
  data?: JsonObject;
  correlation_id?: string;
  reply_to?: string;
  /** Open the acknowledgement lifecycle for this ping. First acknowledgement wins. */
  requires_ack?: boolean;
  /** Optional acknowledgement deadline in seconds. Omit/null for no deadline. */
  ack_timeout_seconds?: number | null;
}

export interface TriggerInput {
  trigger_source?: string;
}

/** The server-authoritative acknowledgement lifecycle attached to a ping. */
export interface ActionState {
  status: 'open' | 'acked' | 'expired' | null;
  requires_ack: boolean;
  acked_by: {
    id: string | null;
    name: string | null;
    profile_image: string | null;
  } | null;
  acked_at: string | null;
  expires_at: string | null;
  /** Viewer-specific human mutation eligibility; agent read paths return false. */
  can_ack?: boolean;
}

export interface PingResult {
  id: string;
  message: string;
  action_number: number | null;
  action_icon: string | null;
  trigger_source: string | null;
  data?: JsonObject | null;
  correlation_id?: string | null;
  reply_to?: string | null;
  action_state?: ActionState | null;
  created_at: string;
  recipient_count?: number;
  muted_count?: number;
  [key: string]: unknown;
}

export interface DirectPingResult {
  id: string;
  target_handle: string;
  room_code: string;
  message: string;
  correlation_id: string | null;
  reply_to: string | null;
  action_state?: ActionState | null;
  created_at: string;
  [key: string]: unknown;
}

export interface AgentNotification {
  id: string;
  message: string;
  action_number: number | null;
  action_icon: string | null;
  trigger_source: string | null;
  data?: JsonObject | null;
  correlation_id?: string | null;
  reply_to?: string | null;
  action_state?: ActionState | null;
  created_at: string;
  room?: { code: string; name: string; icon: string | null; color: string | null };
  sender?: { id: string; name: string | null };
}

/** Full notification record returned by the single-notification read path. */
export type NotificationDetail = Omit<AgentNotification, 'room'> & {
  room_id?: string;
  sender_id?: string;
  type?: string;
  requires_ack?: boolean;
  action_state: ActionState | null;
  room?: Room;
  [key: string]: unknown;
};

export interface ListNotificationsInput {
  type?: string;
  room_id?: string;
  date?: string;
  notifications_per_page?: number;
}

export interface WaitInput {
  /** Cursor (a notification id). Omit to start from the current head. */
  after?: string;
  /** Seconds to hold the connection (0–30, default 20). */
  timeout?: number;
  /** Max notifications to return (1–100, default 50). */
  limit?: number;
  signal?: AbortSignal;
}

export interface WaitResult {
  notifications: AgentNotification[];
  cursor: string;
}

export interface WaitForAcknowledgementInput {
  /** Seconds to hold the connection (0–30, default 20). */
  timeout?: number;
  signal?: AbortSignal;
}

export interface AcknowledgementWaitResult {
  id: string;
  action_state: ActionState;
}

export interface ListenInput {
  after?: string;
  timeout?: number;
  limit?: number;
  signal?: AbortSignal;
  /** Called on a transient error instead of throwing; the loop backs off and retries. */
  onError?: (err: unknown) => void;
  /** Backoff after a handled error, in ms (default 1000). */
  backoffMs?: number;
}

// --- approvals ------------------------------------------------------------

export interface ApprovalInput {
  question: string;
  title?: string;
  options?: string[];
  correlation_id?: string;
  data?: JsonObject;
  ttl?: number;
}

export interface Approval {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | (string & {});
  question: string;
  title: string | null;
  options: string[];
  decision: string | null;
  decided_at: string | null;
  expires_at: string | null;
  correlation_id: string | null;
  data: JsonObject | null;
  room_code: string;
  [key: string]: unknown;
}

export interface WaitApprovalInput {
  /** Seconds the server holds the connection (0–30, default 20). */
  timeout?: number;
  signal?: AbortSignal;
}

// --- questions ------------------------------------------------------------
//
// The general human-in-the-loop primitive. An approval is the two-option case;
// a Question generalizes it to 2–4 options and/or a short typed answer, with a
// responder scope and a mandatory-but-defaulted expiry. First valid answer wins.

/** The lifecycle states of a Question. Terminal states are immutable. */
export type QuestionState = 'pending' | 'answered' | 'expired' | 'cancelled';

/** Who may answer: `direct` (one named person) or `room` (any eligible member). */
export type ResponderScope = 'direct' | 'room';

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
  /** 1–60; clamped server-side. */
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
  /** For `direct` scope: a specific room member (UUID). Defaults to the bound user. */
  target_user_id?: string;
  /** Seconds until expiry. Omit for the server default (1h); clamped to 30–86400. */
  ttl?: number;
  data?: JsonObject;
  correlation_id?: string;
  reply_to?: string;
}

/** A resolved option on the Question wire shape. */
export interface QuestionOption {
  value: string;
  label: string;
  primary?: boolean;
  destructive?: boolean;
  [key: string]: unknown;
}

/** The resolution, present once `state === 'answered'`. */
export interface QuestionAnswer {
  /** The chosen option's `value`, or null for a text-only answer. */
  value: string | null;
  /** The chosen option's `label`. */
  label: string | null;
  /** The typed answer, when the question invited one. */
  text: string | null;
  /** The authenticated human who answered (never caller-supplied). */
  responder: { id: string; display_name: string | null } | null;
  answered_at: string | null;
}

/** The public Question wire shape — identical across ask / get / wait / list. */
export interface Question {
  id: string;
  kind: 'question';
  prompt: string;
  context: string | null;
  options: QuestionOption[];
  text_input: { placeholder: string | null; max_length: number } | null;
  responder_scope: ResponderScope;
  target_user_id: string | null;
  resolution_policy: 'first' | (string & {});
  state: QuestionState;
  answer: QuestionAnswer | null;
  expires_at: string | null;
  resolved_at: string | null;
  correlation_id: string | null;
  reply_to: string | null;
  data: JsonObject | null;
  created_at: string | null;
  room?: { code: string; name: string; icon: string | null; color: string | null };
  room_code?: string;
  asker?: {
    type: 'agent';
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
  responder: { id: string | null; display_name: string | null } | null;
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
  [key: string]: unknown;
}

/** Ask a human to acknowledge (the ack handoff). Resolves on the first acknowledgement. */
export interface RequestAckInput {
  /** What the human reads (required, ≤ 500 chars). */
  prompt: string;
  /** Who to reach: `me` (the bound human, the default) or a user UUID. */
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
   * Reuse it verbatim on network retries.
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

// --- Agent Inbox ---------------------------------------------------------

/** Idempotent first-connect result from POST /api/agent/inbox/ensure. */
export interface AgentInboxEnsureResult {
  onboarded: true;
  replayed: boolean;
  room: {
    id: string;
    name: string;
    invite_code: string;
    is_agent_inbox: true;
  };
  question: {
    id: string;
    kind: 'question';
    prompt: string;
    options: HandoffOption[];
    state: HandoffQuestionState;
    expires_at: string | null;
    created_at: string | null;
  };
}

// --- profile --------------------------------------------------------------

export interface RotateHandleResult {
  handle: string;
  [key: string]: unknown;
}

// --- directory ------------------------------------------------------------

export type PingPolicy = 'open' | 'members' | 'closed' | (string & {});
export type ActivityBucket = 'active_now' | 'today' | 'this_week' | 'quiet' | (string & {});

export interface DirectoryEntry {
  handle: string;
  display_name: string;
  tagline: string;
  tags: string[];
  icon: string | null;
  color: string | null;
  ping_policy: PingPolicy;
  is_featured: boolean;
  operated_by: string | null;
  last_active: ActivityBucket;
}

export interface DirectoryProfile extends DirectoryEntry {
  description: string | null;
  listed_at: string | null;
  card_url: string | null;
}

export interface DirectoryListInput {
  search?: string;
  tag?: string;
  per_page?: number;
  page?: number;
}

// --- pagination -----------------------------------------------------------

export interface Paginated<T> {
  current_page: number;
  data: T[];
  per_page: number;
  total: number;
  last_page: number;
  next_page_url: string | null;
  prev_page_url: string | null;
  [key: string]: unknown;
}
