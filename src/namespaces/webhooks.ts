// `pr.webhooks`: a room's incoming webhooks.

import type { HttpClient } from '../http.js';
import { assertActionNumber, requireNonEmpty } from '../internal/guards.js';
import type { CreateWebhookInput, UpdateWebhookInput, Webhook } from '../types.js';
import { enc, dropUndefined } from '../internal/request.js';

export class WebhooksApi {
  constructor(private readonly http: HttpClient) {}

  async list(inviteCode: string): Promise<Webhook[]> {
    const result = await this.http.request<{ webhooks: Webhook[] }>(
      'GET', `/api/agent/rooms/${enc(inviteCode)}/webhooks`,
    );
    return result.webhooks;
  }

  create(inviteCode: string, input: CreateWebhookInput): Promise<Webhook> {
    requireNonEmpty(input.name, 'name');
    assertActionNumber(input.action_number);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/webhooks`, {
      body: dropUndefined({ ...input }),
    });
  }

  update(inviteCode: string, webhookId: string, input: UpdateWebhookInput): Promise<Webhook> {
    requireNonEmpty(webhookId, 'webhookId');
    assertActionNumber(input.action_number);
    return this.http.request('PUT', `/api/agent/rooms/${enc(inviteCode)}/webhooks/${enc(webhookId)}`, {
      body: dropUndefined({ ...input }),
    });
  }

  async delete(inviteCode: string, webhookId: string): Promise<void> {
    requireNonEmpty(webhookId, 'webhookId');
    await this.http.request('DELETE', `/api/agent/rooms/${enc(inviteCode)}/webhooks/${enc(webhookId)}`);
  }
}
