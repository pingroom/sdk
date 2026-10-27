// --- rooms & quick actions ------------------------------------------------

/**
 * The detail every press of a quick action must carry. `location` needs
 * `data.location`, `link` needs `data.url`, `file`/`photo`/`pdf` need
 * `attachment_ids` (photo: jpg/png only, pdf: pdf only). A press without it is
 * refused with `422 quick_action_input_required` and nothing is sent.
 */
export type QuickActionInputType = 'none' | 'location' | 'link' | 'file' | 'photo' | 'pdf';

export interface QuickActionInput {
  action_number: number;
  label: string;
  /**
   * Emoji or icon id. Sending `label` and `icon` both empty reserves the slot
   * as disabled: it stays in the layout and a press answers `404
   * action_not_configured`.
   */
  icon: string;
  sound?: string | null;
  haptic_style?: string | null;
  /** Every fire of this reusable action opens the acknowledgement lifecycle. */
  requires_ack?: boolean;
  /** Omit to keep the stored value; new slots default to `none`. */
  input_type?: QuickActionInputType;
}

/**
 * Body of `actions.updateLayout()`. `page_order` lists the new page positions:
 * each entry is the ORIGINAL page number (1–4) to keep at that index, or
 * `null` for a fresh blank page; original pages absent from the list are
 * deleted. `actions` is the full renumbered 4–16 set. `base_action_ids` is
 * every stored action id in `action_number` order as last read — a stale
 * snapshot is refused with `409 quick_action_layout_changed`.
 */
export interface UpdateQuickActionLayoutInput {
  base_action_ids: string[];
  page_order: Array<number | null>;
  actions: QuickActionInput[];
}

export interface CreateRoomInput {
  name: string;
  icon: string;
  color: string;
}

export interface CreatePublicRoomInput extends CreateRoomInput {
  handle: string;
  description?: string;
  everyone_can_trigger?: boolean;
  is_password_protected?: boolean;
  password?: string;
  actions?: QuickActionInput[];
  category?: string;
  show_owner?: boolean;
  /**
   * Public-room location for nearby discovery. Send all three or none —
   * `createPublic()` rejects a partial trio locally, the server with a 422.
   */
  location_name?: string;
  location_latitude?: number;
  location_longitude?: number;
}

export interface JoinRoomInput {
  invite_code: string;
  password?: string;
}

export interface UpdateQuickActionInput {
  /**
   * The Ping's title. Must be sent, but may be `''` — a Ping can be named by
   * its emoji alone, and the app renders an untitled one as just the emoji.
   */
  label: string;
  icon: string;
  sound?: string | null;
  haptic_style?: string | null;
  /** Every fire of this reusable action opens the acknowledgement lifecycle. */
  requires_ack?: boolean;
  /** Omit to keep the stored value. */
  input_type?: QuickActionInputType;
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
  /** Missing on pre-2026-09-16 rows; treat absent as `none`. */
  input_type?: QuickActionInputType;
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
  /** 4, or 16 while the room owner is Pro. */
  quick_action_limit?: 4 | 16;
  /** Every stored slot, including pages hidden by a lapsed Pro. */
  quick_action_count?: number;
  location_name?: string | null;
  location_latitude?: number | null;
  location_longitude?: number | null;
  [key: string]: unknown;
}

/** Catalog ids accepted by room and webhook creation. */
export interface RoomIconCatalog {
  version: number;
  base_url: string;
  categories: Array<{ id: string; label: string; icons: string[] }>;
  icons: Record<string, { file: string; tags: string[] }>;
}

export interface CreateWebhookInput {
  name: string;
  title?: string | null;
  message?: string | null;
  emoji?: string | null;
  icon?: string | null;
  color?: string | null;
  sound?: string | null;
  haptic?: string | null;
  /** Optional Quick Ping preset. Omit or use null for an independent webhook. */
  action_number?: number | null;
  enabled?: boolean;
  cooldown_seconds?: number;
}

export interface UpdateWebhookInput extends Partial<CreateWebhookInput> {
  /** Rotate the trigger URL; the previous URL stops working. */
  regenerate_secret?: boolean;
}

/** Incoming webhook configuration. The trigger URL contains its credential. */
export interface Webhook {
  id: string;
  room_id: string;
  name: string;
  title: string | null;
  message: string | null;
  emoji: string | null;
  icon: string | null;
  color: string | null;
  sound: string | null;
  haptic: string | null;
  /** Null when the webhook uses its own content without a Quick Ping preset. */
  action_number: number | null;
  enabled: boolean;
  cooldown_seconds: number;
  trigger_count: number;
  last_triggered_at?: string | null;
  webhook_url: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}
