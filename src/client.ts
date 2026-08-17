import { PingRoomActivationIncompleteError, PingRoomError } from './errors.js';
import { HttpClient } from './http.js';
import { combineSignals, sleep } from './internal/async.js';
import { assertActionNumber, assertStructuredData, requireNonEmpty } from './internal/guards.js';
import type { LiveStatusPing, LiveStatusResult, LiveStatusSnapshot } from './liveStatus.js';
import { McpClient } from './mcp.js';
import type {
  AcknowledgementWaitResult,
  Attachment,
  ZipManifest,
  AgentInboxEnsureResult,
  AgentInboxActivateInput,
  AgentInboxActivationQuestion,
  AgentInboxActivationResult,
  AgentInboxEnsureInput,
  AgentNotification,
  Approval,
  ApprovalInput,
  CreatePublicRoomInput,
  CreateRoomInput,
  Credential,
  ClaimCompleteParams,
  ClaimStartParams,
  AskInput,
  DirectoryEntry,
  DirectoryListInput,
  DirectoryProfile,
  DirectPingResult,
  Handoff,
  HandoffOptionInput,
  HandoffOptionSpec,
  ListHandoffsInput,
  JoinRoomInput,
  ListNotificationsInput,
  ListenInput,
  ListQuestionsInput,
  NotificationDetail,
  Paginated,
  PingInput,
  PingResult,
  PingRoomOptions,
  Question,
  QuestionInput,
  QuickAction,
  RegisterParams,
  PairingStart,
  PairingStatus,
  PairedCredential,
  Room,
  RequestAckInput,
  RotateHandleResult,
  StartPairingParams,
  TriggerInput,
  UpdateQuickActionInput,
  UploadAttachmentInput,
  WaitApprovalInput,
  WaitHandoffInput,
  WaitForAcknowledgementInput,
  WaitInput,
  WaitQuestionInput,
  WaitResult,
  WaitForPairingOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.pingroom.io';
const DEFAULT_PAIRING_SCOPES = [
  'pingroom:rooms:read',
  'pingroom:broadcast:send',
  'pingroom:handoffs:create',
] as const;
/** Extra wall-clock allowance over the server's hold window for long-poll calls. */
const LONG_POLL_BUFFER_MS = 10_000;
const DEFAULT_WAIT_SECONDS = 20;
const DEFAULT_INBOX_ACTIVATION_TIMEOUT_MS = 120_000;
const MIN_INBOX_ACTIVATION_POLL_INTERVAL_MS = 2100;

function envBaseUrl(): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.['PINGROOM_API_URL'] || proc?.env?.['PINGROOM_BASE_URL'] || undefined;
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function dropUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as Partial<T>;
}

function assertPing(ping: PingInput): void {
  requireNonEmpty(ping.message, 'message');
  assertActionNumber(ping.action_number);
  assertStructuredData(ping.data);
}

function waitTimeoutMs(seconds: number | undefined): number {
  return (seconds ?? DEFAULT_WAIT_SECONDS) * 1000 + LONG_POLL_BUFFER_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new Error('aborted');
  }
}

// --- namespaces -----------------------------------------------------------

/** Agent credential lifecycle (auth.md flow). */
class AuthApi {
  constructor(private readonly http: HttpClient) {}

  /** Register an agent. Anonymous or via an identity assertion (ID-JAG / verified email). Public. */
  register(params: RegisterParams): Promise<Credential> {
    requireNonEmpty(params.type, 'type');
    return this.http.request('POST', '/api/agent/auth', { auth: false, body: dropUndefined({ ...params }) });
  }

  /** Begin claiming a pre-claim credential onto a human account; emails an OTP. */
  claimStart(params: ClaimStartParams): Promise<{ message: string; expires_in: number }> {
    requireNonEmpty(params.email, 'email');
    return this.http.request('POST', '/api/agent/auth/claim/start', { body: { email: params.email } });
  }

  /** Complete the claim with the emailed OTP; returns an active credential + handle. */
  claimComplete(params: ClaimCompleteParams): Promise<Credential> {
    requireNonEmpty(params.email, 'email');
    requireNonEmpty(params.otp, 'otp');
    return this.http.request('POST', '/api/agent/auth/claim/complete', { body: dropUndefined({ ...params }) });
  }

