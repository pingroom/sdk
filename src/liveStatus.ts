/**
 * Live-status streams — the wire contract for driving a Live Activity.
 *
 * A stream is keyed by `correlation_id`: the first ping starts a live card on
 * every room member's lock screen (one alert), further `running` pings move it
 * silently, and the first `done`/`failed` sends one completion alert and ends
 * it. See https://pingroom.io/liveactivities.md.
 *
 * Three producers speak this contract. This SDK reaches the two machine ones:
 *   - a room's **incoming webhook** (Pro) — `sendIncomingWebhook()`
 *   - an **agent credential** — `pr.live.*` (needs `pingroom:live:write`)
 *
 * The third is a signed-in person driving a stream from the app composer over
 * `POST /api/rooms/{inviteCode}/live` with their own Human JWT. It sends this
 * same body minus `live_status.agent_id` (stripped server-side), so these
 * builders describe it too — but it is not an agent route and has no client
 * here.
 *
 * A **claim request** ("Who's on it?", template `claim`) is a stream one member
 * takes on. It starts like any stream, but it then moves only through
 * `pr.live.claim()` (claim, release, done, cancel), not through further
 * `live_status` legs. See https://pingroom.io/liveactivities.md.
 */

export type LiveActivityTemplate =
  | 'status'
  | 'steps'
  | 'progress'
  | 'metrics'
  | 'countdown'
  | 'question'
  | 'matchup'
  | 'claim';

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
 * re-template a running card, and a `running` ping whose `steps` list differs
 * from the stored one is rejected with 422 `steps_immutable` (an identical list,
 * or none, is fine; a `done`/`failed` ping ignores it and still ends). Content set at creation is sticky, so a sparse
 * update carrying just `progress` keeps rendering the full template. The
 * terminal leg is sticky too: `{ state: 'done' }` alone keeps the scoreboard,
 * metrics grid, deadline and accent on the final frame.
 */
