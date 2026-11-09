import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { WesternBidTracker } from './adapter.js';

const ready = Boolean(process.env.FLARESOLVERR_URL && process.env.WESTERN_BID_TRACKING_NUMBER);
describe('Western Bid guest tracking', () => {
  it.skipIf(!ready)('reads dated reached milestones bound to the supplied reference', async () => {
    const tracker = new WesternBidTracker({ trawl: TrawlClient.fromEnvironment() });
    const first = await tracker.fetch(process.env.WESTERN_BID_TRACKING_NUMBER!);
    expect(first.events!.length).toBeGreaterThan(0);
    expect(first.history_truncated).toBe(true);
    expect(first.events!.every(event => event.description && event.local_time)).toBe(true);
  }, 150_000);

  it.skipIf(!process.env.FLARESOLVERR_URL || !process.env.WESTERN_BID_UNKNOWN_NUMBER)('keeps the verified missing-parcel response separate from browser failures', async () => {
    await expect(new WesternBidTracker({ trawl: TrawlClient.fromEnvironment() }).fetch(process.env.WESTERN_BID_UNKNOWN_NUMBER!))
      .rejects.toHaveProperty('kind', 'not_found');
  }, 75_000);
});