  /**
   * Register a pending agent and create a short-lived link that opens the
   * PingRoom app. The person approving it chooses the delivery room and sees
   * the exact requested scopes. The pending credential stays private inside
   * this client and is replaced automatically once waitForPairing() succeeds.
   */
  async startPairing(params: StartPairingParams = {}): Promise<PairingStart> {
    const scopes = params.scopes ?? [...DEFAULT_PAIRING_SCOPES];
    const previousToken = this.http.getToken();
    const pending = await this.register({
      type: 'anonymous',
      scopes,
      ...(params.agent_label ? { agent_label: params.agent_label } : {}),
    });
    this.http.setToken(pending.credential);

    try {
      return await this.http.request('POST', '/api/agent/auth/pair/start', {
        body: { scopes },
      });
    } catch (error) {
      if (this.http.getToken() === pending.credential) {
        this.http.setToken(previousToken);
      }
      throw error;
    }
  }

  /** Read the current state of an app pairing using the pending credential. */
  pairingStatus(options: Pick<WaitForPairingOptions, 'signal'> = {}): Promise<PairingStatus> {
    return this.http.request('GET', '/api/agent/auth/pair/status', { signal: options.signal });
  }

  /**
   * Wait until the person approves in PingRoom, or the short-lived link
   * expires. Transient network, 429, and 5xx failures are retried inside the
   * server-provided lifetime. On success the client immediately starts using
   * the active credential returned by the server.
   */
  async waitForPairing(
    pairing: PairingStart,
    options: WaitForPairingOptions = {},
  ): Promise<PairedCredential> {
    const lifetimeMs = Math.max(1, Number(pairing.expires_in) || 900) * 1000;
    const requestedInterval = options.pollIntervalMs ?? pairing.poll_interval_ms;
    const intervalMs = Math.min(Math.max(Number(requestedInterval) || 1500, 1000), 10_000);
    const deadline = Date.now() + lifetimeMs;
    let transientFailures = 0;

    while (Date.now() < deadline) {
      this.throwIfPairingAborted(options.signal);

      try {
        const status = await this.pairingStatus({ signal: options.signal });
        this.throwIfPairingAborted(options.signal);
        transientFailures = 0;

        if (status.status === 'active') {
          if (
            typeof status.credential !== 'string'
            || status.credential.trim() === ''
            || status.credential_type !== 'active'
            || !Array.isArray(status.scopes)
            || status.scopes.some((scope) => typeof scope !== 'string' || scope.trim() === '')
            || (status.expires_in !== null
              && (typeof status.expires_in !== 'number'
                || !Number.isFinite(status.expires_in)
                || status.expires_in < 0))
            // A null/absent `room` is VALID: under `room_access: 'all'` the
            // human granted every room and pinned no single delivery room, so
            // the server sends `room: null`. Rejecting that threw away a good
            // credential on the most permissive grant. Only a room that is
            // PRESENT but malformed is a broken response.
            || (status.room != null
              && (typeof status.room.invite_code !== 'string'
                || status.room.invite_code.trim() === ''))
          ) {
            throw new PingRoomError('PingRoom returned an incomplete approved pairing.', {
              code: 'pairing_invalid_response',
              body: { status: status.status },
            });
          }
          this.http.setToken(status.credential);
          const { status: _status, ...credential } = status;
          return credential;
        }
        if (status.status === 'expired') {
          throw new PingRoomError('The PingRoom pairing link expired before it was approved.', {
            code: 'pairing_expired',
          });
        }
      } catch (error) {
        if (
          error instanceof PingRoomError
          && (error.code === 'network_error'
            || error.code === 'timeout'
            || error.status === 429
            || error.status >= 500)
        ) {
          transientFailures += 1;
          const backoffMs = Math.min(intervalMs * 2 ** Math.max(0, transientFailures - 3), 30_000);
          await sleep(Math.max(0, Math.min(backoffMs, deadline - Date.now())), options.signal);
          continue;
        }
        throw error;
      }

      await sleep(Math.max(0, Math.min(intervalMs, deadline - Date.now())), options.signal);
    }

    throw new PingRoomError('The PingRoom pairing link expired before it was approved.', {
      code: 'pairing_expired',
    });
  }

  private throwIfPairingAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('aborted');
    }
  }

  /** Rotate to a fresh credential (same scopes/handle). */
  refresh(): Promise<Credential> {
    return this.http.request('POST', '/api/agent/auth/refresh', { body: {} });
  }

  /** Revoke the current credential. */
  revoke(): Promise<void> {
    return this.http.request('POST', '/api/agent/auth/revoke', { body: {} });
  }
}

class RoomsApi {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<Room[]> {
    return this.http.request('GET', '/api/agent/rooms');
  }

  get(inviteCode: string): Promise<Room> {
    return this.http.request('GET', `/api/agent/rooms/${enc(inviteCode)}`);
  }

  create(input: CreateRoomInput): Promise<Room> {
    requireNonEmpty(input.name, 'name');
    return this.http.request('POST', '/api/agent/rooms', { body: dropUndefined({ ...input }) });
  }

