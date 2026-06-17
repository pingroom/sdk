import { PingRoomError } from '../errors.js';

/** Mirrors the server's structured-`data` limits so oversized payloads fail fast, locally. */
export const MAX_DATA_BYTES = 8 * 1024;
export const MAX_DATA_KEYS = 25;

export function assertStructuredData(data: unknown): void {
  if (data === undefined || data === null) {
    return;
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new PingRoomError('`data` must be a JSON object (not an array or scalar).', { code: 'invalid_data' });
  }
  const keys = Object.keys(data as object);
  if (keys.length > MAX_DATA_KEYS) {
    throw new PingRoomError(`\`data\` may have at most ${MAX_DATA_KEYS} keys (got ${keys.length}).`, { code: 'invalid_data' });
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(data);
  } catch {
    throw new PingRoomError('`data` must be JSON-serializable.', { code: 'invalid_data' });
  }
  const bytes = new TextEncoder().encode(encoded).length;
  if (bytes > MAX_DATA_BYTES) {
    throw new PingRoomError(`\`data\` is too large (${bytes} bytes, max ${MAX_DATA_BYTES}).`, { code: 'invalid_data' });
  }
}

export function assertActionNumber(n: unknown): void {
  if (n === undefined || n === null) {
    return;
  }
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 4) {
    throw new PingRoomError('action_number must be an integer 1–4.', { code: 'invalid_request' });
  }
}

export function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PingRoomError(`\`${field}\` is required.`, { code: 'invalid_request' });
  }
}
