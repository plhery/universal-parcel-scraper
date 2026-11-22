import { describe, expect, it } from 'vitest';
import { ZtoFreightTracker } from './adapter.js';

const positive = process.env.ZTO_FREIGHT_TRACKING_NUMBER;
const unknown = process.env.ZTO_FREIGHT_UNKNOWN_NUMBER;

describe('zto-freight live guest retrieval', () => {
  it.skipIf(!positive)('reads dated history for the whole waybill', async () => {
    const result = await new ZtoFreightTracker().fetch(positive!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time && event.description && event.provider_code)).toBe(true);
  }, 30_000);
  it.skipIf(!unknown)('reports an unknown waybill as not found', async () => {
    await expect(new ZtoFreightTracker().fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
