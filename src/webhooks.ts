/**
 * Webhook helpers — usable standalone, no client/token required.
 *
 *  - verifyWebhookSignature: verify an OUTGOING webhook PingRoom sent you.
 *    New deliveries carry both the legacy timestamp/body HMAC and a v2 HMAC
 *    that also binds the delivery ID. Verify over the EXACT raw request body
 *    bytes — re-serializing the parsed JSON will not match.
 *
 *  - sendIncomingWebhook: fire a room's INCOMING webhook (the URL carries its
 *    own secret, so no agent token is needed) — the one-line CI/deploy ping.
 *    Pass a top-level `live_status` to drive a Live Activity instead.
 */

import { PingRoomError } from './errors.js';
import { combineSignals } from './internal/async.js';
import {
  assertActionNumber,
  assertMaxLength,
  assertStructuredData,
  MAX_PING_TITLE_LENGTH,
  MAX_PUBLIC_PING_MESSAGE_LENGTH,
} from './internal/guards.js';
import { assertSecureUrl } from './internal/url.js';
import type { LiveStatus } from './liveStatus.js';
import type { ActionState, FetchLike, JsonObject } from './types.js';
import { VERSION } from './version.js';

export const WEBHOOK_SIGNATURE_HEADER = 'X-PingRoom-Signature';
export const WEBHOOK_SIGNATURE_V2_HEADER = 'X-PingRoom-Signature-V2';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-PingRoom-Timestamp';
export const WEBHOOK_DELIVERY_HEADER = 'X-PingRoom-Delivery';
export const WEBHOOK_EVENT_HEADER = 'X-PingRoom-Event';

export interface VerifyWebhookSignatureOptions {
  /** The raw request body — the exact bytes received, NOT a re-stringified object. */
  payload: string | ArrayBuffer | Uint8Array;
  /** Legacy X-PingRoom-Signature value (with or without the `sha256=` prefix). */
  signature?: string | null;
  /** X-PingRoom-Signature-V2 value. When present, v2 MUST verify; v1 is not tried. */
  signatureV2?: string | null;
  /** The X-PingRoom-Timestamp header value (Unix seconds). */
  timestamp: string | number | null | undefined;
  /** X-PingRoom-Delivery value required by the v2 signed message. */
  deliveryId?: string | null;
  /** The webhook's signing_secret. */
  secret: string;
  /** Allowed timestamp skew in seconds. Defaults to 300 (five minutes). */
  maxAgeSeconds?: number;
}

/**
 * Constant-time verification of an outgoing-webhook signature. Returns a
 * boolean and never throws on mismatch.
 */
export async function verifyWebhookSignature(opts: VerifyWebhookSignatureOptions): Promise<boolean> {
  const hasV2Signature = opts.signatureV2 !== null && opts.signatureV2 !== undefined;
  const selectedSignature = hasV2Signature ? opts.signatureV2 : opts.signature;
  if (!selectedSignature || !opts.secret) {
    return false;
  }
  const timestamp = normalizeTimestamp(opts.timestamp);
  if (timestamp === null) {
    return false;
  }
  const maxAgeSeconds = opts.maxAgeSeconds ?? 300;
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0) {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > maxAgeSeconds) {
    return false;
  }
  const provided = normalizeSignature(selectedSignature).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return false;
  }
  let message: Uint8Array;
  if (hasV2Signature) {
    const deliveryId = normalizeDeliveryId(opts.deliveryId);
    if (deliveryId === null) {
      return false;
    }
    message = signedMessage(`v2\n${timestamp}\n${deliveryId}\n`, opts.payload);
  } else {
    message = signedMessage(`${timestamp}.`, opts.payload);
  }
  const expected = await hmacSha256Hex(opts.secret, message);
  return timingSafeEqualHex(provided, expected);
}

export interface IncomingWebhookPayload {
  /** Visible Ping body (≤ 120 characters in private rooms; ≤ 160 in public rooms). */
  message?: string;
  /** Visible Ping title (≤ 40 characters). */
  title?: string;
  /** Quick-action slot to attribute the ping to (1–4). */
  action?: number;
  /** Per-ping emoji override (≤ 16 chars, so ZWJ sequences and skin tones fit). */
  emoji?: string;
  /** Per-ping catalog icon override — a v3 room-icon id, validated server-side. */
  icon?: string;
  /** Per-ping color override: 6-digit hex, optional leading `#`. */
  color?: string;
  /** Per-ping sound override — a canonical sound id (see constants/sounds.json). */
  sound?: string;
  data?: JsonObject;
  correlation_id?: string;
  reply_to?: string;
  /**
   * Drive a Live Activity through this webhook. MUST be top-level — the server
   * detects `live_status` on the request body, and strips it from `data` so a
   * legacy-path caller cannot spoof completion alerts. Sending it nested under
   * `data` silently produces an ordinary ping, not a stream.
   *
   * Requires `correlation_id`. Build it with the `liveStatus.*` helpers.
   * See https://pingroom.io/liveactivities.md
   */
  live_status?: LiveStatus;
  /** Override the selected quick action and require acknowledgement for this ping. */
  requires_ack?: boolean;
  /** Optional acknowledgement deadline in seconds. Omit/null for no deadline. */
  ack_timeout_seconds?: number | null;
}

