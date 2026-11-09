import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { AeropostTracker } from './adapter.js';

describe('Aeropost native browser history', () => {
  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.AEROPOST_TRACKING_NUMBER)('reads dated shipper history', async () => {
    const result = await new AeropostTracker({ trawl: TrawlClient.fromEnvironment() }).fetch(process.env.AEROPOST_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time && event.description)).toBe(true);
  }, 60_000);
  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.AEROPOST_UNKNOWN_NUMBER)('keeps a bound missing result separate', async () => {
    await expect(new AeropostTracker({ trawl: TrawlClient.fromEnvironment() }).fetch(process.env.AEROPOST_UNKNOWN_NUMBER!))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
