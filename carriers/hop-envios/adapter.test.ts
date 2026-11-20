import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/archived.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.html', import.meta.url), 'utf8');

describe('HOP parcel tracking', () => {
  it('reads the matched shipment from the carrier page and keeps dated movements', () => {
    const result = parseTracking(found, '399999930408185');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update_local: '2024-09-19T14:54:15' });
    expect(result.events).toHaveLength(4);
    expect(result.events?.at(-1)).toMatchObject({ provider_code: 'PENP', stage: 'registered' });
  });

  it('validates the reference and treats only the explicit absence page as missing', () => {
    expect(() => parseTracking(missing, '399999939991791')).toThrow(NotFoundError);
    expect(() => parseTracking(missing, '399999930408185')).toThrow(/another code/i);
    expect(() => parseTracking(found.replace('399999930408185","trackings', '399999939991791","trackings'),
      '399999930408185')).toThrow(/another shipment/i);
  });
});
