import { describe, expect, it } from 'vitest';
import { BfeExpressTracker } from './adapter.js';

describe('BFE Express live tracking', () => {
  it.skipIf(!process.env.BFE_EXPRESS_TRACKING_NUMBER)('returns identity-bound history', async () => {
    const result = await new BfeExpressTracker().fetch(process.env.BFE_EXPRESS_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.BFE_EXPRESS_UNKNOWN_NUMBER)('keeps a number BFE does not find inconclusive', async () => {
    await expect(new BfeExpressTracker().fetch(process.env.BFE_EXPRESS_UNKNOWN_NUMBER!))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});
