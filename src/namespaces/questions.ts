// `pr.questions`: Questions and polls in a room.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { assertStructuredData, requireNonEmpty } from '../internal/guards.js';
import { pollUntilSettled } from '../internal/retry.js';
import type {
  ListQuestionsInput,
  Question,
  QuestionInput,
  WaitForOutcomeOptions,
  WaitQuestionInput,
} from '../types.js';
import {
  MIN_WAIT_POLL_INTERVAL_MS,
  enc,
  splitIdempotencyKey,
  assertOnRetry,
  dropUndefined,
  waitTimeoutMs,
} from '../internal/request.js';
import { isRecord, sameId, invalidWaitResponse } from '../internal/validate.js';

const QUESTION_STATES: ReadonlySet<string> = new Set(['pending', 'answered', 'expired', 'cancelled']);

function validateQuestionWait(value: unknown, questionId: string): Question {
  const state = isRecord(value) ? value['state'] : undefined;
  if (!isRecord(value) || !sameId(value['id'], questionId) || typeof state !== 'string' || !QUESTION_STATES.has(state)) {
    return invalidWaitResponse('question', questionId, value, 'state');
  }
  return value as unknown as Question;
}

/**
 * The general human-in-the-loop primitive: ask a human a question with 2–4
 * options (or a short typed answer) and block until they tap an answer. An
 * {@link ApprovalsApi | approval} is the two-option case; reach for questions
 * when you need more choices, a typed reply, or room-scope answering.
 */
export class QuestionsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Ask a Question in a room; returns the pending Question (id + computed
   * expiry). Pass `resolution_policy: 'all'` to poll the room: everyone asked
   * votes once, and `results` carries the tally on every read.
   */
  ask(inviteCode: string, input: QuestionInput): Promise<Question> {
    requireNonEmpty(input.prompt, 'prompt');
    assertStructuredData(input.data);
    assertPollShape(input);
    const { body, headers } = splitIdempotencyKey(input);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/questions`, {
      body: dropUndefined(body),
      ...(headers ? { headers } : {}),
    });
  }

  /** Fetch a Question's current state. */
  get(questionId: string): Promise<Question> {
    return this.http.request('GET', `/api/agent/questions/${enc(questionId)}`);
  }

  /** One long-poll for the answer; returns the (possibly still-pending) Question. */
  wait(questionId: string, input: WaitQuestionInput = {}): Promise<Question> {
    return this.http.request('GET', `/api/agent/questions/${enc(questionId)}/wait`, {
      query: dropUndefined({ timeout: input.timeout }),
      timeoutMs: waitTimeoutMs(input.timeout),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * Block until the human answers (or the question expires/cancels), looping
   * wait() under the hood. Returns the resolved Question — inspect `state` and
   * `answer.value` to branch. A poll returns once it closes; its `answer` is the
   * leading option, or `null` on a tie, and `results` holds the tally.
   *
   * Polls start at least 1 s apart. A response that is not this Question in a
   * known state rejects with `invalid_response`. Network failures, 429 and 5xx
   * are retried with backoff (honouring `retryAfter`), and reported to
   * `onRetry`, until `signal` aborts or the outage outlasts the Question's
   * `expires_at` by 5 minutes (15 minutes of failures while no `expires_at` has
   * been read); that rejects with `unavailable`. See {@link WaitForOutcomeOptions}.
   */
  async waitForAnswer(questionId: string, input: WaitForOutcomeOptions = {}): Promise<Question> {
    requireNonEmpty(questionId, 'questionId');
    assertOnRetry(input.onRetry);
    return pollUntilSettled({
      poll: () => this.wait(questionId, input.signal ? { signal: input.signal } : {}),
      validate: (value) => validateQuestionWait(value, questionId),
      settled: (question) => question.state !== 'pending',
      expiresAt: (question) => question.expires_at,
      what: `question ${questionId}`,
      minIntervalMs: MIN_WAIT_POLL_INTERVAL_MS,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onRetry ? { onRetry: input.onRetry } : {}),
    });
  }

  /** List the asker's Questions, optionally filtered by state. */
  async list(input: ListQuestionsInput = {}): Promise<Question[]> {
    const res = await this.http.request<{ questions: Question[] }>('GET', '/api/agent/questions', {
      query: dropUndefined({ state: input.state }),
    });
    return res.questions ?? [];
  }

  /** Withdraw a still-pending Question (409 if it already resolved). */
  cancel(questionId: string): Promise<Question> {
    return this.http.request('POST', `/api/agent/questions/${enc(questionId)}/cancel`, { body: {} });
  }
}

/**
 * A poll asks the whole room and counts option votes, so the server refuses it
 * (422 on `resolution_policy`) alongside a direct scope, a named target, or a
 * typed answer. Fail before the request instead.
 */
function assertPollShape(input: QuestionInput): void {
  if (input.resolution_policy !== 'all') return;
  const target = input.target_user_id as unknown;
  if (
    input.responder_scope === 'direct'
    || (target !== undefined && target !== null && target !== '')
    || (input.text_input !== undefined && input.text_input !== null)
  ) {
    throw new PingRoomError(
      "A poll (`resolution_policy: 'all'`) asks the whole room with options only; it cannot use `responder_scope: 'direct'`, `target_user_id`, or `text_input`.",
      { code: 'invalid_request' },
    );
  }
}
