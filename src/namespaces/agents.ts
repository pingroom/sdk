// `pr.agents`: the retired cross-account direct ping.

import type { HttpClient } from '../http.js';
import { requireNonEmpty } from '../internal/guards.js';
import type { DirectPingResult, PingInput } from '../types.js';
import { enc, splitIdempotencyKey, dropUndefined, assertPing } from '../internal/request.js';

export class AgentsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * @deprecated Retired server-side — always fails with 410
   * `cross_account_ping_retired`. An agent can only reach the account that
   * connected it; to reach anyone else, post into a room you both belong to.
   */
  ping(handle: string, ping: PingInput): Promise<DirectPingResult> {
    requireNonEmpty(handle, 'handle');
    assertPing(ping);
    const { body, headers } = splitIdempotencyKey(ping);
    return this.http.request('POST', `/api/agent/agents/${enc(handle)}/ping`, {
      body: dropUndefined({ ...body }),
      ...(headers ? { headers } : {}),
    });
  }
}
