import { describe, expect, it } from 'vitest';
import { AirspeedTracker } from './adapter.js';
describe('Airspeed cargo live retrieval', () => {
  it.skipIf(!process.env.AIRSPEED_TRACKING_NUMBER)('reads the bound cargo history', async () => {
    const result = await new AirspeedTracker().fetch(process.env.AIRSPEED_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0); expect(result.events!.every(event => event.local_time)).toBe(true);
  });
  it.skipIf(!process.env.AIRSPEED_UNKNOWN_NUMBER)('keeps the empty tracker inconclusive', async () => {
    await expect(new AirspeedTracker().fetch(process.env.AIRSPEED_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'expired_or_unknown' });
  });
});
