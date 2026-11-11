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
 *    Pass a top-level `live_status` to drive a Live Activity instead, or a
 *    top-level `metric` to update a room metric (no Ping is sent).
 */

import { PingRoomError, PingRoomTimeoutError } from './errors.js';
import { defaultFetch } from './http.js';
import { combineSignals } from './internal/async.js';
import {
  assertActionNumber,
  assertMaxLength,
  assertReplaceKey,
  assertStructuredData,
  assertTags,
  MAX_PING_TITLE_LENGTH,
  MAX_PUBLIC_PING_MESSAGE_LENGTH,
  normalizeIdempotencyKey,
} from './internal/guards.js';
import { assertMetricFields, normalizeMetricKey } from './internal/metrics.js';
import { assertSecureUrl, redactUrlInMessage, refuseRedirect } from './internal/url.js';
import { invalidSuccessResponse, isRecord } from './internal/validate.js';
import type { LiveStatus } from './liveStatus.js';
import type { AckMode, ActionState, FetchLike, JsonObject, RoomMetric, SetMetricInput } from './types.js';
import { VERSION } from './version.js';

export const WEBHOOK_SIGNATURE_HEADER = 'X-PingRoom-Signature';
export const WEBHOOK_SIGNATURE_V2_HEADER = 'X-PingRoom-Signature-V2';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-PingRoom-Timestamp';
export const WEBHOOK_DELIVERY_HEADER = 'X-PingRoom-Delivery';
export const WEBHOOK_EVENT_HEADER = 'X-PingRoom-Event';

