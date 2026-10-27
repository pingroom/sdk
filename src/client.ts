import { HttpClient } from './http.js';
import { normalizeRedeemCode } from './internal/guards.js';
import { McpClient } from './mcp.js';
import type { PingInput, PingResult, PingRoomOptions, RedeemCodeResult } from './types.js';
import { enc, splitIdempotencyKey, dropUndefined, assertPing } from './internal/request.js';
import { AuthApi } from './namespaces/auth.js';
import { RoomsApi } from './namespaces/rooms.js';
import { ActionsApi } from './namespaces/actions.js';
import { WebhooksApi } from './namespaces/webhooks.js';
import { NotificationsApi } from './namespaces/notifications.js';
import { AttachmentsApi } from './namespaces/attachments.js';
import { AgentsApi } from './namespaces/agents.js';
import { ApprovalsApi } from './namespaces/approvals.js';
import { QuestionsApi } from './namespaces/questions.js';
import { HandoffsApi } from './namespaces/handoffs.js';
import { InboxApi } from './namespaces/inbox.js';
import { ProfileApi } from './namespaces/profile.js';
import { LiveApi } from './namespaces/live.js';
import { DirectoryApi } from './namespaces/directory.js';

const DEFAULT_BASE_URL = 'https://api.pingroom.io';
/** Node's util.inspect hook, named through the global registry so no import is needed. */
const INSPECT: unique symbol = Symbol.for('nodejs.util.inspect.custom');

function envBaseUrl(): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.['PINGROOM_API_URL'] || proc?.env?.['PINGROOM_BASE_URL'] || undefined;
}

// --- main client ----------------------------------------------------------

export class PingRoom {
  readonly auth: AuthApi;
  readonly rooms: RoomsApi;
  readonly webhooks: WebhooksApi;
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
    this.webhooks = new WebhooksApi(this.http);
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

  /** Redeem a gift or promotional code for this agent's authorizing human. */
  redeemCode(code: string): Promise<RedeemCodeResult> {
    return this.http.request('POST', '/api/agent/redeem-code', {
      body: { code: normalizeRedeemCode(code) },
    });
  }

  /**
   * Broadcast a ping to every member of a room you own. Pass `idempotencyKey`
   * and reuse it when retrying after a timeout or network error, so a send
   * the server already committed is replayed rather than delivered twice.
   */
  broadcast(inviteCode: string, ping: PingInput): Promise<PingResult> {
    assertPing(ping);
    const { body, headers } = splitIdempotencyKey(ping);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/notifications`, {
      body: dropUndefined({ ...body }),
      ...(headers ? { headers } : {}),
    });
  }

  /** What a logger or JSON.stringify() sees: the API origin, never the credential. */
  toJSON(): { baseUrl: string; token: '[redacted]' | null } {
    return this.http.toJSON();
  }

  [INSPECT](): string {
    const { baseUrl, token } = this.http.toJSON();
    return `PingRoom { baseUrl: ${JSON.stringify(baseUrl)}, token: ${token === null ? 'null' : token} }`;
  }
}
