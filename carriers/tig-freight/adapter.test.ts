import { describe, expect, it } from 'vitest';
import { IndeterminateError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import { parseTracking } from './parser.js';
import delivered from './fixtures/synthetic-delivered.json' with { type: 'json' };
import missing from './fixtures/missing.json' with { type: 'json' };

describe('TIG Freight Open360 tracking', () => {
  it('reads scan details in page order and preserves clocks as supplied', () => {
    const result = parseTracking(delivered, 'TIGTEST0000');
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2020-01-04T12:15:00+11:00' });
    expect(result.events?.[1]).toMatchObject({
      local_time: '2020-01-04T09:12:00.000', location: 'Melbourne', stage: 'out_for_delivery',
    });
  });

  it('distinguishes an unknown reference from another shipment or a query failure', () => {
    expect(() => parseTracking(missing, 'TIGZZZ0000')).toThrow(NotFoundError);
    expect(() => parseTracking(delivered, 'TIGZZZ0000')).toThrow(IndeterminateError);
    expect(() => parseTracking({ errors: [{ code: 'RATE_LIMITED' }] }, 'TIGZZZ0000')).toThrow(RateLimitedError);
    expect(() => parseTracking({ data: null }, 'TIGZZZ0000')).toThrow(SchemaError);
  });
});
