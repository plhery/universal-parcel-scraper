import { describe, expect, it } from 'vitest';
import { GfsExpressTracker } from './adapter.js';

describe('GFS Express live tracking', () => {
  it.skipIf(!process.env.GFS_EXPRESS_TRACKING_NUMBER)('returns identity-bound history', async () => {
    const result = await new GfsExpressTracker().fetch(process.env.GFS_EXPRESS_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
  });

  it.skipIf(!process.env.GFS_EXPRESS_UNKNOWN_NUMBER)('keeps a number GFS does not hold inconclusive', async () => {
    await expect(new GfsExpressTracker().fetch(process.env.GFS_EXPRESS_UNKNOWN_NUMBER!))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});
