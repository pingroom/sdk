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
  | 'pingroom:agents:ping'
  | 'pingroom:approvals:request'
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
  expires_in: number;
  scopes: string[];
  handle?: string;
  claim?: { start_uri: string; complete_uri: string };
}

export interface ClaimStartParams {
  email: string;
}

export interface ClaimCompleteParams {
  email: string;
  otp: string;
  scopes?: ScopeInput[];
}

// --- rooms & quick actions ------------------------------------------------

export interface QuickActionInput {
  action_number: number;
  label: string;
  icon: string;
  sound?: string | null;
  haptic_style?: string | null;
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
}

export interface QuickAction {
  id?: string;
  action_number: number;
  label: string;
  icon: string;
  sound?: string | null;
  haptic_style?: string | null;
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

/** The body of a ping — used for broadcasts and agent-to-agent direct pings. */
export interface PingInput {
  message: string;
  action_number?: number;
  action_icon?: string;
  data?: JsonObject;
  correlation_id?: string;
  reply_to?: string;
}

export interface TriggerInput {
  trigger_source?: string;
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
  created_at: string;
  room?: { code: string; name: string; icon: string | null; color: string | null };
  sender?: { id: string; name: string | null };
}

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
