import { describe, expect, it } from 'vitest';
import { FxdcPostTracker } from './adapter.js';
describe('fxdc-post live retrieval', () => {
  it.skipIf(!process.env.FXDC_POST_TRACKING_NUMBER)('reads the verified guest scope', async () => {
    const result = await new FxdcPostTracker().fetch(process.env.FXDC_POST_TRACKING_NUMBER!);
    expect(result.summary_only).toBe(true); expect(result.events).toEqual([]);
  });
  it.skipIf(!process.env.FXDC_POST_UNKNOWN_NUMBER)('keeps its absence kind', async () => {
    await expect(new FxdcPostTracker().fetch(process.env.FXDC_POST_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
