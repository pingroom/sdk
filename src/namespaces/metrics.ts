// `pr.metrics`: room metrics, named values a script keeps in a room for a phone
// widget to show. Setting one sends no Ping and no push.

import type { HttpClient } from '../http.js';
import { assertMetricFields, normalizeMetricKey } from '../internal/metrics.js';
import { dropUndefined, enc } from '../internal/request.js';
import type { ListMetricsResult, RoomMetric, SetMetricInput } from '../types/metrics.js';

export class MetricsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * The room's metrics, oldest first, with the per-room limit. Needs the
   * `pingroom:metrics:read` scope; the agent's human only has to be a member.
   */
  list(inviteCode: string): Promise<ListMetricsResult> {
    return this.http.request('GET', `/api/agent/rooms/${enc(inviteCode)}/metrics`);
  }

  /**
   * Set a metric's value, creating the metric when the key is new (`PUT`, an
   * upsert). Needs the `pingroom:metrics:write` scope and a human who owns or
   * administers the room. A new metric's label defaults to its key and its format
   * to `number` or `text` by the value's type; a room holds at most 8
   * (`metrics_limit_reached`).
   *
   * Writing the value the metric already has changes nothing and keeps
   * `value_updated_at`, so a script may repeat itself freely. The key is trimmed
   * and lowercased; the value is raw, never pre-formatted (`12400`, not
   * `"$12,400"`).
   */
  set(inviteCode: string, key: string, input: SetMetricInput): Promise<RoomMetric> {
    const normalizedKey = normalizeMetricKey(key);
    assertMetricFields(input, { requireValue: true });
    return this.http.request('PUT', `/api/agent/rooms/${enc(inviteCode)}/metrics/${enc(normalizedKey)}`, {
      body: dropUndefined({ ...input }),
    });
  }

  /** Delete a metric. Rejects with `metric_not_found` when the room has no such key. */
  async delete(inviteCode: string, key: string): Promise<void> {
    const normalizedKey = normalizeMetricKey(key);
    await this.http.request('DELETE', `/api/agent/rooms/${enc(inviteCode)}/metrics/${enc(normalizedKey)}`);
  }
}
