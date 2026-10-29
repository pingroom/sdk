// `pr.inbox`: setting up and activating the human's Agent Inbox.

import { PingRoomActivationIncompleteError, PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { combineSignals, sleep, throwIfAborted } from '../internal/async.js';
import { isTransientError, transientDelayMs } from '../internal/retry.js';
import type {
  AgentInboxEnsureResult,
  AgentInboxActivateInput,
  AgentInboxActivationQuestion,
  AgentInboxActivationResult,
  AgentInboxEnsureInput,
  Handoff,
} from '../types.js';
import {
  MIN_HANDOFF_POLL_INTERVAL_MS,
  enc,
  dropUndefined,
  waitTimeoutMs,
} from '../internal/request.js';
import { isRecord, isNonEmptyString, isNullableString } from '../internal/validate.js';

const DEFAULT_INBOX_ACTIVATION_TIMEOUT_MS = 120_000;

function invalidInboxResponse(message: string, body: Record<string, unknown> = {}): never {
  throw new PingRoomError(message, { code: 'inbox_invalid_response', body });
}

function validateInboxEnsure(value: unknown): AgentInboxEnsureResult {
  if (!isRecord(value) || value['onboarded'] !== true || typeof value['replayed'] !== 'boolean') {
    return invalidInboxResponse('PingRoom returned an invalid Agent Inbox ensure response.');
  }

  const room = value['room'];
  const question = value['question'];
  if (
    !isRecord(room)
    || !isNonEmptyString(room['id'])
    || typeof room['name'] !== 'string'
    || !isNonEmptyString(room['invite_code'])
    || typeof room['is_agent_inbox'] !== 'boolean'
    || !isRecord(question)
    || !isNonEmptyString(question['id'])
    || question['kind'] !== 'question'
    || !isNonEmptyString(question['prompt'])
    || !Array.isArray(question['options'])
    || question['options'].some((option) => (
      !isRecord(option)
      || !isNonEmptyString(option['value'])
      || !isNonEmptyString(option['label'])
    ))
    || (question['state'] !== 'pending'
      && question['state'] !== 'answered'
      && question['state'] !== 'expired'
      && question['state'] !== 'cancelled')
    || !isNullableString(question['expires_at'])
    || !isNullableString(question['created_at'])
  ) {
    return invalidInboxResponse('PingRoom returned an incomplete Agent Inbox ensure response.');
  }

  return value as unknown as AgentInboxEnsureResult;
}

function validateInboxWait(value: unknown, expectedId: string): Handoff {
  if (!isRecord(value)) {
    return invalidInboxResponse('PingRoom returned an invalid Agent Inbox wait response.');
  }

  const state = value['state'];
  if (
    !isNonEmptyString(value['id'])
    || value['id'] !== expectedId
    || value['kind'] !== 'question'
    || (state !== 'pending' && state !== 'answered' && state !== 'expired' && state !== 'cancelled')
    || (value['activation_completed'] !== undefined && typeof value['activation_completed'] !== 'boolean')
    || (state !== 'answered' && value['activation_completed'] === true)
  ) {
    return invalidInboxResponse('PingRoom returned a mismatched Agent Inbox wait response.', {
      expected_id: expectedId,
      received_id: typeof value['id'] === 'string' ? value['id'] : null,
      kind: typeof value['kind'] === 'string' ? value['kind'] : null,
      state: typeof state === 'string' ? state : null,
    });
  }

  if (state === 'answered') {
    const answer = value['answer'];
    if (
      !isRecord(answer)
      || !isNullableString(answer['value'])
      || !isNullableString(answer['label'])
      || !isNullableString(answer['text'])
      || (!isNonEmptyString(answer['value']) && !isNonEmptyString(answer['text']))
      || !isNullableString(answer['answered_at'])
      || (answer['responder'] !== null && !isRecord(answer['responder']))
    ) {
      return invalidInboxResponse('PingRoom returned an answered activation without a valid answer.', {
        id: expectedId,
        state,
      });
    }

    const responder = answer['responder'];
    if (
      isRecord(responder)
      && (!isNullableString(responder['id']) || !isNullableString(responder['display_name']))
    ) {
      return invalidInboxResponse('PingRoom returned an invalid activation responder.', {
        id: expectedId,
        state,
      });
    }
  } else if (value['answer'] !== undefined && value['answer'] !== null) {
    return invalidInboxResponse('PingRoom returned an answer for an unresolved activation.', {
      id: expectedId,
      state,
    });
  }

  return value as unknown as Handoff;
}

/** Setup and activation of the bound human's Agent Inbox delivery room. */
export class InboxApi {
  constructor(private readonly http: HttpClient) {}

  /** Replay the viable activation attempt or create its next numbered retry. */
  ensure(input: AgentInboxEnsureInput = {}): Promise<AgentInboxEnsureResult> {
    return this.http.request('POST', '/api/agent/inbox/ensure', {
      body: {},
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * Ensure the bound human's Agent Inbox, then block on its onboarding
   * Question until the server confirms activation, it expires/cancels, or the
   * overall deadline elapses. Pairing remains a separate operation so adopting
   * a credential never silently waits for a phone response.
   */
  async activate(input: AgentInboxActivateInput = {}): Promise<AgentInboxActivationResult> {
    const overallTimeoutMs = input.overallTimeoutMs ?? DEFAULT_INBOX_ACTIVATION_TIMEOUT_MS;
    if (!Number.isFinite(overallTimeoutMs) || overallTimeoutMs < 0) {
      throw new PingRoomError('`overallTimeoutMs` must be a non-negative finite number.', {
        code: 'invalid_request',
      });
    }

    const deadlineError = (): PingRoomActivationIncompleteError => (
      new PingRoomActivationIncompleteError(
        'deadline_exceeded',
        'Agent Inbox activation did not complete before the overall deadline.',
        { overall_timeout_ms: overallTimeoutMs },
      )
    );
    const deadlineController = new AbortController();
    const deadlineTimer = overallTimeoutMs === 0
      ? null
      : setTimeout(() => deadlineController.abort(deadlineError()), overallTimeoutMs);
    if (overallTimeoutMs === 0) deadlineController.abort(deadlineError());

    const signal = input.signal
      ? combineSignals(input.signal, deadlineController.signal)
      : deadlineController.signal;

    try {
      throwIfAborted(signal);
      const ensured = validateInboxEnsure(await this.ensure({ signal }));
      const questionId = ensured.question.id;

      let failures = 0;
      for (;;) {
        throwIfAborted(signal);
        const pollStartedAt = Date.now();
        let question: Handoff;
        try {
          question = validateInboxWait(await this.http.request<unknown>(
            'GET',
            `/api/agent/handoffs/${enc(questionId)}/wait`,
            {
              query: dropUndefined({ timeout: input.timeout }),
              timeoutMs: waitTimeoutMs(input.timeout),
              signal,
            },
          ), questionId);
        } catch (error) {
          // A dropped connection, a request deadline, a 429 (the wait routes
          // share one 30/min bucket per human) or a 5xx is not an outcome:
          // retry it like every other wait, inside the overall deadline.
          // Anything else is permanent and surfaces.
          throwIfAborted(signal);
          if (!isTransientError(error)) {
            throw error;
          }
          failures += 1;
          await sleep(transientDelayMs(error, failures), signal);
          continue;
        }
        failures = 0;
        throwIfAborted(signal);

        if (question.state === 'pending') {
          await sleep(
            Math.max(0, MIN_HANDOFF_POLL_INTERVAL_MS - (Date.now() - pollStartedAt)),
            signal,
          );
          continue;
        }

        if (question.state === 'answered' && question.activation_completed === true) {
          return {
            ...ensured,
            activation_completed: true,
            question: question as AgentInboxActivationQuestion,
          };
        }

        if (question.state === 'answered') {
          throw new PingRoomActivationIncompleteError(
            'answered_without_completion',
            'The onboarding Question was answered without verified native phone receipt before the answer.',
            { question_id: questionId, activation_completed: question.activation_completed ?? null },
          );
        }

        if (question.state === 'expired' || question.state === 'cancelled') {
          throw new PingRoomActivationIncompleteError(
            question.state,
            `The onboarding Question ${question.state} before Agent Inbox activation completed.`,
            { question_id: questionId, activation_completed: question.activation_completed ?? null },
          );
        }

        return invalidInboxResponse('PingRoom returned an invalid terminal activation state.', {
          id: questionId,
          state: question.state,
        });
      }
    } catch (error) {
      // A custom fetch implementation may reject with a generic AbortError
      // instead of the signal's richer reason. Preserve caller cancellation
      // and the activation-specific deadline error at this public boundary.
      throwIfAborted(signal);
      throw error;
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    }
  }
}
