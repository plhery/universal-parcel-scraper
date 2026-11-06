import { describe, expect, it } from 'vitest';
import { CityAirExpressTracker } from './adapter.js';

describe('City Air Express guest history live', () => {
  it.skipIf(!process.env.CITY_AIR_EXPRESS_TRACKING_NUMBER)('reads the whole bound shipment history', async () => {
    const result = await new CityAirExpressTracker().fetch(process.env.CITY_AIR_EXPRESS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
  });
  it.skipIf(!process.env.CITY_AIR_EXPRESS_UNKNOWN_NUMBER)('keeps the explicit unknown separate', async () => {
    await expect(new CityAirExpressTracker().fetch(process.env.CITY_AIR_EXPRESS_UNKNOWN_NUMBER!))
      .rejects.toMatchObject({ kind: 'not_found' });
  });
});
