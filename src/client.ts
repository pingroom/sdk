import { HttpClient } from './http.js';
import { sleep } from './internal/async.js';
import { assertActionNumber, assertStructuredData, requireNonEmpty } from './internal/guards.js';
import { McpClient } from './mcp.js';
import type {
  AgentNotification,
  Approval,
  ApprovalInput,
  CreatePublicRoomInput,
  CreateRoomInput,
  Credential,
  ClaimCompleteParams,
  ClaimStartParams,
  DirectoryEntry,
  DirectoryListInput,
  DirectoryProfile,
  DirectPingResult,
  JoinRoomInput,
  ListNotificationsInput,
  ListenInput,
  Paginated,
  PingInput,
  PingResult,
  PingRoomOptions,
  QuickAction,
  RegisterParams,
  Room,
  RotateHandleResult,
  TriggerInput,
  UpdateQuickActionInput,
  WaitApprovalInput,
  WaitInput,
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
