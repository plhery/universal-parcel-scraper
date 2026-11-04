import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { DirectFreightTracker } from './adapter.js';

const tracker = () => new DirectFreightTracker({ trawl: process.env.FLARESOLVERR_URL ? new TrawlClient(process.env.FLARESOLVERR_URL) : null });

describe('Direct Freight live retrieval', () => {
  it.skipIf(!process.env.DIRECT_FREIGHT_TRACKING_NUMBER)('reads the matching consignment timeline', async () => {
    const result = await tracker().fetch(process.env.DIRECT_FREIGHT_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.description && event.local_time)).toBe(true);
  });
  it.skipIf(!process.env.DIRECT_FREIGHT_UNKNOWN_NUMBER)('keeps the portal miss distinct from browser verification', async () => {
    await expect(tracker().fetch(process.env.DIRECT_FREIGHT_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});
