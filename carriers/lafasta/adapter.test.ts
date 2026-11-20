import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.html', import.meta.url), 'utf8');

describe('Lafasta tracking history', () => {
  it('anchors the scan years to the shipment date and requires the whole number', () => {
    const result = parseTracking(found, '99771679');
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2021-08-05T19:56:00' });
    expect(result.events).toHaveLength(6);
    expect(result.events?.[0]?.location).toBe('بريدة');
    expect(() => parseTracking(found, '83561427')).toThrow(/another shipment/i);
    expect(() => parseTracking(missing, '83561427')).toThrow(NotFoundError);
  });

  it('continues into the next year when the month wraps', () => {
    const holiday = found.replaceAll('Aug, 03', 'Dec, 31').replaceAll('Aug, 04', 'Jan, 01')
      .replaceAll('Aug, 05', 'Jan, 02').replace('2021-08-03', '2021-12-31');
    expect(parseTracking(holiday, '99771679').last_update_local).toBe('2022-01-02T19:56:00');
  });
});
