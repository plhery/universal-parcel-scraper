import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { CostcoLogisticsTracker } from './adapter.js';

const number = process.env.COSTCO_LOGISTICS_TRACKING_NUMBER;
const unknown = process.env.COSTCO_LOGISTICS_UNKNOWN_NUMBER;
const configured = Boolean(process.env.FLARESOLVERR_URL);

describe('Costco Logistics public browser retrieval', () => {
  it.skipIf(!configured || !number)('reads the bound parcel and local scan clocks', async () => {
    const result = await new CostcoLogisticsTracker({ trawl: TrawlClient.fromEnvironment() }).fetch(number!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && event.local_time && !event.time && !event.location)).toBe(true);
    expect(result.last_update).toBeNull();
  }, 75_000);

  it.skipIf(!configured || !unknown)('reads the exact missing-parcel response', async () => {
    await expect(new CostcoLogisticsTracker({ trawl: TrawlClient.fromEnvironment() }).fetch(unknown!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});
