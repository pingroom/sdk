import type { JsonObject } from './common.js';
import type { Room } from './rooms.js';
import type { Question } from './questions.js';

// --- pings / notifications ------------------------------------------------

/** A visible Ping — used for broadcasts and the retired direct-ping compatibility method. */
export interface PingInput {
  /** Visible body (≤ 120 characters in private rooms; ≤ 160 in public rooms). */
  message: string;
  /** Optional visible title (≤ 40 characters). */
  title?: string;
  action_number?: number;
  action_icon?: string;
  /**
   * Structured data echoed on every read surface (<= 25 keys / 8KB).
   * Reserved keys `url` + `button_label` make the ping a tappable link —
   * see the `linkPing()` helper. Reserved `location` carries finite numeric
   * latitude/longitude plus an optional label/address — see `locationPing()`.
   */
  data?: JsonObject;
  correlation_id?: string;
  reply_to?: string;
  /**
   * Ordered ids from `attachments.upload()` (max 4). Ids are single-use: the
   * send claims them, and an already-claimed or expired id fails the whole
   * ping. File bytes never ride this JSON body.
   */
  attachment_ids?: string[];
  /**
   * Open the acknowledgement lifecycle for this ping. The ack_mode rule
   * determines when it resolves, and recipients see a lock-screen card with an Acknowledge button.
   *
   * Does NOT raise the delivery priority — that is {@link PingInput.is_urgent},
   * and the two are independent. They were one flag, which meant asking for a
   * ping that cuts through Focus also demanded that somebody acknowledge it.
   */
  requires_ack?: boolean;
  /** Confirmation rule; defaults to any. all waits for every original eligible recipient. */
  ack_mode?: AckMode;
  /**
   * Deliver time-sensitive so the ping breaks through Focus / Do Not Disturb
   * and reaches members who muted the room or you (a block still wins).
   * Delivery priority only: no acknowledgement, no Live Activity, nothing asked
   * of the recipient. Set alongside `requires_ack` for an acknowledgement that
   * also cuts through Focus.
   */
  is_urgent?: boolean;
  /**
   * Optional acknowledgement deadline in seconds (60–86400). Omit/null for no
   * deadline. Validated on every send, so an out-of-range value is a 422 even
   * without `requires_ack`; it takes effect only when the ping requires
   * acknowledgement.
   */
  ack_timeout_seconds?: number | null;
  /**
   * Sent as the `Idempotency-Key` header (1–255 printable ASCII characters,
   * spaces allowed), never in the body.
   * Reuse the same key when retrying after a timeout or network error: the
   * server replays the first result instead of sending the ping again.
   */
  idempotencyKey?: string;
}

/**
 * Safe attachment metadata. Storage keys, checksums, owner ids, and permanent
 * URLs are deliberately not part of this contract — read the bytes through
 * `attachments.content()` with the credential that can see the ping.
 */
export interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

/** The file types the attachment endpoint accepts. */
/** One row of a `.zip` attachment's listing. */
export interface ZipManifestEntry {
  name: string;
  /** Null when the archive declared no size, or declared a ZIP64 sentinel. */
  size_bytes: number | null;
  is_directory: boolean;
}

/**
 * A `.zip` attachment's contents as recorded at upload. Bounded server-side, so
 * `entries` may be shorter than `total_entries`.
 */
export interface ZipManifest {
  entries: ZipManifestEntry[];
  total_entries: number;
  truncated: boolean;
  /** Sum of the sizes the archive DECLARES. Nothing verifies or expands them. */
  total_uncompressed_bytes: number;
}

export type AttachmentExtension =
  | 'md'
  | 'pdf'
  | 'html'
  | 'txt'
  | 'jpg'
  | 'jpeg'
  | 'png'
  | 'zip';

export interface UploadAttachmentInput {
  /** File bytes (1 byte–5 MiB). A Blob/File, a Uint8Array, or a UTF-8 string. */
  content: Blob | Uint8Array | string;
  /** Display filename. Its extension must be one of AttachmentExtension. */
  filename: string;
  /** Overrides the type sent in the multipart part. Usually inferred is fine. */
  contentType?: string;
  signal?: AbortSignal;
}

export interface TriggerInput {
  /**
   * Only the sources a device legitimately originates. `webhook`/`system` are
   * stamped server-side and are rejected here.
   */
  trigger_source?: 'manual' | 'location';
  /**
   * Deliver this one press time-sensitive so it breaks through Focus / Do Not
   * Disturb and reaches members who muted the room or you (a block still
   * wins). Send-time only — the action's saved configuration is untouched,
   * and quick actions have no stored urgency policy to override. Never implies
   * `requires_ack`, which is the action's own saved acknowledgement policy.
   */
  is_urgent?: boolean;
  /**
   * One-shot acknowledgement modifier for this press only. It is OR-ed with the
   * action's stored policy, so it can only ADD an ack requirement — passing
   * `false` never removes one from an action already configured to require it.
   * The action's saved configuration is untouched either way.
   */
  requires_ack?: boolean;
  /** Applies to this press only, when its effective acknowledgement policy is enabled. */
  ack_mode?: AckMode;
  /**
   * The detail this press carries when the action has an `input_type`. Only
   * `location` and `url` are accepted on a trigger — no `button_label`; build
   * the fragments with `locationPing()` / `linkPing()` or pass them directly.
   */
  data?: TriggerData;
  /**
   * Ids from `attachments.upload()`, at most 4. Required when `input_type` is
   * `file`, `photo` (jpg/png only) or `pdf` (pdf only); a mismatched type is
   * `422 quick_action_input_type`.
   */
  attachment_ids?: string[];
  /**
   * The action's `id` as read from `actions.list()`. When that slot has since
   * moved pages the press is refused with `409 quick_action_layout_changed`
   * rather than firing the wrong Ping.
   */
  quick_action_id?: string;
  /**
   * Sent as the `Idempotency-Key` header (1–255 printable ASCII characters,
   * spaces allowed), never in the body.
   * Reuse the same key when retrying after a timeout or network error: the
   * server replays the first result instead of firing the press again.
   */
  idempotencyKey?: string;
}

