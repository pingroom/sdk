// `pr.auth`: registration, claim, app pairing and the credential lifecycle.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { sleep, throwIfAborted } from '../internal/async.js';
import { requireNonEmpty } from '../internal/guards.js';
import type {
  AgentConnectionInfo,
  AgentDisconnectResult,
  Credential,
  ClaimCompleteParams,
  ClaimStartParams,
  RegisterParams,
  PairingStart,
  PairingStatus,
  PairedCredential,
  StartPairingParams,
  WaitForPairingOptions,
} from '../types.js';
import { dropUndefined } from '../internal/request.js';
import { isRecord } from '../internal/validate.js';

/** Drop a malformed or unsafe server-provided URL without rejecting its response. */
function normalizePublicHttpUrl(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string' || candidate.trim() === '') return undefined;
  const trimmed = candidate.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username !== '' || url.password !== '') return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}

/** Drop malformed or unsafe server-provided links without rejecting a valid credential. */
function normalizePairingLinks(value: unknown): { latest_pings: string; install_app?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const latestPings = normalizePublicHttpUrl(value['latest_pings']);
  if (!latestPings) return undefined;
  const installApp = normalizePublicHttpUrl(value['install_app']);
  return {
    latest_pings: latestPings,
    ...(installApp ? { install_app: installApp } : {}),
  };
}

/**
 * The credential a pairing swapped in, and the one to hand back when it ends
 * without an approval. Held by `pair_token`, so a PairingStart that was only
 * copied or re-serialised still finds it.
 */
interface PendingPairing {
  pairToken: string;
  pending: string;
  previous: string | null;
}

/** Agent credential lifecycle (auth.md flow). */
export class AuthApi {
  private pairing: PendingPairing | null = null;

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
   * PingRoom app. The server owns the full grant shown to the approver; this
   * client sends no scope list. The pending credential stays private inside the
   * client and is replaced automatically once waitForPairing() succeeds. If the
   * client already held a credential, it is put back when the pairing expires
   * or the wait is aborted, so a re-pairing that never completes leaves the
   * client on the working credential rather than the dead pending one.
   */
  async startPairing(params: StartPairingParams = {}): Promise<PairingStart> {
    const previousToken = this.http.getToken();
    const pending = await this.register({
      type: 'anonymous',
      ...(params.agent_label ? { agent_label: params.agent_label } : {}),
    });
    this.http.setToken(pending.credential);

    try {
      const started = await this.http.request<PairingStart>('POST', '/api/agent/auth/pair/start', {
        body: {},
      });
      // A second pairing started while the first is still pending falls back
      // to the credential beneath it, not to the first pairing's pending one.
      this.pairing = {
        pairToken: started.pair_token,
        pending: pending.credential,
        previous: this.pairing !== null && this.pairing.pending === previousToken
          ? this.pairing.previous
          : previousToken,
      };
      return started;
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
   * the active credential returned by the server. When the link expires or the
   * wait is aborted, the credential the client held before startPairing() is
   * restored; calling waitForPairing() again after an abort resumes the same
   * pairing.
   */
  async waitForPairing(
    pairing: PairingStart,
    options: WaitForPairingOptions = {},
  ): Promise<PairedCredential> {
    const tracked = this.pairing !== null && this.pairing.pairToken === pairing.pair_token
      ? this.pairing
      : null;
    if (tracked !== null && this.http.getToken() === tracked.previous) {
      // Resuming after an abort put the earlier credential back.
      this.http.setToken(tracked.pending);
    }
    try {
      const paired = await this.pollPairing(pairing, options);
      if (tracked !== null && this.pairing === tracked) this.pairing = null;
      return paired;
    } catch (error) {
      if (tracked !== null && this.pairing === tracked) {
        const expired = error instanceof PingRoomError && error.code === 'pairing_expired';
        if (expired || options.signal?.aborted === true) {
          if (this.http.getToken() === tracked.pending) this.http.setToken(tracked.previous);
        }
        // An expired pairing cannot be resumed; an aborted one can.
        if (expired) this.pairing = null;
      }
      throw error;
    }
  }

  private async pollPairing(
    pairing: PairingStart,
    options: WaitForPairingOptions,
  ): Promise<PairedCredential> {
    const lifetimeMs = Math.max(1, Number(pairing.expires_in) || 900) * 1000;
    const requestedInterval = options.pollIntervalMs ?? pairing.poll_interval_ms;
    const intervalMs = Math.min(Math.max(Number(requestedInterval) || 1500, 1000), 10_000);
    const startedAt = Date.now();
    const deadline = startedAt + lifetimeMs;
    let transientFailures = 0;

    while (Date.now() < deadline) {
      throwIfAborted(options.signal);

      try {
        const status = await this.pairingStatus({ signal: options.signal });
        throwIfAborted(options.signal);
        transientFailures = 0;

        if (status.status === 'active') {
          if (
            typeof status.credential !== 'string'
            || status.credential.trim() === ''
            || status.credential_type !== 'active'
            || (status.expires_in !== null
              && (typeof status.expires_in !== 'number'
                || !Number.isFinite(status.expires_in)
                || status.expires_in < 0))
            // A null/absent `room` is valid when the account has no eligible
            // private delivery room (and on older servers). Only a room that is
            // present but malformed is a broken response.
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
          // Pairing is server-authoritative. Some servers still include their
          // internal grant marker for protocol compatibility; it is neither a
          // client input nor part of the paired credential surface.
          const { status: _status, scopes: _serverScopes, links: rawLinks, ...credential } = status;
          const links = normalizePairingLinks(rawLinks);
          return links ? { ...credential, links } : credential;
        }
        if (status.status === 'expired') {
          throw new PingRoomError('The PingRoom pairing link expired before it was approved.', {
            code: 'pairing_expired',
          });
        }
      } catch (error) {
        if (
          error instanceof PingRoomError
          && [401, 403, 404].includes(error.status)
          && Date.now() - startedAt >= lifetimeMs / 2
        ) {
          // The pending bearer can expire before the server returns an
          // explicit expired pairing state. Keep early auth failures intact.
          throw new PingRoomError('The PingRoom pairing link expired before it was approved.', {
            code: 'pairing_expired',
          });
        }
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

  /** Rotate to a fresh credential (same scopes/handle). */
  refresh(): Promise<Credential> {
    return this.http.request('POST', '/api/agent/auth/refresh', { body: {} });
  }

  /** Revoke the current credential. */
  revoke(): Promise<void> {
    return this.http.request('POST', '/api/agent/auth/revoke', { body: {} });
  }

  /**
   * What this credential is connected to: the robot, the owner's public id and
   * name, the home room and room memberships, and the room grant. Check
   * `owner.id` and `handle` against the account and robot you approved before
   * sending anything.
   */
  connection(): Promise<AgentConnectionInfo> {
    return this.http.request('GET', '/api/agent/connection');
  }

  /**
   * Disconnect this agent: revokes the calling credential and its refresh
   * credentials. The client keeps the now-revoked token; clear it with
   * `setToken(null)` or pair again.
   */
  disconnect(): Promise<AgentDisconnectResult> {
    return this.http.request('POST', '/api/agent/disconnect', { body: {} });
  }
}