export interface VerifyWebhookSignatureOptions {
  /**
   * The raw request body — the exact bytes received, NOT a re-stringified
   * object. A string, an ArrayBuffer or a typed array/Buffer. Anything else
   * (an `{}` or `undefined` from a JSON/raw body parser that did not capture
   * the body) throws a TypeError rather than failing verification.
   */
  payload: string | ArrayBuffer | ArrayBufferView;
  /**
   * Legacy X-PingRoom-Signature value (with or without the `sha256=` prefix).
   * Tried only when `signatureV2` is absent and `requireV2` is not set.
   */
  signature?: string | null;
  /** X-PingRoom-Signature-V2 value. When present, v2 MUST verify; v1 is not tried. */
  signatureV2?: string | null;
  /**
   * Reject a delivery that carries no v2 signature instead of falling back to
   * the legacy v1 HMAC. v1 does not sign `X-PingRoom-Delivery`, so a captured
   * body replayed without its v2 header under a new delivery id still passes
   * v1. Every current delivery carries v2: set this to `true`, and always set
   * it when you dedupe on the delivery id. Default `false` for receivers that
   * predate v2.
   */
  requireV2?: boolean;
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
 * boolean and never throws on mismatch. Pass `requireV2: true` so a delivery
 * without the v2 signature is refused rather than checked against v1.
 *
 * Throws a TypeError when `payload` is not a string, ArrayBuffer or typed
 * array: a body parser that did not capture the raw bytes is a bug in the
 * receiver, and must not look the same as a forged signature.
 */
export async function verifyWebhookSignature(opts: VerifyWebhookSignatureOptions): Promise<boolean> {
  assertRawPayload(opts.payload);
  const hasV2Signature = opts.signatureV2 !== null && opts.signatureV2 !== undefined;
  if (opts.requireV2 === true && !hasV2Signature) {
    return false;
  }
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
  /** Optional Quick Ping preset (1–16). Null bypasses the webhook's stored preset. */
  action?: number | null;
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
   * Up to 10 labels (each 1–32 characters of lowercase letters, digits, `-`
   * and `_`, starting with a letter or digit) to file the ping under; the
   * server trims, lowercases and de-duplicates them. On a `live_status` stream
   * they are set when the stream is created and never changed by a later ping.
   */
  tags?: string[];
  /**
   * This webhook's own handle for "the Ping I keep updating" (1–64 characters:
   * letters, digits, `.` `_` `:` `-`), sent as `replace_key`. A fire carrying
   * one replaces this webhook's earlier Ping with that key in the room, in
   * place, while that Ping is under 24 hours old, replaced fewer than 20 times
   * and replaceable: the result is the same `notification_id` with
   * `replaced: true`. Otherwise a new Ping is sent and keeps the key (no
   * `replaced` key in the result).
   *
   * A fire that asks for something a replacement cannot do (`requires_ack`,
   * `is_urgent`, `tags`, or a different `action`, `emoji`, `icon`, `color`,
   * `correlation_id` or `reply_to`) always sends a new Ping. Not for
   * `live_status`. While the server has replacing switched off the key is
   * stored and ignored.
   */
  replaceKey?: string;
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
  /**
   * Update a room metric instead of sending a Ping: `{ key, value, label?,
   * format?, unit? }` (see `metrics.set()`). MUST be top-level, like
   * `live_status`, and cannot be combined with it (the server answers 422).
   * The webhook's own gates apply (secret, enabled, the owner's plan, the
   * operator switches) and so does its rate limit, but not its per-webhook
   * cooldown, and nothing is sent to anyone's phone: the other Ping fields in the
   * body are ignored. The result carries the stored `metric`, plus
   * `unchanged: true` when the value repeated what the metric already had.
   */
  metric?: IncomingWebhookMetric;
  /**
   * Override the selected quick action and require acknowledgement for this
   * ping. Does NOT raise the delivery priority — that is {@link is_urgent}.
   */
  requires_ack?: boolean;
  /** Confirmation rule for a regular ping (not live_status); defaults to any. */
  ack_mode?: AckMode;
  /**
   * Deliver time-sensitive so the ping breaks through Focus / Do Not Disturb.
   * Payload-only and independent of `requires_ack`: a webhook trigger has no
   * stored urgency policy to inherit from the quick action it fires.
   */
  is_urgent?: boolean;
  /** Optional acknowledgement deadline in seconds. Omit/null for no deadline. */
  ack_timeout_seconds?: number | null;
}

/** The `metric` of an incoming webhook body: a metric key plus what `metrics.set()` takes. */
export interface IncomingWebhookMetric extends SetMetricInput {
  /** 1–40 characters of letters, digits, `-` and `_`; trimmed and lowercased by the server. */
  key: string;
}

export interface SendIncomingWebhookOptions {
  /**
   * Sent as the Idempotency-Key header; identical keys within ~1h replay the
   * first result. Omitted or empty-string keys send no header. Other keys must
   * be 1–255 printable ASCII characters (spaces allowed), else `invalid_request`
   * before sending.
   */
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
  /** `true` when a fire with a `replaceKey` replaced this webhook's earlier Ping instead of sending a new one. */
  replaced?: boolean;
  message?: string;
  action_state?: ActionState | null;
  /** Set when the body carried a `metric`: the metric as stored. */
  metric?: RoomMetric;
  /** `true` when a `metric` write repeated the stored value and changed nothing. */
  unchanged?: boolean;
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
 *
 * `replace_key` is also a server field, but the SDK takes it as `replaceKey`
 * and maps it by hand in `sendIncomingWebhook`, so it is not in this list.
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
  'tags',
  'is_urgent',
  'requires_ack',
  'ack_mode',
  'ack_timeout_seconds',
  // Top level, never folded into `data` — the server routes on this key and
  // strips it from `data` so a legacy-path caller cannot spoof completion alerts.
  'live_status',
  // Top level as well: a body with a `metric` updates a room metric and sends no Ping.
  'metric',
] as const satisfies readonly (keyof IncomingWebhookPayload)[];

/** POST to a room's incoming-webhook URL (which embeds the secret in its path). */
export async function sendIncomingWebhook(
  webhookUrl: string,
  payload: IncomingWebhookPayload,
  options: SendIncomingWebhookOptions = {},
): Promise<IncomingWebhookResult> {
  const parsedUrl = assertSecureUrl(webhookUrl, options.allowInsecure ?? false);
  // A webhook URL does not reveal room visibility, so validate the public
  // ceiling here and let the server enforce 120 for private rooms.
  assertMaxLength(payload.message, MAX_PUBLIC_PING_MESSAGE_LENGTH, 'message');
  assertMaxLength(payload.title, MAX_PING_TITLE_LENGTH, 'title');
  assertActionNumber(payload.action);
  assertStructuredData(payload.data);
  assertTags(payload.tags);
  assertReplaceKey(payload.replaceKey);
  assertWebhookMetric(payload);

  const body: Record<string, unknown> = {};
  for (const field of INCOMING_WEBHOOK_FIELDS) {
    const value = payload[field];
    if (value !== undefined) body[field] = value;
  }
  // `replaceKey` is the SDK's name for the wire field `replace_key`; it is the
  // one field this list does not carry under its own name.
  if (payload.replaceKey !== undefined) body['replace_key'] = payload.replaceKey;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': `pingroom-sdk/${VERSION}`,
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = normalizeIdempotencyKey(options.idempotencyKey);
  }

