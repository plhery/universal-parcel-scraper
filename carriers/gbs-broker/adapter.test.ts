import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/clearance.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.html', import.meta.url), 'utf8');

describe('GBS customs tracking', () => {
  it('keeps the source offsets and distinguishes customs from release', () => {
    const result = parseTracking(found, 'RLAI00887529');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: '2026-06-23T14:26:00+03:00' });
    expect(result.events).toHaveLength(7);
    expect(result.events?.[2]?.stage).toBe('customs');
    expect(result.events?.[3]?.stage).toBeUndefined();
  });

  it('checks the full reference on found and missing results', () => {
    expect(() => parseTracking(missing, 'RLAI99999999')).toThrow(NotFoundError);
    expect(() => parseTracking(found, 'RLAI99999999')).toThrow(/matching consignment/i);
    expect(() => parseTracking(missing, 'RLAI00887529')).toThrow(/matching consignment/i);
  });
});