  createPublic(input: CreatePublicRoomInput): Promise<Room> {
    requireNonEmpty(input.name, 'name');
    requireNonEmpty(input.handle, 'handle');
    return this.http.request('POST', '/api/agent/rooms/public', { body: dropUndefined({ ...input }) });
  }

  join(input: JoinRoomInput): Promise<Room> {
    requireNonEmpty(input.invite_code, 'invite_code');
    return this.http.request('POST', '/api/agent/rooms/join', { body: dropUndefined({ ...input }) });
  }
}

class ActionsApi {
  constructor(private readonly http: HttpClient) {}

  list(inviteCode: string): Promise<QuickAction[]> {
    return this.http.request('GET', `/api/agent/rooms/${enc(inviteCode)}/actions`);
  }

  update(inviteCode: string, actionNumber: number, input: UpdateQuickActionInput): Promise<QuickAction> {
    assertActionNumber(actionNumber);
    requireNonEmpty(input.label, 'label');
    requireNonEmpty(input.icon, 'icon');
    return this.http.request('PUT', `/api/agent/rooms/${enc(inviteCode)}/actions/${actionNumber}`, {
      body: dropUndefined({ ...input }),
    });
  }

  trigger(inviteCode: string, actionNumber: number, input: TriggerInput = {}): Promise<PingResult> {
    assertActionNumber(actionNumber);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/actions/${actionNumber}/trigger`, {
      body: dropUndefined({ ...input }),
    });
  }
}

class NotificationsApi {
  constructor(private readonly http: HttpClient) {}

  /** Paginated list (polling fallback). Prefer wait()/listen() for real-time. */
  list(input: ListNotificationsInput = {}): Promise<Paginated<AgentNotification>> {
    return this.http.request('GET', '/api/agent/notifications', { query: dropUndefined({ ...input }) });
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
    if (cursor === undefined) {
      const head = await this.wait({ timeout: 0, ...(input.signal ? { signal: input.signal } : {}) });
      cursor = head.cursor;
      for (const n of head.notifications) {
        yield n;
      }
    }
    const backoff = input.backoffMs ?? 1000;
    while (!input.signal?.aborted) {
      let result: WaitResult;
      try {
        result = await this.wait({
          after: cursor,
          ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (err) {
        if (input.signal?.aborted) {
          return;
        }
        if (input.onError) {
          input.onError(err);
          await sleep(backoff, input.signal);
          continue;
        }
        throw err;
      }
      cursor = result.cursor ?? cursor;
      for (const n of result.notifications) {
        yield n;
      }
    }
  }
}

class AgentsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * @deprecated Retired server-side — always fails with 410
   * `cross_account_ping_retired`. An agent can only reach the account that
   * connected it; to reach anyone else, post into a room you both belong to.
   */
  ping(handle: string, ping: PingInput): Promise<DirectPingResult> {
    requireNonEmpty(handle, 'handle');
    assertPing(ping);
    return this.http.request('POST', `/api/agent/agents/${enc(handle)}/ping`, { body: dropUndefined({ ...ping }) });
  }
}

class ApprovalsApi {
  constructor(private readonly http: HttpClient) {}

  /** Ask the human you act for to decide; returns the pending approval. */
  request(inviteCode: string, input: ApprovalInput): Promise<Approval> {
    requireNonEmpty(input.question, 'question');
    assertStructuredData(input.data);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/approvals`, {
      body: dropUndefined({ ...input }),
    });
  }

  get(approvalId: string): Promise<Approval> {
    return this.http.request('GET', `/api/agent/approvals/${enc(approvalId)}`);
  }

  /** One long-poll for the decision; returns the (possibly still-pending) approval. */
  wait(approvalId: string, input: WaitApprovalInput = {}): Promise<Approval> {
    return this.http.request('GET', `/api/agent/approvals/${enc(approvalId)}/wait`, {
      query: dropUndefined({ timeout: input.timeout }),
      timeoutMs: waitTimeoutMs(input.timeout),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /** Block until the human decides (or the request expires), looping wait() under the hood. */
  async waitForDecision(approvalId: string, input: { signal?: AbortSignal } = {}): Promise<Approval> {
    for (;;) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? new Error('aborted');
      }
      const approval = await this.wait(approvalId, input.signal ? { signal: input.signal } : {});
      if (approval.decided_at !== null || approval.status !== 'pending') {
        return approval;
      }
    }
  }
}

/**
 * The general human-in-the-loop primitive: ask a human a question with 2–4
 * options (or a short typed answer) and block until they tap an answer. An
 * {@link ApprovalsApi | approval} is the two-option case; reach for questions
 * when you need more choices, a typed reply, or room-scope answering.
 */