export interface SendIncomingWebhookOptions {
  /** Sent as the Idempotency-Key header; identical keys within ~1h replay the first result. */
  idempotencyKey?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Allow plain-http webhook URLs to non-loopback hosts (off by default). */
  allowInsecure?: boolean;
}

export interface IncomingWebhookResult {
  success: boolean;
  notification_id?: string;
  message?: string;
  action_state?: ActionState | null;
  [key: string]: unknown;
}

/**
 * Every field the incoming-webhook endpoint accepts, in the server's own order
 * (`WebhookController::trigger`'s validate block, plus `live_status`, which it
 * detects before that block and routes to the stream handler).
 *
 * The request body is built by walking this list rather than a hand-written run
 * of `if`s. That run silently dropped whatever nobody remembered to add to it:
 * first `live_status` (pre-0.3.1 — posted only `{correlation_id}`, fell into the
 * legacy webhook branch, and returned `success: true` having created no activity
 * at all), then `emoji`/`icon`/`color`/`sound`. Exported so a test can fail the
 * moment this list and the server contract diverge again.
 */
export const INCOMING_WEBHOOK_FIELDS = [
  'title',
  'message',
  'action',
  'emoji',
  'icon',
  'color',
  'sound',
  'data',
  'correlation_id',
  'reply_to',
  'requires_ack',
  'ack_timeout_seconds',
  // Top level, never folded into `data` — the server routes on this key and
  // strips it from `data` so a legacy-path caller cannot spoof completion alerts.
  'live_status',
] as const satisfies readonly (keyof IncomingWebhookPayload)[];

/** POST to a room's incoming-webhook URL (which embeds the secret in its path). */
export async function sendIncomingWebhook(
  webhookUrl: string,
  payload: IncomingWebhookPayload,
  options: SendIncomingWebhookOptions = {},
): Promise<IncomingWebhookResult> {
  assertSecureUrl(webhookUrl, options.allowInsecure ?? false);
  // A webhook URL does not reveal room visibility, so validate the public
  // ceiling here and let the server enforce 120 for private rooms.
  assertMaxLength(payload.message, MAX_PUBLIC_PING_MESSAGE_LENGTH, 'message');
  assertMaxLength(payload.title, MAX_PING_TITLE_LENGTH, 'title');
  assertActionNumber(payload.action);
  assertStructuredData(payload.data);

  const body: Record<string, unknown> = {};
  for (const field of INCOMING_WEBHOOK_FIELDS) {
    const value = payload[field];
    if (value !== undefined) body[field] = value;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `pingroom-sdk/${VERSION}`,
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) {
    throw new PingRoomError('No fetch implementation available.', { code: 'no_fetch' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const signal = combineSignals(controller.signal, options.signal);

  let res: Response;
  try {
    res = await fetchImpl(webhookUrl, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    throw new PingRoomError(`Webhook request failed: ${err instanceof Error ? err.message : String(err)}`, {
      code: 'network_error',
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  const result: IncomingWebhookResult = json && typeof json === 'object' ? (json as IncomingWebhookResult) : { success: res.ok };
  if (!res.ok || result.success === false) {
    throw PingRoomError.fromResponse(res.status, json, res.headers);
  }
  return result;
}

// --- internals ------------------------------------------------------------

function normalizeSignature(sig: string): string {
  const s = sig.trim();
  return s.startsWith('sha256=') ? s.slice('sha256='.length) : s;
}

function normalizeTimestamp(timestamp: string | number | null | undefined): string | null {
  if (timestamp === null || timestamp === undefined) {
    return null;
  }
  const normalized = typeof timestamp === 'string' ? timestamp.trim() : String(timestamp);
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const seconds = Number(normalized);
  return Number.isSafeInteger(seconds) ? normalized : null;
}

function normalizeDeliveryId(deliveryId: string | null | undefined): string | null {
  return typeof deliveryId === 'string' && /^[\x21-\x7e]{1,255}$/.test(deliveryId)
    ? deliveryId
    : null;
}

function signedMessage(prefixText: string, payload: string | ArrayBuffer | Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const prefix = enc.encode(prefixText);
  const body = typeof payload === 'string'
    ? enc.encode(payload)
    : payload instanceof Uint8Array
      ? payload
      : new Uint8Array(payload);
  const message = new Uint8Array(prefix.byteLength + body.byteLength);
  message.set(prefix, 0);
  message.set(body, prefix.byteLength);
  return message;
}

async function hmacSha256Hex(secret: string, message: Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, message as BufferSource);
  const bytes = new Uint8Array(signature);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Constant-time compare of two equal-length lowercase-hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
