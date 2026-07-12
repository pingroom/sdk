/**
 * Webhook helpers — usable standalone, no client/token required.
 *
 *  - verifyWebhookSignature: verify an OUTGOING webhook PingRoom sent you.
 *    PingRoom signs `HMAC-SHA256(signing_secret, timestamp + "." + rawBody)`
 *    and sends the timestamp and lower-case hex signature in the PingRoom
 *    headers. Verify over the EXACT raw request body bytes — re-serializing the
 *    parsed JSON will not match.
 *
 *  - sendIncomingWebhook: fire a room's INCOMING webhook (the URL carries its
 *    own secret, so no agent token is needed) — the one-line CI/deploy ping.
 */

import { PingRoomError } from './errors.js';
import { combineSignals } from './internal/async.js';
import { assertActionNumber, assertStructuredData } from './internal/guards.js';
import { assertSecureUrl } from './internal/url.js';
import type { ActionState, FetchLike, JsonObject } from './types.js';
import { VERSION } from './version.js';

export const WEBHOOK_SIGNATURE_HEADER = 'X-PingRoom-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-PingRoom-Timestamp';
export const WEBHOOK_DELIVERY_HEADER = 'X-PingRoom-Delivery';
export const WEBHOOK_EVENT_HEADER = 'X-PingRoom-Event';

export interface VerifyWebhookSignatureOptions {
  /** The raw request body — the exact bytes received, NOT a re-stringified object. */
  payload: string | ArrayBuffer | Uint8Array;
  /** The X-PingRoom-Signature header value (with or without the `sha256=` prefix). */
  signature: string | null | undefined;
  /** The X-PingRoom-Timestamp header value (Unix seconds). */
  timestamp: string | number | null | undefined;
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
  if (!opts.signature || !opts.secret) {
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
  const provided = normalizeSignature(opts.signature).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return false;
  }
  const expected = await hmacSha256Hex(opts.secret, signedMessage(timestamp, opts.payload));
  return timingSafeEqualHex(provided, expected);
}

export interface IncomingWebhookPayload {
  message?: string;
  title?: string;
  /** Quick-action slot to attribute the ping to (1–4). */
  action?: number;
  data?: JsonObject;
  correlation_id?: string;
  reply_to?: string;
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

/** POST to a room's incoming-webhook URL (which embeds the secret in its path). */
export async function sendIncomingWebhook(
  webhookUrl: string,
  payload: IncomingWebhookPayload,
  options: SendIncomingWebhookOptions = {},
): Promise<IncomingWebhookResult> {
  assertSecureUrl(webhookUrl, options.allowInsecure ?? false);
  assertActionNumber(payload.action);
  assertStructuredData(payload.data);

  const body: Record<string, unknown> = {};
  if (payload.message !== undefined) body.message = payload.message;
  if (payload.title !== undefined) body.title = payload.title;
  if (payload.action !== undefined) body.action = payload.action;
  if (payload.data !== undefined) body.data = payload.data;
  if (payload.correlation_id !== undefined) body.correlation_id = payload.correlation_id;
  if (payload.reply_to !== undefined) body.reply_to = payload.reply_to;
  if (payload.requires_ack !== undefined) body.requires_ack = payload.requires_ack;
  if (payload.ack_timeout_seconds !== undefined) body.ack_timeout_seconds = payload.ack_timeout_seconds;

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

function signedMessage(timestamp: string, payload: string | ArrayBuffer | Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const prefix = enc.encode(`${timestamp}.`);
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
