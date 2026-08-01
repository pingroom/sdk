/**
 * Live Activity template builders for the PingRoom agent SDK.
 *
 * IMPORTANT — these builders do NOT start an activity. The server starts,
 * updates, and ends Live Activities only from a **live-status stream**: a
 * `live_status` object sent either to a room's incoming webhook or to the agent
 * route (see https://pingroom.io/liveactivities.md). A `live_activity` block
 * placed in a `broadcast()` / `ping()` `data` object is carried as opaque
 * structured data — clients only honor the server-built, top-level
 * `live_activity` push block.
 *
 * These builders produce that `{ attributes, content_state }` block in the
 * frozen native shape (mobile/modules/live-activity/src/LiveActivity.types.ts,
 * LIVE_ACTIVITY_TEMPLATES.md). Use them when you need the native contract —
 * e.g. constructing expected payloads in tests or tooling that speaks the
 * push-layer shape.
 *
 * To actually drive a Live Activity, use `liveStatus.*` + `pr.live.push()`
 * (agent credential, `pingroom:live:write`) or `sendIncomingWebhook()`.
 */

export type LiveActivityTemplate =
  | 'status'
  | 'steps'
  | 'progress'
  | 'metrics'
  | 'countdown'
  | 'question'
  | 'matchup';

export type LiveActivityStatus =
  | 'open'
  | 'done'
  | 'failed'
  | 'acked'
  | 'answered'
  | 'expired'
  | 'cancelled';

export interface LiveActivityMetric {
  label: string;
  value: string;
}
export interface LiveActivityOption {
  value: string;
  label: string;
}
export interface LiveActivitySide {
  label: string;
  value: string;
  iconSvg?: string;
}

/** Identity fields common to every template (immutable for the activity's life). */
export interface LiveActivityIdentity {
  roomCode: string;
  roomName: string;
  /** Hex accent — the palette room color, or brand red `#e33122`. */
  roomColor: string;
  roomIconSvg?: string;
  /** Reuse across updates to target the same activity; also links agent replies. */
  correlationId?: string;
  agentId?: string;
  kind?: string;
}

/** Content fields shared across templates. */
interface CommonState {
  title: string;
  message?: string;
  status?: LiveActivityStatus;
  /** Semantic accent hex for this state only (e.g. deadline red). */
  accentOverride?: string;
}

/** The `data` fragment carrying a Live Activity. Spread into a ping's `data`. */
export interface LiveActivityData {
  live_activity: {
    attributes: Record<string, unknown>;
    content_state: Record<string, unknown>;
  };
}

function build(
  template: LiveActivityTemplate,
  id: LiveActivityIdentity,
  state: Record<string, unknown> & CommonState,
): LiveActivityData {
  const { title, message, status, accentOverride, ...rest } = state;
  return {
    live_activity: {
      attributes: {
        kind: id.kind ?? 'agent',
        template,
        roomCode: id.roomCode,
        roomName: id.roomName,
        roomColor: id.roomColor,
        ...(id.roomIconSvg ? { roomIconSvg: id.roomIconSvg } : {}),
        ...(id.correlationId ? { correlationId: id.correlationId } : {}),
        ...(id.agentId ? { agentId: id.agentId } : {}),
      },
      content_state: {
        status: status ?? 'open',
        title,
        message: message ?? '',
        ...(accentOverride ? { accentOverride } : {}),
        ...rest,
        updatedAt: Math.floor(Date.now() / 1000),
      },
    },
  };
}

export const liveActivity = {
  /** Single hero line + status dot; optional live ETA (`etaAt`, epoch seconds). */
  status(input: LiveActivityIdentity & CommonState & { progress?: number; etaAt?: number }) {
    const { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind, ...state } = input;
    return build('status', { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind }, state);
  },

  /** Checkpoint rail — the understand → plan → doc pattern. */
  steps(input: LiveActivityIdentity & CommonState & { steps: string[]; currentStep: number }) {
    const { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind, ...state } = input;
    return build('steps', { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind }, state);
  },

  /** Determinate progress bar (0..1), optional `etaAt` countdown. */
  progress(input: LiveActivityIdentity & CommonState & { progress: number; etaAt?: number }) {
    const { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind, ...state } = input;
    return build('progress', { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind }, state);
  },

  /** Up to 3 live counters. */
  metrics(input: LiveActivityIdentity & CommonState & { metrics: LiveActivityMetric[] }) {
    const { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind, ...state } = input;
    return build('metrics', { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind }, state);
  },

  /** Big timer counting down to `deadlineAt` (epoch seconds). */
  countdown(input: LiveActivityIdentity & CommonState & { deadlineAt: number }) {
    const { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind, ...state } = input;
    return build('countdown', { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind }, state);
  },

  /** Lock-screen ask: prompt + up to 4 options; `deadlineAt` shows time-left. */
  question(
    input: LiveActivityIdentity &
      CommonState & { prompt: string; options: LiveActivityOption[]; deadlineAt?: number },
  ) {
    const { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind, ...state } = input;
    return build('question', { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind }, state);
  },

  /** Head-to-head: left · center · right. */
  matchup(
    input: LiveActivityIdentity &
      CommonState & { left: LiveActivitySide; right: LiveActivitySide; center?: string },
  ) {
    const { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind, ...state } = input;
    return build('matchup', { roomCode, roomName, roomColor, roomIconSvg, correlationId, agentId, kind }, state);
  },
};
