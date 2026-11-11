// Room metrics: named values a script keeps in a room for a widget to show.

/**
 * How a client shows a metric's value. `currency` takes an ISO 4217 `unit`
 * (`USD`), `unit` takes a short free-text `unit` (`ms`), the others take none.
 */
export type MetricFormat = 'number' | 'currency' | 'percent' | 'unit' | 'text';

/**
 * One metric as the API returns it. `value` is raw: a number for the numeric
 * formats, a string for `text`, `null` until a value is set. Clients format it
 * for the reader's locale. `value_updated_at` (ISO 8601) is null until a value is
 * set and moves only when the value does: a write of the stored value changes
 * nothing, so it is the truthful "last changed".
 */
export interface RoomMetric {
  key: string;
  label: string;
  format: MetricFormat;
  /** An ISO 4217 code for `currency`, free text for `unit`, `null` otherwise. */
  unit: string | null;
  value: number | string | null;
  value_updated_at: string | null;
}

/** What `metrics.list()` resolves with. */
export interface ListMetricsResult {
  /** Oldest first. */
  metrics: RoomMetric[];
  /** Metrics one room can hold. */
  limit: number;
}

/** The fields of `metrics.set()` and of an incoming webhook's `metric`, besides the key. */
export interface SetMetricInput {
  /**
   * The value, required. A finite number (absolute value at most 1e15, four
   * decimal places kept) for the number, currency, percent and unit formats, or a
   * string of at most 24 characters for `text`. A plain decimal string such as
   * `"12.5"` is also read as a number by a numeric metric.
   */
  value: number | string;
  /** Shown beside the value, at most 24 characters. A new metric's label defaults to its key. */
  label?: string;
  /**
   * A new metric's format defaults to `number` for a number and `text` for a
   * string; an existing metric keeps its own. Changing it clears a value that no
   * longer fits (a number cannot be text).
   */
  format?: MetricFormat;
  /**
   * `currency`: an ISO 4217 code (`USD`, uppercased for you). `unit`: 1–8
   * characters such as `ms`. Not allowed for the other formats.
   */
  unit?: string;
}
