import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/outbound.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.html', import.meta.url), 'utf8');

describe('Post Aruba IPS history', () => {
  it('preserves scan order and office-local clocks across posts', () => {
    const result = parseTracking(found, 'RR927248745AW');
    expect(result).toMatchObject({ current_stage: 'customs', last_update_local: '2025-06-22T07:44:00' });
    expect(result.events).toHaveLength(7);
    expect(result.events?.at(-1)).toMatchObject({ stage: 'accepted', local_time: '2025-06-19T09:59:18' });
    expect(result.events?.[0]).toMatchObject({ location: 'ISC MIAMI FL (USPS), United States of America' });
  });

  it('respects the no-information notice and refuses a different item', () => {
    expect(() => parseTracking(missing, 'RR999999995AW')).toThrow(NotFoundError);
    expect(() => parseTracking(found, 'RR999999995AW')).toThrow(/another item/i);
    expect(() => parseTracking('<html></html>', 'RR999999995AW')).toThrow(/missing Post Aruba/i);
  });
});