class QuestionsApi {
  constructor(private readonly http: HttpClient) {}

  /** Ask a Question in a room; returns the pending Question (id + computed expiry). */
  ask(inviteCode: string, input: QuestionInput): Promise<Question> {
    requireNonEmpty(input.prompt, 'prompt');
    assertStructuredData(input.data);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/questions`, {
      body: dropUndefined({ ...input }),
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
   * `answer.value` to branch.
   */
  async waitForAnswer(questionId: string, input: { signal?: AbortSignal } = {}): Promise<Question> {
    for (;;) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? new Error('aborted');
      }
      const question = await this.wait(questionId, input.signal ? { signal: input.signal } : {});
      if (question.state !== 'pending') {
        return question;
      }
    }
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
class HandoffsApi {
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
   */
  async waitForResult(id: string, input: WaitHandoffInput = {}): Promise<Handoff> {
    requireNonEmpty(id, 'id');
    for (;;) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? new Error('aborted');
      }
      const handoff = await this.wait(id, input);
      if (isHandoffTerminal(handoff)) {
        return handoff;
      }
    }
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
      ...(input.idempotencyKey ? { headers: { 'Idempotency-Key': input.idempotencyKey } } : {}),
    });
  }
}

/** Setup and activation of the bound human's Agent Inbox delivery room. */
class InboxApi {
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

      for (;;) {
        throwIfAborted(signal);
        const pollStartedAt = Date.now();
        const question = validateInboxWait(await this.http.request<unknown>(
          'GET',
          `/api/agent/handoffs/${enc(questionId)}/wait`,
          {
            query: dropUndefined({ timeout: input.timeout }),
            timeoutMs: waitTimeoutMs(input.timeout),
            signal,
          },
        ), questionId);
        throwIfAborted(signal);

        if (question.state === 'pending') {
          await sleep(
            Math.max(0, MIN_INBOX_ACTIVATION_POLL_INTERVAL_MS - (Date.now() - pollStartedAt)),
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

class ProfileApi {
  constructor(private readonly http: HttpClient) {}

  /** Set the agent's avatar (from the bot avatar set). */
  setAvatar(avatarId: string): Promise<unknown> {
    requireNonEmpty(avatarId, 'avatarId');
    return this.http.request('POST', '/api/agent/profile/avatar', { body: { avatar_id: avatarId } });
  }

  /** Rotate the agent's handle — the kill-switch for a leaked handle. */
  rotateHandle(): Promise<RotateHandleResult> {
    return this.http.request('POST', '/api/agent/profile/handle/rotate', { body: {} });
  }
}

/**
 * Live-status streams — a self-updating card on the room members' lock screen.
 *
 * Requires the `pingroom:live:write` scope. Free accounts get a small daily
 * budget of NEW streams; updates and the terminal ping are never charged, so a
 * card can never be quota-blocked into hanging open.
 */
class LiveApi {
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
   * Resolves null for a 404 ONLY — no stream with that correlation id in the
   * last 24 hours. Every other failure throws: in particular a 403
   * `room_not_granted` ({@link RoomScopedErrorCode}), raised when the room is
   * outside the grant the human gave this agent, propagates rather than being
   * reported as "no stream".
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
      if (error instanceof PingRoomError && error.status === 404) return null;
      throw error;
    }
  }
}

/**
 * Private files that a Ping or Question can carry.
 *
 * Upload first, then pass the returned ids to `broadcast()` / `questions.ask()`
 * as `attachment_ids`. Bytes never travel over MCP or a JSON ping body. An
 * upload that is never attached expires on its own after 24 hours.
 * Each file must be 1 byte–5 MiB with an md/pdf/html/txt/jpg/jpeg/png/zip filename;
 * a Ping or Question accepts at most four ids.
 *
 * Uploading requires the bound account to hold Pro (the API answers 402
 * `pro_required` otherwise). Reading and deleting are not gated.
 */
class AttachmentsApi {
  constructor(private readonly http: HttpClient) {}

  /** Upload one file and get back the id a send can claim. */
  upload(input: UploadAttachmentInput): Promise<Attachment> {
    requireNonEmpty(input.filename, 'filename');

    const body = new FormData();
    body.append('file', toAttachmentBlob(input), input.filename);

    return this.http
      .request<{ attachment: Attachment }>('POST', '/api/agent/attachments', {
        body,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      .then((res) => res.attachment);
  }

  /**
   * Raw bytes for an attachment this credential is allowed to see. Returns the
   * undecoded Response so a caller can stream it, or read text/arrayBuffer.
   */
  content(attachmentId: string, signal?: AbortSignal): Promise<Response> {
    requireNonEmpty(attachmentId, 'attachmentId');
    return this.http.raw('GET', `/api/agent/attachments/${enc(attachmentId)}/content`, {
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * The listing of a `.zip`'s contents, recorded when it was uploaded.
   *
   * Resolves null for a non-archive, and for an archive whose central
   * directory did not parse. Nothing decompresses the file to produce this, so
   * the declared sizes are what the archive claims, not verified output.
   */
  manifest(attachmentId: string, signal?: AbortSignal): Promise<ZipManifest | null> {
    requireNonEmpty(attachmentId, 'attachmentId');
    return this.http
      .request<{ manifest: ZipManifest | null }>(
        'GET',
        `/api/agent/attachments/${enc(attachmentId)}/manifest`,
        { ...(signal ? { signal } : {}) },
      )
      .then((res) => res.manifest ?? null);
  }

  /** Discard an upload that has not been attached to a ping yet. */
  delete(attachmentId: string): Promise<void> {
    requireNonEmpty(attachmentId, 'attachmentId');
    return this.http.request('DELETE', `/api/agent/attachments/${enc(attachmentId)}`);
  }
}

/** Normalise the three accepted content shapes into one multipart part. */
function toAttachmentBlob(input: UploadAttachmentInput): Blob {
  const type = input.contentType ?? '';
  if (input.content instanceof Blob) {
    return type ? new Blob([input.content], { type }) : input.content;
  }
  // Copy into a plain ArrayBuffer: a Uint8Array view may be a window onto a
  // larger (or SharedArrayBuffer-backed) buffer, which Blob would not accept.
  const parts: BlobPart[] =
    typeof input.content === 'string'
      ? [input.content]
      : [new Uint8Array(input.content).slice().buffer as ArrayBuffer];

  return new Blob(parts, type ? { type } : undefined);
}

/** Public, unauthenticated agent directory. */
class DirectoryApi {
  constructor(private readonly http: HttpClient) {}

  list(input: DirectoryListInput = {}): Promise<Paginated<DirectoryEntry>> {
    return this.http.request('GET', '/api/agents/directory', {
      auth: false,
      query: dropUndefined({ ...input }),
    });
  }

  get(handle: string): Promise<DirectoryProfile> {
    return this.http.request('GET', `/api/agents/directory/${enc(handle)}`, { auth: false });
  }
}

// --- main client ----------------------------------------------------------

export class PingRoom {
  readonly auth: AuthApi;
  readonly rooms: RoomsApi;
  readonly actions: ActionsApi;
  readonly notifications: NotificationsApi;
  readonly attachments: AttachmentsApi;
  readonly agents: AgentsApi;
  readonly approvals: ApprovalsApi;
  readonly questions: QuestionsApi;
  readonly handoffs: HandoffsApi;
  readonly inbox: InboxApi;
  readonly live: LiveApi;
  readonly profile: ProfileApi;
  readonly directory: DirectoryApi;
  readonly mcp: McpClient;

  private readonly http: HttpClient;

  constructor(options: PingRoomOptions = {}) {
    const baseUrl = options.baseUrl ?? envBaseUrl() ?? DEFAULT_BASE_URL;
    this.http = new HttpClient({
      baseUrl,
      token: options.token ?? null,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      ...(options.allowInsecure !== undefined ? { allowInsecure: options.allowInsecure } : {}),
    });

    this.auth = new AuthApi(this.http);
    this.rooms = new RoomsApi(this.http);
    this.actions = new ActionsApi(this.http);
    this.notifications = new NotificationsApi(this.http);
    this.attachments = new AttachmentsApi(this.http);
    this.agents = new AgentsApi(this.http);
    this.approvals = new ApprovalsApi(this.http);
    this.questions = new QuestionsApi(this.http);
    this.handoffs = new HandoffsApi(this.http);
    this.inbox = new InboxApi(this.http);
    this.live = new LiveApi(this.http);
    this.profile = new ProfileApi(this.http);
    this.directory = new DirectoryApi(this.http);
    this.mcp = new McpClient(this.http);
  }

  /** Update the credential (e.g. after auth.refresh()). Pass null to clear it. */
  setToken(token: string | null): void {
    this.http.setToken(token);
  }

  getToken(): string | null {
    return this.http.getToken();
  }

  /** Broadcast a ping to every member of a room you own. */
  broadcast(inviteCode: string, ping: PingInput): Promise<PingResult> {
    assertPing(ping);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/notifications`, {
      body: dropUndefined({ ...ping }),
    });
  }
}
