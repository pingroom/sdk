// `pr.actions`: a room's quick-action slots, pages and presses.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { assertActionNumber, requireNonEmpty, requirePresentString } from '../internal/guards.js';
import { linkPing } from '../linkPing.js';
import { locationPing } from '../locationPing.js';
import type {
  PingResult,
  QuickAction,
  TriggerInput,
  QuickActionInput,
  UpdateQuickActionInput,
  UpdateQuickActionLayoutInput,
} from '../types.js';
import { enc, splitIdempotencyKey, dropUndefined } from '../internal/request.js';

const MAX_TRIGGER_ATTACHMENTS = 4;
const QUICK_ACTION_PAGE_SIZE = 4;
const MAX_QUICK_ACTION_PAGES = 4;

/**
 * The per-slot checks shared by `updateMany()` and `updateLayout()`: a valid,
 * present, unique action_number and an icon whenever the slot has a label.
 * Two entries for one slot would let the last silently win, and the caller
 * would never learn which of its definitions was stored.
 */
function assertActionSlots(actions: QuickActionInput[]): void {
  const seen = new Set<number>();
  for (const action of actions) {
    assertActionNumber(action.action_number);
    if (action.action_number === undefined || action.action_number === null) {
      throw new PingRoomError('`action_number` is required for each action.', { code: 'invalid_request' });
    }
    if (seen.has(action.action_number)) {
      throw new PingRoomError(`Duplicate action_number ${action.action_number}.`, { code: 'invalid_request' });
    }
    seen.add(action.action_number);
    assertQuickActionIcon(action);
  }
}

/**
 * Mirrors the server's `icon` rule (`present`, `required_with:label`): the emoji
 * is the half that must be there unless BOTH are empty, which reserves the
 * slot as disabled.
 */
function assertQuickActionIcon(action: { label: unknown; icon: unknown }): void {
  requirePresentString(action.label, 'label');
  requirePresentString(action.icon, 'icon');
  if ((action.icon as string).trim() === '' && (action.label as string).trim() !== '') {
    throw new PingRoomError('`icon` is required when `label` is set; send both empty to disable the slot.', {
      code: 'invalid_request',
    });
  }
}

function assertTriggerInput(input: TriggerInput): void {
  const data = input.data;
  if (data !== undefined) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new PingRoomError('`data` must be an object with `location` and/or `url`.', { code: 'invalid_request' });
    }
    for (const key of Object.keys(data)) {
      if (key !== 'location' && key !== 'url') {
        throw new PingRoomError(`\`data.${key}\` is not accepted on a quick-action press; only location and url are.`, {
          code: 'invalid_request',
        });
      }
    }
    try {
      if (data.location !== undefined) locationPing(data.location);
      if (data.url !== undefined) linkPing({ url: data.url });
    } catch (error) {
      throw new PingRoomError((error as Error).message, { code: 'invalid_request' });
    }
  }
  if (input.attachment_ids !== undefined) {
    if (!Array.isArray(input.attachment_ids) || input.attachment_ids.length > MAX_TRIGGER_ATTACHMENTS) {
      throw new PingRoomError(`\`attachment_ids\` accepts at most ${MAX_TRIGGER_ATTACHMENTS} ids.`, { code: 'invalid_request' });
    }
    for (const id of input.attachment_ids) requireNonEmpty(id, 'attachment_ids[]');
  }
}

export class ActionsApi {
  constructor(private readonly http: HttpClient) {}

  list(inviteCode: string): Promise<QuickAction[]> {
    return this.http.request('GET', `/api/agent/rooms/${enc(inviteCode)}/actions`);
  }

  update(inviteCode: string, actionNumber: number, input: UpdateQuickActionInput): Promise<QuickAction> {
    assertActionNumber(actionNumber);
    // A Ping's title is optional — its emoji can be the whole name — so an
    // empty `label` is a valid update. `icon` is the half that must be there,
    // unless both are empty: that reserves the slot as disabled.
    assertQuickActionIcon(input);
    return this.http.request('PUT', `/api/agent/rooms/${enc(inviteCode)}/actions/${actionNumber}`, {
      body: dropUndefined({ ...input }),
    });
  }

  /**
   * Write up to 16 action slots in one request. The server enforces the room owner's plan.
   * Add new pages in complete groups of four; existing slots may be edited individually.
   *
   * Prefer this over looping `update()`. Each single-slot write enqueues its
   * own silent rooms-refresh push, so configuring a room's four Pings one at a
   * time wakes room members' devices four times inside a few seconds — four of a
   * finite daily background-push budget spent on one logical operation.
   *
   * Partial and additive: slots absent from `actions` keep their current
   * configuration, so this is also the right call for editing a single Ping.
   * Nothing here deletes an action, and an empty array is rejected locally
   * rather than being sent as a clear. Resolves to the room's full ordered
   * action set, not just the slots written.
   */
  updateMany(inviteCode: string, actions: QuickActionInput[]): Promise<QuickAction[]> {
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new PingRoomError('`actions` must contain at least one action.', { code: 'invalid_request' });
    }
    if (actions.length > 16) {
      throw new PingRoomError('A batch may contain at most 16 action slots.', { code: 'invalid_request' });
    }

    assertActionSlots(actions);

