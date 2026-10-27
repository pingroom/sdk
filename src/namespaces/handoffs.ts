// `pr.handoffs`: the direct, private agent-to-human loop.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import {
  assertStructuredData,
  normalizeIdempotencyKey,
  requireNonEmpty,
} from '../internal/guards.js';
import { pollUntilSettled } from '../internal/retry.js';
import type {
  AskInput,
  Handoff,
  HandoffOptionInput,
  HandoffOptionSpec,
  ListHandoffsInput,
  RequestAckInput,
  WaitHandoffInput,
  WaitForOutcomeOptions,
} from '../types.js';
import {
  MIN_HANDOFF_POLL_INTERVAL_MS,
  enc,
  assertOnRetry,
  dropUndefined,
  waitTimeoutMs,
} from '../internal/request.js';
import { isRecord, sameId, invalidWaitResponse } from '../internal/validate.js';

const HANDOFF_STATES: ReadonlySet<string> = new Set(['open', 'acked', 'pending', 'answered', 'expired', 'cancelled']);

function validateHandoffWait(value: unknown, handoffId: string): Handoff {
  const state = isRecord(value) ? value['state'] : undefined;
  if (!isRecord(value) || !sameId(value['id'], handoffId) || typeof state !== 'string' || !HANDOFF_STATES.has(state)) {
    return invalidWaitResponse('handoff', handoffId, value, 'state');
  }
  return value as unknown as Handoff;
}

/** A bare string option is shorthand for `{ value, label: value }`. */
function normalizeHandoffOptions(options: HandoffOptionSpec[]): HandoffOptionInput[] {
  return options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
}

/** Terminal states never change again — the wait loop can stop as soon as one lands. */
function isHandoffTerminal(handoff: Handoff): boolean {
  const s = handoff.state;
  return s === 'acked' || s === 'answered' || s === 'expired' || s === 'cancelled';
}

/**
 * The Handoff façade: the Agent → one-human loop. Always DIRECT (exactly one
 * human) and PRIVATE (no other room member can read it). Backed by the ack and
 * question primitives, so its {@link Handoff.state | state} space is their union
 * — kept DISTINCT per {@link Handoff.kind | kind}. A negative answer to a
 * question handoff (e.g. `hold`) is a SUCCESSFUL `answered` result, not an error.
 *
 *   const task = await pr.handoffs.requestAck({ prompt, idempotencyKey });
 *   const result = await pr.handoffs.waitForResult(task.id);
 *
 *   const q = await pr.handoffs.ask({ prompt, options: ['deploy', 'hold'], idempotencyKey });
 */
export class HandoffsApi {
  constructor(private readonly http: HttpClient) {}

  /** Ask a human to acknowledge (an `ack` handoff). Resolves on the first acknowledgement. */
  requestAck(input: RequestAckInput): Promise<Handoff> {
    requireNonEmpty(input.prompt, 'prompt');
    assertStructuredData(input.data);
    return this.create('ack', input);
  }

  /**
   * Ask a human a multi-option question (a `question` handoff). Resolves on the
   * first tapped answer. Bare-string options normalize to `{ value, label }`.
   */
  ask(input: AskInput): Promise<Handoff> {
    requireNonEmpty(input.prompt, 'prompt');
    assertStructuredData(input.data);
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 4) {
      throw new PingRoomError('`options` must contain between 2 and 4 entries for a question handoff.', {
        code: 'invalid_request',
      });
    }
    return this.create('question', input, normalizeHandoffOptions(input.options));
  }

  /** Fetch a handoff's current state. */
  get(id: string): Promise<Handoff> {
    requireNonEmpty(id, 'id');
    return this.http.request('GET', `/api/agent/handoffs/${enc(id)}`);
  }

  /**
   * Block until the handoff resolves (or expires/cancels), looping the bounded
   * long-poll under the hood. `expired`/`cancelled` and a negative answer (e.g.
   * `hold`) all surface as normal terminal results — nothing is thrown for them.
   *
   * Polls start at least 2.1 s apart, so a short `timeout` stays under the
   * route's 30-per-minute limit. A response that is not this handoff in a
   * known state rejects with `invalid_response`. Network failures, 429 and 5xx
   * are retried with backoff (honouring `retryAfter`), and reported to
   * `onRetry`, until `signal` aborts or the outage outlasts the handoff's
   * `expires_at` by 5 minutes (15 minutes of failures while no `expires_at` has
   * been read); that rejects with `unavailable`. See {@link WaitForOutcomeOptions}.
   */
  async waitForResult(id: string, input: WaitHandoffInput & WaitForOutcomeOptions = {}): Promise<Handoff> {
    requireNonEmpty(id, 'id');
    assertOnRetry(input.onRetry);
    return pollUntilSettled({
      poll: () => this.wait(id, input),
      validate: (value) => validateHandoffWait(value, id),
      settled: isHandoffTerminal,
      expiresAt: (handoff) => handoff.expires_at,
      what: `handoff ${id}`,
      minIntervalMs: MIN_HANDOFF_POLL_INTERVAL_MS,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onRetry ? { onRetry: input.onRetry } : {}),
    });
  }

  /** List the agent's open handoffs or bounded recent history. */
  async list(input: ListHandoffsInput = {}): Promise<Handoff[]> {
    const res = await this.http.request<{ handoffs: Handoff[] }>('GET', '/api/agent/handoffs', {
      query: dropUndefined({ state: input.state }),
    });
    return res.handoffs ?? [];
  }

  /** One bounded long-poll; returns the (possibly still-open) handoff. */
  private wait(id: string, input: WaitHandoffInput): Promise<Handoff> {
    return this.http.request('GET', `/api/agent/handoffs/${enc(id)}/wait`, {
      query: dropUndefined({ timeout: input.timeout }),
      timeoutMs: waitTimeoutMs(input.timeout),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  private create(
    kind: 'ack' | 'question',
    input: RequestAckInput,
    options?: HandoffOptionInput[],
  ): Promise<Handoff> {
    const body = dropUndefined({
      kind,
      prompt: input.prompt,
      audience: { type: 'direct', user_id: input.target ?? 'me' },
      expires_in: input.expiresIn,
      urgency: input.urgency,
      options,
      correlation_id: input.correlationId,
      reply_to: input.replyTo,
      data: input.data,
    });
    return this.http.request('POST', '/api/agent/handoffs', {
      body,
      ...(input.idempotencyKey ? { headers: { 'Idempotency-Key': normalizeIdempotencyKey(input.idempotencyKey) } } : {}),
    });
  }
}
