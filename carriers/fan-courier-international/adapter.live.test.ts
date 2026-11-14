import { describe, expect, it } from 'vitest';
import { FanCourierInternationalTracker } from './adapter.js';

describe('FAN Courier International live tracking', () => {
  it.skipIf(!process.env.FAN_COURIER_INTERNATIONAL_TRACKING_NUMBER)('returns identity-bound history', async () => {
    const result = await new FanCourierInternationalTracker().fetch(process.env.FAN_COURIER_INTERNATIONAL_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => typeof event.provider_code === 'string' && (event.time || event.local_time))).toBe(true);
  });

  it.skipIf(!process.env.FAN_COURIER_INTERNATIONAL_UNKNOWN_NUMBER)('reports an unknown number as not found', async () => {
    await expect(new FanCourierInternationalTracker().fetch(process.env.FAN_COURIER_INTERNATIONAL_UNKNOWN_NUMBER!))
      .rejects.toMatchObject({ kind: 'not_found' });
  });
});
