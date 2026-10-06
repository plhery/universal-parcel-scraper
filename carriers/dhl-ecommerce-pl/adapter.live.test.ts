import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { adapter } from './adapter.js';

const instance = () => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });

describe('DHL eCommerce Poland live tracking', () => {
  it('identifies an absent parcel', async () => {
    await expect(instance().track({ number: '29999999990' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.DHL_ECOMMERCE_PL_TRACKING_NUMBER)('returns the identity-bound current status', async () => {
    const result = normalizeCarrierResult(await instance().track({ number: process.env.DHL_ECOMMERCE_PL_TRACKING_NUMBER! }));
    expect(result.current_stage).toBeDefined();
    expect(result.events).toHaveLength(1);
  });
});
