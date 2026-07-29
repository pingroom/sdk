import { PingRoomError } from './errors.js';
import { HttpClient } from './http.js';
import { sleep } from './internal/async.js';
import { assertActionNumber, assertStructuredData, requireNonEmpty } from './internal/guards.js';
import type { LiveStatusPing, LiveStatusResult, LiveStatusSnapshot } from './liveStatus.js';
import { McpClient } from './mcp.js';
import type {
  AcknowledgementWaitResult,
  AgentInboxEnsureResult,
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
  Room,
  RequestAckInput,
  RotateHandleResult,
  TriggerInput,
  UpdateQuickActionInput,
  WaitApprovalInput,
  WaitHandoffInput,
  WaitForAcknowledgementInput,
  WaitInput,
  WaitQuestionInput,
  WaitResult,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.pingroom.io';
/** Extra wall-clock allowance over the server's hold window for long-poll calls. */
const LONG_POLL_BUFFER_MS = 10_000;
const DEFAULT_WAIT_SECONDS = 20;

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

  /** Direct agent-to-agent ping, addressed by the target's handle. */
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

/** One-call activation of the bound human's private Agent Inbox. */
class InboxApi {
  constructor(private readonly http: HttpClient) {}

  /** Idempotently create/resolve the inbox and deliver its one-time test Question. */
  ensure(): Promise<AgentInboxEnsureResult> {
    return this.http.request('POST', '/api/agent/inbox/ensure', { body: {} });
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
   * reconcile instead of opening a duplicate. Returns null when there is no
   * such stream in the last 24 hours.
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
