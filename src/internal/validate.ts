// Shape checks for server responses the wait loops and Agent Inbox trust.

import { PingRoomError } from '../errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** UUIDs are case-insensitive; a caller may hold an id in either case. */
export function sameId(received: unknown, expected: string): boolean {
  return typeof received === 'string' && received.toLowerCase() === expected.toLowerCase();
}

export function invalidWaitResponse(subject: string, expectedId: string, value: unknown, stateField: string): never {
  throw new PingRoomError(`PingRoom returned an invalid ${subject} wait response.`, {
    code: 'invalid_response',
    body: {
      expected_id: expectedId,
      received_id: isRecord(value) && typeof value['id'] === 'string' ? value['id'] : null,
      [stateField]: isRecord(value) && typeof value[stateField] === 'string' ? value[stateField] : null,
    },
  });
}

/**
 * A 2xx the PingRoom API never sends: a gateway's or captive portal's page, or
 * a URL that is not PingRoom's. The body is kept short, for inspection only.
 */
export function invalidSuccessResponse(status: number, expected: string, body: unknown): PingRoomError {
  return new PingRoomError(`PingRoom returned an invalid response (HTTP ${status}): expected ${expected}.`, {
    code: 'invalid_response',
    body: typeof body === 'string' ? body.slice(0, 512) : body,
  });
}
