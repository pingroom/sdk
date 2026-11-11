// `pr.notifications`: history, one-shot waits and the listen() iterator.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { sleep } from '../internal/async.js';
import { assertTag, requireNonEmpty } from '../internal/guards.js';
import { isTransientError, transientDelayMs } from '../internal/retry.js';
import { isRecord } from '../internal/validate.js';
import type {
  AcknowledgementWaitResult,
  AgentNotification,
  ListNotificationsInput,
  ListenInput,
  NotificationDetail,
  NotificationHistoryEntry,
  Paginated,
  PingResult,
  ReplacePingInput,
  WaitForAcknowledgementInput,
  WaitInput,
  WaitResult,
} from '../types.js';
import { assertReplacePing, enc, dropUndefined, MIN_LISTEN_POLL_INTERVAL_MS, waitTimeoutMs } from '../internal/request.js';

/**
 * A 2xx that is not a wait answer (a captive portal's HTML, a proxy's error
 * page served as 200) must not end `listen()` with a bare TypeError, nor
 * advance its cursor.
 */
function validateListenResult(value: unknown, requireCursor: boolean): WaitResult {
  if (
    !isRecord(value)
    || !Array.isArray(value['notifications'])
    || value['notifications'].some((notification) => !isRecord(notification))
    || (value['cursor'] === undefined ? requireCursor : typeof value['cursor'] !== 'string')
  ) {
    throw new PingRoomError('PingRoom returned an invalid notifications wait response.', {
      code: 'invalid_response',
    });
  }
  return value as unknown as WaitResult;
}

export class NotificationsApi {
  constructor(private readonly http: HttpClient) {}

  /** Paginated list (polling fallback). Prefer wait()/listen() for real-time. */
  async list(input: ListNotificationsInput = {}): Promise<Paginated<NotificationHistoryEntry>> {
    const { notifications_per_page, ...query } = input;
    assertTag(input.tag);
    const page = await this.http.request<Paginated<NotificationDetail>>('GET', '/api/agent/notifications', {
      query: dropUndefined({ ...query, limit: input.limit ?? notifications_per_page }),
    });
    return {
      ...page,
      data: page.data.map(({ room, ...notification }) => ({
        ...notification,
        ...(room ? { room: { ...room, code: room.invite_code } } : {}),
      })),
    };
  }

  /** Fetch one visible notification, including its current acknowledgement state. */
  getNotification(notificationId: string): Promise<NotificationDetail> {
    requireNonEmpty(notificationId, 'notificationId');
    return this.http.request('GET', `/api/agent/notifications/${enc(notificationId)}`);
  }

  /**
   * Replace the title, message and data of a ping this credential already
   * sent. The notification already on each recipient's phone changes in place:
   * silently (no second notification, no sound) and with unread counts
   * unchanged. The result is the ping, with `edited_at` set.
   *
   *   const ping = await pr.broadcast('ab12cd', { message: 'Build 41: running' });
   *   await pr.notifications.replace('ab12cd', ping.id, { message: 'Build 41: green' });
   *
   * `title` and `data` keep their current value when omitted; `null` clears
   * them. Sending the text and data the ping already has is a no-op: it
   * answers 200 and pushes nothing. A replacement counts like a send against
   * the free plan's daily agent ping limit, and has no `idempotencyKey`.
   *
   * Only an ordinary ping you sent in a private room, under 24 hours old and
   * replaced fewer than 20 times, can be replaced. Every refusal has its own
   * `error.code` ({@link REPLACE_ERROR_CODES}); a 404 with no code means the
   * server has replacing switched off.
   */
  replace(inviteCode: string, notificationId: string, ping: ReplacePingInput): Promise<PingResult> {
    requireNonEmpty(inviteCode, 'inviteCode');
    requireNonEmpty(notificationId, 'notificationId');
    assertReplacePing(ping);
    return this.http.request('PUT', `/api/agent/rooms/${enc(inviteCode)}/notifications/${enc(notificationId)}`, {
      body: dropUndefined({ message: ping.message, title: ping.title, data: ping.data }),
    });
  }

