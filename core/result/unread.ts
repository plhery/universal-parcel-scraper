import type { CarrierResult } from './index.js';

/** At most this many fields are named, each a short path into the carrier's reply. */
export const MAX_UNREAD_ESTIMATES = 8;
export const UNREAD_ESTIMATE_FIELD = /^[A-Za-z][\w.[\]-]{0,99}$/;
// A .NET date or time left at its default, which some replies send for "none".
const DEFAULT_CLOCK = /^0001-01-01(?:[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/;

/** Whether a reply value says anything: not null, blank text, a default date, false, zero or an empty list or record. */
function filled(value: unknown, depth = 0): boolean {
  if (value == null || value === false) return false;
  if (typeof value === 'string') return !!value.trim() && !DEFAULT_CLOCK.test(value.trim());
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (depth > 3) return true;
  if (Array.isArray(value)) return value.some((item) => filled(item, depth + 1));
  if (typeof value === 'object') return Object.values(value).some((item) => filled(item, depth + 1));
  return true;
}

/**
 * The fields of a carrier's reply that can hold a delivery estimate or slot the adapter does
 * not read yet, named by their path in the reply, as `unread_estimates`: those this reply
 * fills. An adapter spreads it into its result, so a consumer can ask for a capture of the
 * reply and the adapter can learn the field's shape. A field the adapter reads, or tried to
 * and could, is no unread one: pass it as null.
 */
export function unreadEstimates(fields: Readonly<Record<string, unknown>>): Pick<CarrierResult, 'unread_estimates'> {
  const names = Object.entries(fields).filter(([name, value]) => UNREAD_ESTIMATE_FIELD.test(name) && filled(value))
    .map(([name]) => name).slice(0, MAX_UNREAD_ESTIMATES);
  return names.length ? { unread_estimates: names } : {};
}
