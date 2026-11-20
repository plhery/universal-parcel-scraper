import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { facilityName, parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.html', import.meta.url), 'utf8');

describe('Airways Courier public waybill page', () => {
  it('binds the full reference and preserves the scan precisions', () => {
    const result = parseTracking(found, '222453221');
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-03-06T17:27:56' });
    expect(result.events).toHaveLength(7);
    expect(result.events?.[1]).toMatchObject({ local_time: '2026-03-06', stage: 'out_for_delivery' });
    expect(result.events?.[0]?.location).toBe('AIRWAYS-GURGAON');
    expect(facilityName('AIRWAYS-GURGAON-0124-1234567 / 1234567890')).toBe('AIRWAYS-GURGAON');
  });

  it('distinguishes explicit missing, mismatched and invalid results', () => {
    expect(() => parseTracking(missing, '999999993')).toThrow(NotFoundError);
    expect(() => parseTracking(found, '999999993')).toThrow(/another consignment/i);
    expect(() => parseTracking('<html></html>', '999999993')).toThrow(/missing airways courier tracking results/i);
  });
});
