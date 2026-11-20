import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryAfterMs } from './retryAfter.js';

afterEach(() => vi.useRealTimers());

describe('retryAfterMs', () => {
  it('reads whole seconds', () => {
    expect(retryAfterMs('0')).toBe(0);
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(' 7 ')).toBe(7_000);
  });

  it('reads an HTTP date as the time left, and a date passed as 0', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T14:00:00Z'));
    expect(retryAfterMs('Mon, 07 Sep 2026 14:00:30 GMT')).toBe(30_000);
    expect(retryAfterMs('Mon, 07 Sep 2026 13:00:00 GMT')).toBe(0);
  });

  it('reads absent, blank, garbage and non-finite values as undefined', () => {
    for (const value of [undefined, null, 30, {}, '', '  ', 'soon', '9'.repeat(400)]) expect(retryAfterMs(value)).toBeUndefined();
  });

  it('reads negative and fractional seconds as dates or nothing, never as seconds', () => {
    expect(retryAfterMs('-5', { dates: false })).toBeUndefined();
    expect(retryAfterMs('1.5', { dates: false })).toBeUndefined();
  });

  it('reads seconds only without dates', () => {
    expect(retryAfterMs('Mon, 07 Sep 2026 14:00:30 GMT', { dates: false })).toBeUndefined();
    expect(retryAfterMs('42', { dates: false })).toBe(42_000);
  });

  it('caps the digits seconds may have', () => {
    expect(retryAfterMs('999999', { dates: false, maxDigits: 6 })).toBe(999_999_000);
    expect(retryAfterMs('1000000', { dates: false, maxDigits: 6 })).toBeUndefined();
    expect(retryAfterMs('0000005', { dates: false, maxDigits: 6 })).toBeUndefined();
    expect(retryAfterMs('1000000', { maxDigits: 6 })).toBeUndefined();
  });
});
