/**
 * A `Retry-After` header's wait. Internal to adapters, not a public export: whole seconds, or an
 * HTTP date when `dates` is not false. Absent, blank, unreadable and non-finite values read as
 * undefined, and a date already passed as 0.
 */
export interface RetryAfterOptions {
  /** Whether a value that is not whole seconds may be an HTTP date; true by default. */
  dates?: boolean;
  /** The most digits the seconds may have; a longer value reads as undefined, never as a date. */
  maxDigits?: number;
}

/** The wait `value` asks for, in milliseconds; anything but a string reads as absent. */
export function retryAfterMs(value: unknown, options: RetryAfterOptions = {}): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const wait = text.length > (options.maxDigits ?? Infinity) ? Number.NaN : Number(text) * 1_000;
    return Number.isFinite(wait) ? wait : undefined;
  }
  if (options.dates === false) return undefined;
  const wait = Date.parse(text) - Date.now();
  return Number.isFinite(wait) ? Math.max(0, wait) : undefined;
}

