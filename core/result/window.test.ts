import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from './index.js';
import { windowEstimate, windowOpens, writtenWindow } from './window.js';

describe('a delivery window', () => {
  it('runs from its first day to its last across days', () => {
    expect(windowEstimate('2026-11-04', '2026-11-06')).toEqual({ expected_delivery_from: '2026-11-04', expected_delivery: '2026-11-06' });
    expect(windowEstimate('2026-11-04 08:00', '2026-11-06 18:00')).toEqual({ expected_delivery_from: '2026-11-04', expected_delivery: '2026-11-06' });
    expect(windowEstimate('2026-06-02T08:00:00+04:00', '2026-06-03T22:00:00+04:00'))
      .toEqual({ expected_delivery_from: '2026-06-02T08:00:00+04:00', expected_delivery: '2026-06-03T22:00:00+04:00' });
  });

  it('is a slot within one day, or its two instants when both state their offset', () => {
    expect(windowEstimate('2026-11-04 08:00', '2026-11-04T17:00:00')).toEqual({ expected_delivery: '2026-11-04 08:00–17:00' });
    expect(windowEstimate('2026-11-04T08:00Z', '2026-11-04T17:00Z')).toEqual({ expected_delivery_from: '2026-11-04T08:00Z', expected_delivery: '2026-11-04T17:00Z' });
    expect(windowEstimate('2026-11-04 10:00', '2026-11-04 10:00')).toEqual({ expected_delivery: '2026-11-04 10:00' });
    expect(windowEstimate('2026-11-04', '2026-11-04 17:00')).toEqual({ expected_delivery: '2026-11-04' });
  });

  it('gives a lone end, or the end of a window that closes before it opens, as its day', () => {
    expect(windowEstimate('2026-11-04 08:00', null)).toEqual({ expected_delivery: '2026-11-04' });
    expect(windowEstimate(undefined, '2026-11-06T18:00:00Z')).toEqual({ expected_delivery: '2026-11-06' });
    expect(windowEstimate('2026-11-06', '2026-11-04')).toEqual({ expected_delivery: '2026-11-04' });
    expect(windowEstimate('2026-11-04 17:00', '2026-11-04 08:00')).toEqual({ expected_delivery: '2026-11-04' });
    expect(windowEstimate('2026-02-30', 'soon')).toEqual({ expected_delivery: null });
  });

  it('opens when its start comes before its end', () => {
    expect(windowOpens('2026-11-04', '2026-11-06')).toBe(true);
    expect(windowOpens('2026-11-04', '2026-11-06 08:00–12:00')).toBe(true);
    expect(windowOpens('2026-11-04T08:00:00+01:00', '2026-11-04T08:30:00+02:00')).toBe(false);
    expect(windowOpens('2026-11-06', '2026-11-04')).toBe(false);
    expect(windowOpens('2026-11-04', null)).toBe(false);
  });

  it('written as one text across days gives its two ends', () => {
    expect(writtenWindow('2026-11-04 08:00–2026-11-06 18:00')).toEqual({ expected_delivery_from: '2026-11-04', expected_delivery: '2026-11-06' });
    expect(writtenWindow('2026-11-04 08:00–2026-11-04 18:00')).toEqual({ expected_delivery: '2026-11-04 08:00–18:00' });
    expect(writtenWindow('2026-11-04 08:00–18:00')).toBeNull();
  });
});

describe('a result estimate', () => {
  it('keeps a start that opens a window with the estimate and drops one alone or after it', () => {
    expect(normalizeCarrierResult({ expected_delivery_from: '2026-11-04', expected_delivery: '2026-11-06' }))
      .toMatchObject({ expected_delivery_from: '2026-11-04', expected_delivery: '2026-11-06' });
    expect(normalizeCarrierResult({ expected_delivery_from: '2026-11-04', expected_delivery: null })).not.toHaveProperty('expected_delivery_from');
    expect(normalizeCarrierResult({ expected_delivery_from: '2026-11-07', expected_delivery: '2026-11-06' })).not.toHaveProperty('expected_delivery_from');
  });

  it('reads a window across days written as one text as its two ends', () => {
    expect(normalizeCarrierResult({ expected_delivery: '2026-11-04 08:00–2026-11-06 18:00' }))
      .toMatchObject({ expected_delivery_from: '2026-11-04', expected_delivery: '2026-11-06' });
    expect(normalizeCarrierResult({ expected_delivery: '2026-11-04 08:00–12:00' })).toMatchObject({ expected_delivery: '2026-11-04 08:00–12:00' });
  });
});