  /**
   * Take back a ping this credential already sent. The notification is removed
   * from each recipient's Lock Screen and Notification Center, and the ping stays
   * in the room's history with its text and `withdrawn_at` set. Unread counts do
   * not change. The result is the ping.
   *
   *   const ping = await pr.broadcast('ab12cd', { message: 'Deploy started' });
   *   await pr.notifications.withdraw('ab12cd', ping.id);
   *
   * Taking back a ping that is already withdrawn is a harmless no-op (it
   * answers 200 and pushes nothing). It does not count against the free plan's
   * daily agent ping limit, and a withdrawn ping can no longer be replaced.
   *
   * Only an ordinary ping you sent in a private room and under 24 hours old can
   * be withdrawn, the same pings that can be replaced. Every refusal has its own
   * `error.code` ({@link WITHDRAW_ERROR_CODES}); a 404 with no code means the
   * server has withdrawing switched off.
   *
   * Removal is best effort: a phone that is offline, has the app force-quit or
   * restricts background activity keeps the notification until it next opens
   * the app, and only recent builds of the iPhone and Android apps remove it.
   */
  withdraw(inviteCode: string, notificationId: string): Promise<PingResult> {
    requireNonEmpty(inviteCode, 'inviteCode');
    requireNonEmpty(notificationId, 'notificationId');
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/notifications/${enc(notificationId)}/withdraw`, { body: {} });
  }

  /**
   * One bounded long-poll for an ack-required ping. The returned state may
   * still be `open` when the hold timeout elapses; call again to keep waiting.
   */
  waitForAcknowledgement(
    notificationId: string,
    input: WaitForAcknowledgementInput = {},
  ): Promise<AcknowledgementWaitResult> {
    requireNonEmpty(notificationId, 'notificationId');
    return this.http.request('GET', `/api/agent/notifications/${enc(notificationId)}/ack/wait`, {
      query: dropUndefined({ timeout: input.timeout }),
      timeoutMs: waitTimeoutMs(input.timeout),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /** One long-poll: resolves as soon as new pings land, or with an empty list at timeout. */
  wait(input: WaitInput = {}): Promise<WaitResult> {
    assertTag(input.tag);
    return this.http.request('GET', '/api/agent/notifications/wait', {
      query: dropUndefined({ after: input.after, timeout: input.timeout, limit: input.limit, tag: input.tag }),
      timeoutMs: waitTimeoutMs(input.timeout),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * Continuous real-time inbound: an async iterator that long-polls in a loop,
   * advancing the cursor, yielding each new ping. Stops when `signal` aborts.
   *
   *   for await (const ping of pr.notifications.listen({ signal })) { ... }
   */
  async *listen(input: ListenInput = {}): AsyncGenerator<AgentNotification, void, void> {
    assertTag(input.tag);
    let cursor = input.after;
    let headRead = cursor !== undefined;
    const backoffMs = input.backoffMs ?? 1000;
    let failures = 0;
    while (!input.signal?.aborted) {
      let result: WaitResult;
      // The head read is an immediate answer by design; only polls ahead of
      // the cursor are spaced.
      const polledForward = headRead;
      const pollStartedAt = Date.now();
      try {
        // The head read exists to obtain a cursor, so it must carry one.
        result = validateListenResult(headRead
          ? await this.wait({
            after: cursor,
            ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.tag !== undefined ? { tag: input.tag } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          })
          // No cursor yet: read the current head (an immediate, empty answer)
          // so only pings that land after this call are delivered.
          : await this.wait({ timeout: 0, ...(input.signal ? { signal: input.signal } : {}) }), !headRead);
      } catch (err) {
        if (input.signal?.aborted) {
          return;
        }
        // A revoked credential or a bad request never heals; only network
        // failures, deadlines, 429 and 5xx are retried.
        if (!isTransientError(err)) {
          throw err;
        }
        failures += 1;
        input.onError?.(err);
        await sleep(Math.max(
          transientDelayMs(err, failures, backoffMs),
          MIN_LISTEN_POLL_INTERVAL_MS - (Date.now() - pollStartedAt),
        ), input.signal);
        continue;
      }
      failures = 0;
      headRead = true;
      cursor = result.cursor ?? cursor;
      for (const n of result.notifications) {
        yield n;
      }
      // Yield between polls so timer-driven cancellation can run (see
      // ApprovalsApi). After an empty answer also keep polls a floor apart, so
      // `timeout: 0` or an early-answering proxy cannot spin the loop.
      const spacingMs = polledForward && result.notifications.length === 0
        ? Math.max(0, MIN_LISTEN_POLL_INTERVAL_MS - (Date.now() - pollStartedAt))
        : 0;
      await sleep(spacingMs, input.signal);
    }
  }
}