  const fetchImpl = options.fetch ?? defaultFetch();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new PingRoomTimeoutError()), options.timeoutMs ?? 30_000);
  const signal = combineSignals(controller.signal, options.signal);

  try {
    // 'manual' plus an explicit refusal: Workers reject redirect: 'error', and
    // a 307/308 must not replay this body to another origin.
    const res = await fetchImpl(webhookUrl, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'manual' });
    refuseRedirect(res);
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (!res.ok || (isRecord(json) && json['success'] === false)) {
      throw PingRoomError.fromResponse(res.status, json, res.headers);
    }
    // Every success the endpoint sends is a JSON object with `success: true`.
    // Anything else is a misrouted URL or a proxy's page, not a delivered Ping.
    if (!isRecord(json) || json['success'] !== true) {
      throw invalidSuccessResponse(res.status, 'a JSON object with `success: true`', json);
    }
    return json as IncomingWebhookResult;
  } catch (err) {
    if (signal.aborted) {
      throw signal.reason;
    }
    if (err instanceof PingRoomError) {
      throw err;
    }
    const reason = redactUrlInMessage(err instanceof Error ? err.message : String(err), parsedUrl, webhookUrl);
    throw new PingRoomError(`Webhook request failed: ${reason}`, {
      code: 'network_error',
    });
  } finally {
    clearTimeout(timer);
  }
}

// --- internals ------------------------------------------------------------

/**
 * A `metric` body is validated the way `metrics.set()` validates its arguments,
 * and cannot ride with `live_status`: the server answers 422 rather than pick one.
 */
function assertWebhookMetric(payload: IncomingWebhookPayload): void {
  if (payload.metric === undefined) {
    return;
  }
  if (payload.live_status !== undefined) {
    throw new PingRoomError('`metric` cannot be combined with `live_status`; send them as separate requests.', { code: 'invalid_request' });
  }
  if (payload.metric === null || typeof payload.metric !== 'object' || Array.isArray(payload.metric)) {
    throw new PingRoomError('`metric` must be an object with a `key` and a `value`.', { code: 'invalid_request' });
  }
  normalizeMetricKey(payload.metric.key, 'metric.key');
  assertMetricFields(payload.metric, { requireValue: true }, 'metric.');
}

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

// `Object.prototype.toString` rather than `instanceof ArrayBuffer`: a buffer
// from another realm (a test sandbox, a worker) is still the raw body.
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function assertRawPayload(payload: unknown): void {
  if (typeof payload === 'string' || isArrayBuffer(payload) || ArrayBuffer.isView(payload)) {
    return;
  }
  const received = payload === null ? 'null' : Array.isArray(payload) ? 'an array' : typeof payload;
  throw new TypeError(
    `verifyWebhookSignature: \`payload\` must be the raw request body as a string, ArrayBuffer or Buffer/Uint8Array, got ${received}. `
    + 'Capture the raw bytes before any JSON parsing (for Express: express.raw({ type: \'application/json\' }) on this route).',
  );
}

function signedMessage(prefixText: string, payload: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  const enc = new TextEncoder();
  const prefix = enc.encode(prefixText);
  const body = typeof payload === 'string'
    ? enc.encode(payload)
    : ArrayBuffer.isView(payload)
      // The view's own bytes: a Buffer is a window onto a larger pool, and a
      // DataView or Int16Array must not be read element by element.
      ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
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
