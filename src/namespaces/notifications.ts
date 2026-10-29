// `pr.notifications`: history, one-shot waits and the listen() iterator.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { sleep } from '../internal/async.js';
import { requireNonEmpty } from '../internal/guards.js';
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
  WaitForAcknowledgementInput,
  WaitInput,
  WaitResult,
} from '../types.js';
import { enc, dropUndefined, MIN_LISTEN_POLL_INTERVAL_MS, waitTimeoutMs } from '../internal/request.js';

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
    return this.http.request('GET', '/api/agent/notifications/wait', {
      query: dropUndefined({ after: input.after, timeout: input.timeout, limit: input.limit }),
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
        await sleep(transientDelayMs(err, failures, backoffMs), input.signal);
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
