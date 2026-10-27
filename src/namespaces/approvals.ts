// `pr.approvals`: two-option human-in-the-loop decisions.

import type { HttpClient } from '../http.js';
import { assertStructuredData, requireNonEmpty } from '../internal/guards.js';
import { pollUntilSettled } from '../internal/retry.js';
import type {
  Approval,
  ApprovalInput,
  WaitApprovalInput,
  WaitForOutcomeOptions,
} from '../types.js';
import {
  MIN_WAIT_POLL_INTERVAL_MS,
  enc,
  splitIdempotencyKey,
  assertOnRetry,
  dropUndefined,
  waitTimeoutMs,
} from '../internal/request.js';
import {
  isRecord,
  isNonEmptyString,
  isNullableString,
  sameId,
  invalidWaitResponse,
} from '../internal/validate.js';

const APPROVAL_STATUSES: ReadonlySet<string> = new Set(['pending', 'decided', 'expired', 'cancelled']);

/**
 * A wait response is trusted as an outcome only when it is the approval that
 * was asked about, in a known status. A captive portal's HTML, `{}`, or another
 * approval must not read as "decided".
 */
function validateApprovalWait(value: unknown, approvalId: string): Approval {
  const status = isRecord(value) ? value['status'] : undefined;
  if (
    !isRecord(value)
    || !sameId(value['id'], approvalId)
    || typeof status !== 'string'
    || !APPROVAL_STATUSES.has(status)
    || !isNullableString(value['decided_at'])
    // A gate acts on `decision`; a decided approval without one, or a pending
    // one already stamped decided, is not an outcome it can act on.
    || (status === 'decided' && !isNonEmptyString(value['decision']))
    || (status === 'pending' && value['decided_at'] !== null)
  ) {
    return invalidWaitResponse('approval', approvalId, value, 'status');
  }
  return value as unknown as Approval;
}

export class ApprovalsApi {
  constructor(private readonly http: HttpClient) {}

  /** Ask the human you act for to decide; returns the pending approval. */
  request(inviteCode: string, input: ApprovalInput): Promise<Approval> {
    requireNonEmpty(input.question, 'question');
    assertStructuredData(input.data);
    const { body, headers } = splitIdempotencyKey(input);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/approvals`, {
      body: dropUndefined({ ...body }),
      ...(headers ? { headers } : {}),
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

  /**
   * Block until the human decides (or the request expires or is cancelled),
   * looping wait() under the hood, with polls started at least 1 s apart. A
   * response that is not this approval in a known status rejects with
   * `invalid_response`. Network failures, 429 and 5xx are retried with backoff
   * (honouring `retryAfter`), and reported to `onRetry`, until `signal` aborts
   * or the outage outlasts the approval's `expires_at` by 5 minutes (15 minutes
   * of failures while no `expires_at` has been read); that rejects with
   * `unavailable`. See {@link WaitForOutcomeOptions}.
   */
  async waitForDecision(approvalId: string, input: WaitForOutcomeOptions = {}): Promise<Approval> {
    requireNonEmpty(approvalId, 'approvalId');
    assertOnRetry(input.onRetry);
    return pollUntilSettled({
      poll: () => this.wait(approvalId, input.signal ? { signal: input.signal } : {}),
      validate: (value) => validateApprovalWait(value, approvalId),
      settled: (approval) => approval.status !== 'pending',
      expiresAt: (approval) => approval.expires_at,
      what: `approval ${approvalId}`,
      minIntervalMs: MIN_WAIT_POLL_INTERVAL_MS,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onRetry ? { onRetry: input.onRetry } : {}),
    });
  }
}