    return this.http.request('PUT', `/api/agent/rooms/${enc(inviteCode)}/actions`, {
      body: { actions: actions.map((action) => dropUndefined({ ...action })) },
    });
  }

  /**
   * Press a slot. When the action has an `input_type`, pass the matching
   * detail (`data.location`, `data.url`, or `attachment_ids`) or the server
   * refuses the press with `422 quick_action_input_required` and sends nothing.
   * Read `input_type` from `list()` first; pass the action's `id` as
   * `quick_action_id` to be refused rather than fire the wrong Ping if the
   * owner moved pages meanwhile.
   */
  trigger(inviteCode: string, actionNumber: number, input: TriggerInput = {}): Promise<PingResult> {
    assertActionNumber(actionNumber);
    assertTriggerInput(input);
    const { body, headers } = splitIdempotencyKey(input);
    return this.http.request('POST', `/api/agent/rooms/${enc(inviteCode)}/actions/${actionNumber}/trigger`, {
      body: dropUndefined({ ...body }),
      ...(headers ? { headers } : {}),
    });
  }

  /**
   * Replace the room's page layout atomically (room owner on Pro only). See
   * `UpdateQuickActionLayoutInput` for the snapshot contract; a stale
   * `base_action_ids` is `409 quick_action_layout_changed`, a page still used
   * by a time trigger, webhook, agent binding or running live update is
   * `409 quick_action_page_in_use`. Prefer `deletePage()`, which builds the
   * body from a fresh read.
   */
  updateLayout(inviteCode: string, input: UpdateQuickActionLayoutInput): Promise<QuickAction[]> {
    if (!Array.isArray(input.base_action_ids)) {
      throw new PingRoomError('`base_action_ids` must be an array of action ids (may be empty).', { code: 'invalid_request' });
    }
    if (!Array.isArray(input.page_order) || input.page_order.length < 1 || input.page_order.length > MAX_QUICK_ACTION_PAGES) {
      throw new PingRoomError(`\`page_order\` must list 1–${MAX_QUICK_ACTION_PAGES} pages.`, { code: 'invalid_request' });
    }
    for (const page of input.page_order) {
      if (page !== null && (!Number.isInteger(page) || page < 1 || page > MAX_QUICK_ACTION_PAGES)) {
        throw new PingRoomError('`page_order` entries must be an original page number 1–4 or null for a blank page.', {
          code: 'invalid_request',
        });
      }
    }
    const expected = input.page_order.length * QUICK_ACTION_PAGE_SIZE;
    if (!Array.isArray(input.actions) || input.actions.length !== expected) {
      throw new PingRoomError(`\`actions\` must hold exactly ${expected} slots for ${input.page_order.length} page(s).`, {
        code: 'invalid_request',
      });
    }
    assertActionSlots(input.actions);
    return this.http.request('PUT', `/api/agent/rooms/${enc(inviteCode)}/actions/layout`, {
      body: {
        base_action_ids: input.base_action_ids,
        page_order: input.page_order,
        actions: input.actions.map((action) => dropUndefined({ ...action })),
      },
    });
  }

  /**
   * Delete one page (1–4) and shift the later pages left, keeping every other
   * slot's configuration. Reads the current action set first so the layout
   * snapshot is real, then calls `updateLayout()`. Page 1 can be deleted only
   * when another page remains.
   */
  async deletePage(inviteCode: string, page: number): Promise<QuickAction[]> {
    if (!Number.isInteger(page) || page < 1 || page > MAX_QUICK_ACTION_PAGES) {
      throw new PingRoomError('`page` must be an integer 1–4.', { code: 'invalid_request' });
    }
    const current = await this.list(inviteCode);
    const stored = [...current].sort((a, b) => a.action_number - b.action_number);
    const pageCount = Math.max(1, Math.ceil((stored.at(-1)?.action_number ?? 0) / QUICK_ACTION_PAGE_SIZE));
    if (page > pageCount) {
      throw new PingRoomError(`The room has ${pageCount} page(s); page ${page} does not exist.`, { code: 'invalid_request' });
    }
    if (pageCount === 1) {
      throw new PingRoomError('A room keeps at least one page; configure its slots instead of deleting it.', {
        code: 'invalid_request',
      });
    }
    const keep = Array.from({ length: pageCount }, (_, i) => i + 1).filter((p) => p !== page);
    const byNumber = new Map(stored.map((a) => [a.action_number, a]));
    const actions: QuickActionInput[] = [];
    keep.forEach((originalPage, index) => {
      for (let offset = 1; offset <= QUICK_ACTION_PAGE_SIZE; offset++) {
        const source = byNumber.get((originalPage - 1) * QUICK_ACTION_PAGE_SIZE + offset);
        actions.push({
          action_number: index * QUICK_ACTION_PAGE_SIZE + offset,
          label: source?.label ?? '',
          icon: source?.icon ?? '',
          ...(source?.sound !== undefined ? { sound: source.sound } : {}),
          ...(source?.haptic_style !== undefined ? { haptic_style: source.haptic_style } : {}),
          ...(source?.requires_ack !== undefined ? { requires_ack: source.requires_ack } : {}),
          ...(source?.input_type !== undefined ? { input_type: source.input_type } : {}),
        });
      }
    });
    return this.updateLayout(inviteCode, {
      base_action_ids: stored.map((a) => a.id).filter((id): id is string => typeof id === 'string'),
      page_order: keep,
      actions,
    });
  }
}