export interface LiveStatus {
  state: LiveStatusState;
  template?: LiveActivityTemplate;
  category?: LiveStatusCategory;
  message?: string;
  /** 0..1 — the progress bar / Dynamic Island gauge. */
  progress?: number;
  /**
   * 2–8 labels. Required on the first ping of a `steps` stream; immutable after.
   * Later pings may resend the identical list or omit it; a different list on a
   * `running` ping is rejected with 422 `steps_immutable`, and a `done`/`failed`
   * ping ignores it. Use `current_step` to advance.
   */
  steps?: string[];
  /** Index into `steps`; the only mutable steps field. */
  current_step?: number;
  /** Up to 3 counters, for the `metrics` template. */
  metrics?: LiveStatusMetric[];
  /**
   * Epoch seconds the `countdown` template counts down to. A later ping may move
   * it: send the new absolute value, and the stored `duration_seconds` moves by
   * the same amount (a retried ping moves nothing twice).
   */
  deadline_at?: number;
  /**
   * `countdown` only: the timer's length in seconds. Read from the first ping
   * only (the server derives `deadline_at - now` when omitted); a later ping's
   * own value is ignored. It follows `deadline_at`: moving the deadline on a
   * later ping moves the stored duration by the same amount.
   */
  duration_seconds?: number;
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

/**
 * Where a "Who's on it?" request stands. `open` and `claimed` are live; the rest
 * are final. A request ends as `expired` when nobody took it by its deadline, or
 * when its claimer let go of it after that deadline.
 */
export type LiveClaimStatus = 'open' | 'claimed' | 'done' | 'cancelled' | 'expired' | 'unfinished';

/** What a member can do to a claim request. */
export type LiveClaimAction = 'claim' | 'release' | 'done' | 'cancel';

/** The stream `state` a claim status maps to: open and claimed are `running`, done is `done`, the rest are `failed`. */
export type LiveClaimStreamState = 'running' | 'done' | 'failed';

/** The person who holds a claim request, or who finished it. */
export interface LiveClaimParty {
  /** The user id (a UUID). */
  id: string;
  name: string;
  color?: string;
  emoji?: string;
  image_url?: string | null;
}

/** The server-owned `claim` block of a claim request. */
export interface LiveClaim {
  status: LiveClaimStatus;
  /** Who holds the request (or finished it); `null` while nobody does. */
  by: LiveClaimParty | null;
  /** Epoch seconds the holder took it; `null` while nobody holds it. */
  at: number | null;
  /** A claimed request is past its deadline. It stays live. */
  late: boolean;
  late_nudged_at?: number;
  realerted_at?: number;
  ended_by?: string;
  released_by?: string;
  /** The last claimer the asker was alerted about: a take alerts the asker once per claimer. */
  claimer_alerted_id?: string;
}

/**
 * The 200 body of `pr.live.claim()`. `idempotent` is true when the same person
 * repeated the action that already produced the current status, so nothing
 * changed and nothing was sent.
 *
 * Each action resolves with one `claim.status` / `state` pair: `claim` is
 * `claimed` / `running`, `done` is `done` / `done` and `cancel` is `cancelled` /
 * `failed`. `release` is `open` / `running`, or `expired` / `failed` when the
 * request was already past its deadline, so letting go ended it instead of
 * reopening it.
 */
export interface LiveClaimResult {
  notification_id: string;
  correlation_id: string;
  claim: LiveClaim;
  state: LiveClaimStreamState;
  idempotent: boolean;
}

/**
 * The body of a refused transition, on `PingRoomError.body`. `claim` and
 * `state` are the request as it now stands (on 409 and 422), so a client can
 * show who got it first. A 403 or 404 carries only `code` and `message`.
 */
export interface LiveClaimRefusal {
  code: string;
  message: string;
  claim?: LiveClaim;
  state?: LiveClaimStreamState;
}

/** The full body of a live-status ping. */
export interface LiveStatusPing {
  correlation_id: string;
  live_status: LiveStatus;
  title?: string;
  /** Quick-action slot 1–16 supplying the icon and sound. */
  action?: number;
  data?: Record<string, unknown>;
  /**
   * Up to 10 labels (each 1–32 characters of lowercase letters, digits, `-` and
   * `_`, starting with a letter or digit), set when the first ping creates the
   * stream. A later ping may repeat or omit them and never changes them.
   */
  tags?: string[];
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

/**
 * The read-back shape from `GET .../live/{correlationId}`.
 *
 * EVERY stored `live_status` field is returned, not a step/progress subset — a
 * `matchup` / `metrics` / `countdown` / `question` stream would otherwise be
 * unresumable after a producer restart. Fields you never set come back as
 * `null` rather than being omitted, so read them defensively.
 *
 * The server-side ownership stamps (`_webhook` / `_agent` / `_user`) are
 * deliberately NOT returned — they are the authorization record, not client
 * state.
 */
export interface LiveStatusSnapshot {
  notification_id: string;
  correlation_id: string;
  /** The tags the stream was created with, sorted; `[]` when none. */
  tags?: string[];
  state: string | null;
  progress: number | null;
  message: string | null;
  category: LiveStatusCategory | null;
  template: LiveActivityTemplate | null;
  agent_id: string | null;
  accent_override: string | null;
  eta_at: number | null;
  deadline_at: number | null;
  /** Countdown length in seconds, following any `deadline_at` move; `null` on every other template. */
  duration_seconds: number | null;
  metrics: LiveStatusMetric[] | null;
  prompt: string | null;
  options: LiveStatusOption[] | null;
  left: LiveStatusSide | null;
  right: LiveStatusSide | null;
  center: string | null;
  steps: string[] | null;
  current_step: number | null;
  action_state?: unknown;
  updated_at: string | null;
  /** `claim` template only: the request text. Absent on every other template. */
  title?: string;
  /** `claim` template only: where the request stands. Absent on every other template. */
  claim?: LiveClaim;
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

  /**
   * "Who's on it?": a request one room member takes on. Private standard rooms
   * only (`422 claim_private_rooms_only` elsewhere).
   *
   * Pass the request text as `rest.title` (1 to 120 characters; `live.message`
   * is used when there is no title). Send `state: 'running'` on the first ping.
   * `live.deadline_at` is optional, in the future and at most 8 hours away.
   * Anything else in `live` is ignored, including a `claim` block.
   *
   * After creation the request moves with `pr.live.claim()`. A producer
   * without a member identity (an incoming webhook) ends its own request with
   * `liveStatus.done()` (done) or `liveStatus.failed()` (cancelled).
   */
  claim(correlationId: string, live: Omit<LiveStatus, 'template'>, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { template: 'claim', ...live }, rest);
  },

  /**
   * An urgent stream, delivered time-sensitive from the start so it breaks
   * through Focus.
   *
   * This is a `category`, not a `template`: `alert` has no template equivalent,
   * and it is the only way to start a STREAM time-sensitive. Fixed at creation,
   * like `template`.
   *
   * (`requires_ack` is unrelated: it demands somebody tap, and since urgency and
   * acknowledgement were split it no longer raises the interruption level at
   * all. For a one-shot ping the delivery-priority flag is `is_urgent`.)
   */
  alert(correlationId: string, live: Omit<LiveStatus, 'template' | 'category'>, rest?: Rest): LiveStatusPing {
    return ping(correlationId, { category: 'alert', ...live }, rest);
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
