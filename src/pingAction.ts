/**
 * Buttons on a Ping — up to three, on the notification's long-press actions and
 * on the Ping's card in the app. They live under the reserved `data.actions`
 * key of an agent's `broadcast()` or an incoming webhook (`sendIncomingWebhook`):
 *
 *   const ping = await pr.broadcast('ab12cd', {
 *     message: 'Disk 91% on db-2',
 *     data: { actions: [
 *       pingAction.openUrl('Open dashboard', 'https://grafana.example.com/d/disk'),
 *       pingAction.webhook('Clean up now', 'https://ops.example.com/cleanup', {
 *         id: 'clean', style: 'danger', body: { host: 'db-2' },
 *       }),
 *     ] },
 *   });
 *   // Keep ping.action_signing_secret: every tap on "Clean up now" reaches
 *   // https://ops.example.com/cleanup signed with it (verifyWebhookSignature).
 *
 * - `open_url` opens an https page. The app shows its host under the label and
 *   opens it in the in-app browser; the URL never rides the push.
 * - `webhook` never makes the phone call your URL. A tap calls PingRoom, which
 *   POSTs a signed `notification.action` event to it (once per person, for
 *   24 hours). The URL and `body` are never shown to anyone. The room owner
 *   must be on Pro.
 *
 * Not in public or personal rooms, not with `requires_ack`, never on a
 * question, handoff, approval, live stream, replacement or quick-action press,
 * and a Ping with buttons cannot be replaced. Each builder checks its button
 * the way the server does and throws a `PingRoomError` (`invalid_data`) when the
 * server would refuse it.
 */

import { PingRoomError } from './errors.js';
import { normalizePingActions } from './internal/pingActions.js';
import type { PingActionInput, PingActionStyle } from './types/notifications.js';

export interface PingActionOptions {
  /** Your id for the button (`[a-z0-9_-]{1,24}`, unique on the Ping). Defaults to `a1`, `a2`, `a3` by position. */
  id?: string;
  /** `default`, `primary` or `danger` (a destructive-looking button). */
  style?: PingActionStyle;
}

export interface WebhookPingActionOptions extends PingActionOptions {
  /**
   * A JSON object (at most 10 keys, 1024 bytes) echoed back to your URL as
   * `body` on every tap. Never shown to recipients.
   */
  body?: Record<string, unknown>;
}

function build(input: PingActionInput): PingActionInput {
  const { actions, errors } = normalizePingActions([input]);
  const problems = Object.entries(errors);
  if (problems.length > 0 || actions.length !== 1) {
    throw new PingRoomError(
      `pingAction: ${problems.map(([field, message]) => `${field.replace(/^data\.actions\.0\.?/, '') || 'button'}: ${message}`).join(' ')}`,
      { code: 'invalid_data' },
    );
  }
  // The cleaned label is what every recipient sees.
  const cleaned = actions[0] as { label: string };
  return { ...input, label: cleaned.label };
}

function withOptions(base: PingActionInput, options: WebhookPingActionOptions): PingActionInput {
  const out: PingActionInput = { ...base };
  if (options.id !== undefined) out.id = options.id;
  if (options.style !== undefined) out.style = options.style;
  if (options.body !== undefined) out.body = options.body;
  return out;
}

export const pingAction = {
  /** A button that opens an https link. The app shows the link's host under the label. */
  openUrl(label: string, url: string, options: PingActionOptions = {}): PingActionInput {
    if ((options as WebhookPingActionOptions).body !== undefined) {
      throw new PingRoomError('pingAction.openUrl: only a webhook button takes a body.', { code: 'invalid_data' });
    }
    return build(withOptions({ label, type: 'open_url', url }, options));
  },

  /**
   * A button whose tap PingRoom delivers to your https URL as a signed
   * `notification.action` event. The URL takes no port.
   */
  webhook(label: string, url: string, options: WebhookPingActionOptions = {}): PingActionInput {
    return build(withOptions({ label, type: 'webhook', url }, options));
  },
} as const;
