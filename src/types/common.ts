/** A plain JSON object — the shape the API accepts for structured `data`. */
export type JsonObject = Record<string, unknown>;

/** Minimal fetch signature the SDK depends on (Node >= 18, browsers, workers, Deno, Bun). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The scopes an agent credential can hold. */
export type AgentScope =
  | 'pingroom:full'
  | 'pingroom:rooms:read'
  | 'pingroom:rooms:write'
  | 'pingroom:rooms:publish'
  | 'pingroom:rooms:join'
  | 'pingroom:actions:write'
  | 'pingroom:actions:trigger'
  | 'pingroom:broadcast:send'
  | 'pingroom:attachments:write'
  | 'pingroom:notifications:read'
  | 'pingroom:webhooks:read'
  | 'pingroom:webhooks:write'
  | 'pingroom:webhooks:delete'
  | 'pingroom:agents:ping'
  | 'pingroom:approvals:request'
  | 'pingroom:questions:ask'
  | 'pingroom:handoffs:create'
  | 'pingroom:live:write'
  | 'pingroom:profile:write'
  | 'pingroom:codes:redeem';

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

// --- gift and promotional codes --------------------------------------------

/** Pro entitlement applied to the human who authorized this agent. */
export interface RedeemCodeResult {
  message: string;
  kind: 'gift' | 'redeem';
  reward_days: number | null;
  package: string | null;
  lifetime: boolean;
  plan: 'pro';
  plan_expires_at: string | null;
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
