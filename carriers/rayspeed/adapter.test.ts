import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/collected.json', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.json', import.meta.url), 'utf8');

describe('RaySpeed Asia guest history', () => {
  it('checks the whole waybill and keeps the carrier’s day-only and timed scans', () => {
    const result = parseTracking(found, 'RAY8991695905349');
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2025-09-05T13:47:00' });
    expect(result.events).toHaveLength(9);
    expect(result.events?.[1]).toMatchObject({ local_time: '2025-09-05' });
    expect(result.events?.[1]?.stage).toBeUndefined();
  });

  it('requires the exact waybill even on the empty answer', () => {
    expect(() => parseTracking(missing, 'RAY8999999991379')).toThrow(NotFoundError);
    expect(() => parseTracking(missing, 'RAY8991695905349')).toThrow(/another waybill/i);
    expect(() => parseTracking(found.replace('"awb": "RAY8991695905349"', '"awb": "RAY8999999991379"'),
      'RAY8991695905349')).toThrow(/history includes another waybill/i);
  });
});