/** The closed `data` object a quick-action press may carry. */
export interface TriggerData {
  location?: TriggerLocation;
  /** Absolute http(s) URL, at most 2048 characters. */
  url?: string;
}

/** Same shape as `LocationPingLocation`; declared here to keep types.ts import-free. */
export interface TriggerLocation {
  latitude: number;
  longitude: number;
  label?: string;
  address?: string;
}

export type AckMode = 'any' | 'all';

/** The server-authoritative acknowledgement lifecycle attached to a ping. */
export interface ActionState {
  /** Omitted by older servers and by the default any mode. */
  mode?: AckMode;
  confirmed_count?: number;
  required_count?: number;
  /** REST only; public rooms redact identities and MCP omits them. */
  confirmed_user_ids?: string[];
  status: 'open' | 'acked' | 'expired' | null;
  requires_ack: boolean;
  acked_by: {
    id: string | null;
    name: string | null;
    profile_image: string | null;
  } | null;
  acked_at: string | null;
  expires_at: string | null;
  /** Set when the confirmation window was closed early. */
  ended_at?: string | null;
  /** Viewer-specific human mutation eligibility; agent read paths return false. */
  can_ack?: boolean;
  /** Recipients who dismissed the card without confirming. Never counts as a confirmation. */
  dismissed_count?: number;
  /** REST only; public rooms redact identities and MCP omits them. */
  dismissed_user_ids?: string[];
  /** Viewer-scoped: when the reading viewer dismissed it. */
  dismissed_at?: string | null;
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
  attachments?: Attachment[];
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

/**
 * The named fields of a listened/listed notification, without the index
 * signature. `Omit` collapses a type carrying a string index signature down to
 * that signature alone, so `NotificationDetail` derives from this rather than
 * from `AgentNotification` — otherwise every named field would widen to
 * `unknown`.
 */
interface AgentNotificationFields {
  id: string;
  message: string;
  action_number: number | null;
  action_icon: string | null;
  trigger_source: string | null;
  /**
   * True when this ping is an agent handoff (a request to take over a
   * conversation) rather than an ordinary ping.
   */
  is_handoff?: boolean;
  data?: JsonObject | null;
  correlation_id?: string | null;
  reply_to?: string | null;
  attachments?: Attachment[];
  action_state?: ActionState | null;
  /** Confirmation rule the ping was sent with; absent on older rows. */
  ack_mode?: AckMode;
  /**
   * Delivered without sound/haptics (the sender's silent mode at send time).
   * `null` on rows written before 2026-09-16; not surfaced through MCP.
   */
  is_silent?: boolean | null;
  /**
   * The embedded Question when this ping carries one, else null. Same wire
   * shape as the dedicated Question read paths.
   */
  question?: Question | null;
  created_at: string;
  room?: { code: string; name: string; icon: string | null; color: string | null };
  sender?: { id: string; name: string | null };
  /**
   * Present when a connected agent (MCP / CLI credential) originated the
   * ping: the agent registration's display identity. Null/absent on human,
   * webhook, and trigger rows.
   */
  origin_agent?: {
    id?: string;
    handle: string | null;
    display_name: string | null;
    avatar_url?: string | null;
  } | null;
}

export interface AgentNotification extends AgentNotificationFields {
  [key: string]: unknown;
}

/** Full notification record returned by the single-notification read path. */
export type NotificationDetail = Omit<AgentNotificationFields, 'room'> & {
  room_id?: string;
  sender_id?: string;
  type?: string;
  requires_ack?: boolean;
  /** Whether this ping was delivered time-sensitive. Independent of `requires_ack`. */
  is_urgent?: boolean;
  action_state: ActionState | null;
  room?: Room;
  [key: string]: unknown;
};

/** History keeps the full room and adds the listener-compatible `room.code`. */
export interface NotificationHistoryEntry extends AgentNotification {
  room?: Room & { code: string };
}

export interface ListNotificationsInput {
  /** `received` or `sent`; the server refuses any other value. */
  type?: 'received' | 'sent';
  room_id?: string;
  date?: string;
  /** Page size (1–25). Omit to retain the server's legacy default. */
  limit?: number;
  /** Page number, starting at 1. */
  page?: number;
  /** @deprecated Use limit. Sent as limit when limit is absent. */
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
  /**
   * Called with each transient error (network failure, request timeout, 429,
   * 5xx) before the loop backs off and retries; transient errors are retried
   * whether or not this is set. Any other error (401, 403, 422, …) ends the
   * iterator by throwing, so a revoked credential never retries forever.
   */
  onError?: (err: unknown) => void;
  /**
   * First backoff after a transient error, in ms (default 1000). It doubles on
   * each consecutive failure up to 30 s; a server `retryAfter` replaces it.
   */
  backoffMs?: number;
}
