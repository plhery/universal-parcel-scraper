import type { CarrierEvent } from './index.js';

/** When a scan happened, as a number its answer's other scans compare with; null when it has no time. */
function scanInstant(event: CarrierEvent): number | null {
  for (const time of [event.time, event.local_time]) {
    const at = typeof time === 'string' && time ? Date.parse(time) : Number.NaN;
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/**
 * Whether an answer lists its newest scan first (true) or last (false), from its scans of
 * different instants; null when it dates every scan alike or lists them both ways as often.
 */
export function listsNewestFirst(events: CarrierEvent[]): boolean | null {
  let [later, earlier] = [0, 0];
  let previous: number | null = null;
  for (const at of events.map(scanInstant)) {
    if (at === null) continue;
    if (previous !== null && at !== previous) {
      if (at > previous) later += 1;
      else earlier += 1;
    }
    previous = at;
  }
  return later === earlier ? null : earlier > later;
}

/**
 * Numbers the scans an answer dates alike (`tie_order`), from the oldest, in the order the
 * answer lists them: a carrier lists two scans of one second in the order they happened, which
 * their times cannot tell. An adapter that sorts a carrier's scans keeps the order of those it
 * dates alike in the direction the carrier listed them; one that turns an oldest-first list
 * newest first reverses it rather than sorting it.
 */
export function withTieOrder(events: CarrierEvent[]): void {
  for (const event of events) delete event.tie_order;
  const newestFirst = listsNewestFirst(events);
  if (newestFirst === null) return;
  const ties = new Map<number, CarrierEvent[]>();
  for (const event of events) {
    const at = scanInstant(event);
    if (at !== null) ties.set(at, [...ties.get(at) ?? [], event]);
  }
  for (const tie of ties.values()) {
    if (tie.length < 2) continue;
    for (const [order, event] of (newestFirst ? [...tie].reverse() : tie).entries()) event.tie_order = order;
  }
}
