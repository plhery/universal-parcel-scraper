/** A carrier's delivery window, as a result's estimate fields carry it. */

export interface WindowEstimate {
  expected_delivery: string | null;
  expected_delivery_from?: string;
}

// A day, a wall-clock time on it, or an instant with its offset: "2026-11-04", "2026-11-04 08:00",
// "2026-11-04T08:00:00+01:00".
const MOMENT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?)?(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/;

interface Moment {
  day: string;
  clock: string | null;
  /** The instant as written, when it states its offset. */
  instant: string | null;
}

function moment(value: unknown): Moment | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = MOMENT.exec(text);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  const clock = match[4] ? `${match[4]}:${match[5]}` : null;
  return { day: text.slice(0, 10), clock, instant: clock && match[6] ? text : null };
}

/**
 * The estimate a window from `start` to `end` gives, each a day, a wall-clock time or an instant
 * with its offset. Within one day it is that day's slot ("2026-11-04 08:00–17:00"), or its two
 * instants when both state their offset. Across days it runs from `expected_delivery_from` to
 * `expected_delivery`, a wall-clock time by its day alone, since the app reads a bare date or an
 * instant there. One end alone, or a window that ends before it starts, gives that end's day and
 * no start.
 */
export function windowEstimate(start: unknown, end: unknown): WindowEstimate {
  const [first, last] = [moment(start), moment(end)];
  if (!first || !last) return { expected_delivery: (last ?? first)?.day ?? null };
  if (first.day === last.day) {
    if (!first.clock || !last.clock || first.clock > last.clock) return { expected_delivery: last.day };
    if (first.clock === last.clock) return { expected_delivery: last.instant ?? `${last.day} ${last.clock}` };
    if (first.instant && last.instant) return { expected_delivery_from: first.instant, expected_delivery: last.instant };
    return { expected_delivery: `${first.day} ${first.clock}–${last.clock}` };
  }
  if (first.day > last.day) return { expected_delivery: last.day };
  return { expected_delivery_from: first.instant ?? first.day, expected_delivery: last.instant ?? last.day };
}

/**
 * Whether `from` opens a window that `to` closes: both are days or times, or `to` a day's slot,
 * and `from` comes first.
 */
export function windowOpens(from: unknown, to: unknown): boolean {
  const end = typeof to === 'string' ? to.trim().replace(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})–\d{2}:\d{2}$/, '$1') : to;
  const [first, last] = [moment(from), moment(end)];
  if (!first || !last) return false;
  if (first.instant && last.instant) return Date.parse(first.instant) < Date.parse(last.instant);
  return `${first.day} ${first.clock ?? ''}` < `${last.day} ${last.clock ?? '99:99'}`;
}

/** A window across days written as one text, "2026-11-04 08:00–2026-11-06 18:00", read as its two ends. */
export function writtenWindow(text: unknown): WindowEstimate | null {
  const match = typeof text === 'string'
    ? /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?)\s*[–-]\s*(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?)$/.exec(text.trim())
    : null;
  return match ? windowEstimate(match[1], match[2]) : null;
}
