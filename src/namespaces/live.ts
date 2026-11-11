// `pr.live`: live-status streams.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { assertStructuredData, requireNonEmpty } from '../internal/guards.js';
import type {
  LiveClaimAction,
  LiveClaimResult,
  LiveClaimStatus,
  LiveClaimStreamState,
  LiveStatusPing,
  LiveStatusResult,
  LiveStatusSnapshot,
} from '../liveStatus.js';
import { enc } from '../internal/request.js';
import { isNonEmptyString, isRecord, sameId } from '../internal/validate.js';

/**
 * What each action's 200 receipt may say, as `[claim.status, stream state]`
 * pairs. `release` has two: letting go reopens a request that can still be
 * taken, but a request past its deadline (or four hours old with none) ends as
 * `expired` with stream state `failed`, exactly as time ends an open one. That
 * is still a 200, and a retry replays it. Only `release` can end that way.
 */
const CLAIM_OUTCOMES = {
  claim: [['claimed', 'running']],
  release: [['open', 'running'], ['expired', 'failed']],
  done: [['done', 'done']],
  cancel: [['cancelled', 'failed']],
} as const satisfies Record<LiveClaimAction, ReadonlyArray<readonly [LiveClaimStatus, LiveClaimStreamState]>>;

function validateClaimResult(value: unknown, notificationId: string, action: LiveClaimAction): LiveClaimResult {
  const expected = CLAIM_OUTCOMES[action];
  const claim = isRecord(value) ? value['claim'] : undefined;
  const party = isRecord(claim) ? claim['by'] : undefined;
  if (!isRecord(value) || !sameId(value['notification_id'], notificationId)
    || !isNonEmptyString(value['correlation_id']) || typeof value['idempotent'] !== 'boolean'
    || !isRecord(claim) || !expected
    || !expected.some(([status, state]) => claim['status'] === status && value['state'] === state)
    || typeof claim['late'] !== 'boolean'
    || !(party === null || isRecord(party) && isNonEmptyString(party['id']) && typeof party['name'] === 'string')
    || !(claim['at'] === null || typeof claim['at'] === 'number' && Number.isFinite(claim['at']))) {
    throw new PingRoomError('PingRoom returned an invalid claim transition receipt.', {
      code: 'invalid_response',
      body: { expected_notification_id: notificationId, action },
    });
  }
  return value as unknown as LiveClaimResult;
}

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

  /**
   * Act on a "Who's on it?" request as the human this credential acts for:
   * `claim` takes an open request (anyone but its asker), `release` lets go of
   * one you hold, `done` finishes it (its claimer, or its asker at any time) and
   * `cancel` withdraws it (its asker, or a room owner or admin).
   *
   * `release` returns the request to `open` only while it can still be taken.
   * Past its deadline (or four hours after it was made, when it has none) it
   * ends the request as `expired` instead: a 200 whose `claim.status` is
   * `expired` and whose `state` is `failed`, with `claim.by` and `claim.at`
   * `null`. It is not an error, and the asker hears "No one took it". No other
   * action resolves that way.
   *
   * `notificationId` is the request's `notification_id`, from the `push()`
   * result or `notifications.list()`. It needs only room membership, not room
   * ownership, and the `pingroom:live:write` scope.
   *
   * Repeating your own last action resolves with `idempotent: true`. A refusal
   * throws `PingRoomError`: `claim_conflict` (409), `claim_own_request` (422),
   * `claim_private_rooms_only` (422), `claim_not_found` (404) or `forbidden`
   * (403). On 409 and 422 `error.body` is a `LiveClaimRefusal` carrying the
   * request as it stands, so you can say who got it first.
   * A malformed or mismatched success throws `invalid_response`; the SDK
   * never repeats the transition POST automatically.
   */
  claim(inviteCode: string, notificationId: string, action: LiveClaimAction): Promise<LiveClaimResult> {
    requireNonEmpty(inviteCode, 'inviteCode');
    requireNonEmpty(notificationId, 'notificationId');
    if (typeof action !== 'string' || !Object.hasOwn(CLAIM_OUTCOMES, action)) {
      throw new PingRoomError('`action` must be claim, release, done or cancel.', { code: 'invalid_request' });
    }
    return this.http.request<unknown>(
      'POST',
      `/api/agent/rooms/${enc(inviteCode)}/live/${enc(notificationId)}/claim`,
      { body: { action } },
    ).then((value) => validateClaimResult(value, notificationId, action));
  }
}
