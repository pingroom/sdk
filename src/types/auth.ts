import type { ScopeInput } from './common.js';

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

/**
 * How wide the human made this agent's room grant.
 *
 * `'all'` — every room the account is in; the grant lists none, while `room`
 * may identify one eligible private delivery destination. `'selected'` —
 * exactly the rooms in `rooms`.
 */
export type AgentRoomAccess = 'all' | 'selected';

/** One room inside an agent's grant. */
export interface AgentAccessRoom {
  id: string;
  invite_code: string;
  name: string;
}

/** The delivery room: where handoffs and questions land. */
export interface AgentDeliveryRoom {
  invite_code: string;
  name?: string | null;
}

/** Stable, non-credential URLs returned with an approved agent connection. */
export interface AgentCredentialLinks {
  /** REST endpoint for the agent's latest visible pings. Authenticate normally. */
  latest_pings: string;
  /** Token-free smart link for installing PingRoom on iOS or Android. */
  install_app?: string;
}

/** Public robot identity provisioned before a person approves pairing. */
export interface AgentProfile {
  display_name: string | null;
  handle: string | null;
  avatar_id: string | null;
  avatar_url: string | null;
}

/** Agent wrapper used by pairing v2. Older servers omit it entirely. */
export interface PairingAgent {
  id?: string;
  label?: string | null;
  handle?: string | null;
  profile?: AgentProfile;
}

/** Human who claimed the robot. Present only after approval. */
export interface PairingOwner {
  name: string | null;
}

/** Visible home-room membership, distinct from the wider room-access grant. */
export interface AgentRoomMembership {
  status: 'active' | 'removed';
  joined_at: string | null;
  removed_at: string | null;
  /** True for the robot's home room. Sent by `auth.connection()`. */
  is_home?: boolean;
  room: AgentDeliveryRoom | null;
}

/** Additive pairing-v2 identity metadata; every field is optional for old servers. */
export interface PairingIdentityMetadata {
  flow_version?: 2;
  claim_mode?: 'agent_identity';
  agent?: PairingAgent;
  owner?: PairingOwner;
  /** Alias of legacy `room`: the robot's Question/Handoff delivery room. */
  home_room?: AgentDeliveryRoom | null;
  room_membership?: AgentRoomMembership | null;
}

export interface Credential extends PairingIdentityMetadata {
  credential: string;
  credential_type: 'pre_claim' | 'active';
  expires_in: number | null;
  scopes: string[];
  handle?: string;
  claim?: { start_uri: string; complete_uri: string };
  account?: { name?: string | null } | null;
  /** The delivery room, or null when the human pinned none. */
  room?: AgentDeliveryRoom | null;
  room_access?: AgentRoomAccess | null;
  /** The full grant. Empty under `room_access: 'all'`. */
  rooms?: AgentAccessRoom[];
  /** Server-authoritative endpoints associated with this connection. */
  links?: AgentCredentialLinks;
}

/** The human a connection belongs to, as `auth.connection()` and `auth.disconnect()` report it. */
export interface AgentConnectionOwner {
  /** Public user id. Match it to the account you approved before sending. */
  id: string;
  name: string;
}

/** `auth.connection()`: what this credential is connected to. */
export interface AgentConnectionInfo {
  flow_version: 2;
  claim_mode: 'agent_identity';
  status: 'active';
  handle: string | null;
  agent: PairingAgent;
  owner: AgentConnectionOwner;
  /** The robot's Question/Handoff delivery room, or null when none is designated. */
  home_room: AgentAccessRoom | null;
  /** The robot's membership of its home room. */
  room_membership: AgentRoomMembership | null;
  /** Every active room membership, home room first. */
  room_memberships: AgentRoomMembership[];
  room_access: AgentRoomAccess | null;
  links: AgentCredentialLinks;
  [key: string]: unknown;
}

/** `auth.disconnect()`: the calling credential and its refresh credentials are revoked. */
export interface AgentDisconnectResult {
  status: 'revoked';
  handle: string | null;
  owner: AgentConnectionOwner;
  /** Reconnect guidance for the human. */
  message: string;
  [key: string]: unknown;
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
  /**
   * @deprecated Pairing grants are server-authoritative. This value is ignored
   * and retained only so existing TypeScript callers continue to compile.
   */
  scopes?: ScopeInput[];
  agent_label?: string;
}

/** Short-lived browser and native-app links returned when pairing starts. */
export interface PairingStart extends PairingIdentityMetadata {
  pair_token: string;
  /** Legacy approval link, kept QR-compatible for existing clients. */
  pair_url: string;
  /** Browser approval page. Fall back to `pair_url` on older servers. */
  pair_browser_url?: string;
  /** Native app universal link for QR renderers. Falls back to `pair_url` on older servers. */
  pair_qr_url?: string;
  /** Token-free smart install link. Never append `pair_token` to it. */
  app_install_url?: string;
  expires_in: number;
  poll_interval_ms: number;
}

export type PairedCredential = Omit<Credential, 'credential_type' | 'scopes'> & {
  credential_type: 'active';
  /**
   * The selected/deterministic private delivery room. Null remains valid when
   * the account has no eligible private room (and for older servers).
   */
  room: AgentDeliveryRoom | null;
  room_access: AgentRoomAccess;
  /** The full grant. Empty under `room_access: 'all'`. */
  rooms: AgentAccessRoom[];
};

export type PairingStatus =
  | (PairingIdentityMetadata & { status: 'pending' })
  | (PairingIdentityMetadata & { status: 'expired' })
  | (PairedCredential & {
      status: 'active';
      /** Legacy server metadata accepted on input and omitted from the result. */
      scopes?: string[];
    });

export interface WaitForPairingOptions {
  /** Stop waiting without consuming the pairing session. */
  signal?: AbortSignal;
  /** Override the server-suggested polling interval (clamped to 1–10 seconds). */
  pollIntervalMs?: number;
}
