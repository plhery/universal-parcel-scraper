import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('KEC eCommerce guest retrieval', () => {
  it.skipIf(!process.env.KEC_ECOMMERCE_TRACKING_NUMBER)('reads the requested parcel without providers or a browser', async () => {
    const result = await direct().track({ number: process.env.KEC_ECOMMERCE_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    for (const event of result.events!) expect(event.time).toMatch(/[+-]\d{2}:\d{2}$/);
  }, 25_000);

  it.skipIf(!process.env.KEC_ECOMMERCE_UNKNOWN_NUMBER)('keeps an unknown reference inconclusive', async () => {
    await expect(direct().track({ number: process.env.KEC_ECOMMERCE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 25_000);
});
