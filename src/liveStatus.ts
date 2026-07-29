/**
 * Live-status streams — the wire contract for driving a Live Activity.
 *
 * A stream is keyed by `correlation_id`: the first ping starts a live card on
 * every room member's lock screen (one alert), further `running` pings move it
 * silently, and the first `done`/`failed` sends one completion alert and ends
 * it. See https://pingroom.io/liveactivities.md.
 *
 * Two producers speak this contract:
 *   - a room's **incoming webhook** (Pro) — `sendIncomingWebhook()`
 *   - an **agent credential** — `pr.live.*` (needs `pingroom:live:write`)
 *
 * Not to be confused with `liveActivity.*` in ./liveActivity.ts, which builds
 * the frozen *native* `{ attributes, content_state }` push shape for tests and
 * tooling. These builders produce the `live_status` object you actually send.
 */

import type { LiveActivityTemplate } from './liveActivity.js';

export type LiveStatusState = 'running' | 'done' | 'failed';

/** Legacy rendering category. Prefer `template`; `alert` selects urgent styling. */
export type LiveStatusCategory = 'status' | 'steps' | 'alert';

export interface LiveStatusMetric {
  label: string;
  value: string;
}

export interface LiveStatusOption {
  value: string;
  label: string;
}

export interface LiveStatusSide {
  label: string;
  value: string;
  iconSvg?: string;
}

/**
 * The `live_status` object. Only `state` is required; every other field is read
 * by the template you selected.
 *
 * `template` and `steps` are fixed at stream creation — a later ping cannot
 * re-template a running card. Content set at creation is sticky, so a sparse
 * update carrying just `progress` keeps rendering the full template.
 */
export interface LiveStatus {
  state: LiveStatusState;
  template?: LiveActivityTemplate;
  category?: LiveStatusCategory;
  message?: string;
  /** 0..1 — the progress bar / Dynamic Island gauge. */
  progress?: number;
  /** 2–8 labels. Required on the first ping of a `steps` stream; immutable after. */
  steps?: string[];
  /** Index into `steps`; the only mutable steps field. */
  current_step?: number;
  /** Up to 3 counters, for the `metrics` template. */
  metrics?: LiveStatusMetric[];
  /** Epoch seconds the `countdown` template counts down to. */
  deadline_at?: number;
  /** Epoch seconds; renders a live ETA on `status`/`progress`. */
  eta_at?: number;
  /** The ask, for the `question` template. */
  prompt?: string;
  /** Up to 4 choices, for the `question` template. */
  options?: LiveStatusOption[];
  left?: LiveStatusSide;
  right?: LiveStatusSide;
  center?: string;
  /** Hex `#rrggbb` — a semantic accent for one frame (e.g. deadline red). */
  accent_override?: string;
  agent_id?: string;
}

/** The full body of a live-status ping. */
export interface LiveStatusPing {
  correlation_id: string;
  live_status: LiveStatus;
  title?: string;
  /** Quick-action slot 1–4 supplying the icon and sound. */
  action?: number;
  data?: Record<string, unknown>;
  requires_ack?: boolean;
  ack_timeout_seconds?: number;
}

export interface LiveStatusResult {
  notification_id: string;
  correlation_id: string;
  /** `started` on creation, then `running` / `done` / `failed`. */
  state: string;
  idempotent: boolean;
  action_state?: unknown;
}

export interface LiveStatusSnapshot {
  notification_id: string;
  correlation_id: string;
  state: string | null;
  progress: number | null;
  message: string | null;
  template: LiveActivityTemplate | null;
  category: LiveStatusCategory | null;
  steps: string[] | null;
  current_step: number | null;
  updated_at: string | null;
}

type Rest = Omit<LiveStatusPing, 'correlation_id' | 'live_status'>;

const ping = (correlationId: string, live: LiveStatus, rest: Rest = {}): LiveStatusPing => ({
  correlation_id: correlationId,
  live_status: live,
  ...rest,
});

/**
 * Builders for the common stream shapes. Each returns a body you can hand to
 * `pr.live.push()` or `sendIncomingWebhook()`.
 */
export const liveStatus = {
  /** Default template: a title line plus a status dot, with optional progress. */
  status(correlationId: string, live: Omit<LiveStatus, 'template'>, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { template: 'status', ...live }, rest);
  },

  /** A segmented step tracker. `steps` is required on the first ping. */
  steps(correlationId: string, live: Omit<LiveStatus, 'template'>, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { template: 'steps', ...live }, rest);
  },

  /** A determinate progress bar with an optional live ETA. */
  progress(correlationId: string, live: Omit<LiveStatus, 'template'>, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { template: 'progress', ...live }, rest);
  },

  /** Up to 3 labelled counters. */
  metrics(correlationId: string, live: Omit<LiveStatus, 'template'>, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { template: 'metrics', ...live }, rest);
  },

  /** A large live timer counting down to `deadline_at`. */
  countdown(correlationId: string, live: Omit<LiveStatus, 'template'>, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { template: 'countdown', ...live }, rest);
  },

  /** A prompt with up to 4 options shown on the lock screen. */
  question(correlationId: string, live: Omit<LiveStatus, 'template'>, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { template: 'question', ...live }, rest);
  },

  /** Two sides plus a center score/clock. */
  matchup(correlationId: string, live: Omit<LiveStatus, 'template'>, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { template: 'matchup', ...live }, rest);
  },

  /** Finish a stream. The one alert your stream earns. */
  done(correlationId: string, message?: string, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { state: 'done', ...(message ? { message } : {}) }, rest);
  },

  /** Finish a stream unsuccessfully. */
  failed(correlationId: string, message?: string, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { state: 'failed', ...(message ? { message } : {}) }, rest);
  },
};
