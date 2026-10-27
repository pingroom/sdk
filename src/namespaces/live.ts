// `pr.live`: live-status streams.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { assertStructuredData, requireNonEmpty } from '../internal/guards.js';
import type { LiveStatusPing, LiveStatusResult, LiveStatusSnapshot } from '../liveStatus.js';
import { enc } from '../internal/request.js';

/**
 * Live-status streams — a self-updating card on the room members' lock screen.
 *
 * Requires the `pingroom:live:write` scope. Free accounts get a small daily
 * budget of NEW streams; updates and the terminal ping of an open stream are
 * never charged, so a card can never be quota-blocked into hanging open. A
 * first ping that is already `done`/`failed` is a new stream and is charged.
 */
export class LiveApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Send one stream ping — start, update, or end, chosen by `live_status.state`
   * and whether the correlation already exists.
   */
  push(inviteCode: string, ping: LiveStatusPing): Promise<LiveStatusResult> {
    requireNonEmpty(inviteCode, 'inviteCode');
    requireNonEmpty(ping.correlation_id, 'correlation_id');
    assertStructuredData(ping.data);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/live`, { body: ping });
  }

  /**
   * Read back a stream this credential started, so a restarted producer can
   * reconcile instead of opening a duplicate.
   *
   * Resolves null ONLY for a 404 `stream_not_found` — no stream with that
   * correlation id in the last 24 hours. Every other failure throws: a 404 for
   * an unknown or deleted room code, and a 403 `room_not_granted`
   * ({@link RoomScopedErrorCode}) when the room is outside the grant the human
   * gave this agent, both propagate rather than being reported as "no stream".
   */
  async get(inviteCode: string, correlationId: string): Promise<LiveStatusSnapshot | null> {
    requireNonEmpty(inviteCode, 'inviteCode');
    requireNonEmpty(correlationId, 'correlationId');
    try {
      return await this.http.request<LiveStatusSnapshot>(
        'GET',
        `/api/agent/rooms/${enc(inviteCode)}/live/${enc(correlationId)}`,
      );
    } catch (error) {
      if (error instanceof PingRoomError && error.status === 404 && error.code === 'stream_not_found') return null;
      throw error;
    }
  }
}
