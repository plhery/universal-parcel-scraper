import { describe, expect, it } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { DpdUkTracker } from './adapter.js';

const number = process.env.DPD_UK_TRACKING_NUMBER;

describe('DPD UK live direct retrieval', () => {
  it.skipIf(!number)('retrieves public history without a postcode', async () => {
    const result = await new DpdUkTracker().fetch(number!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.DPD_UK_UNKNOWN_NUMBER)('distinguishes an explicit unknown reference', async () => {
    await expect(new DpdUkTracker().fetch(process.env.DPD_UK_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
  it.runIf(Boolean(process.env.FLARESOLVERR_URL && number))('reads the public page through bound TRAWL capture when the API refuses', async () => {
    const result = await new DpdUkTracker({ trawl: TrawlClient.fromEnvironment(),
      fetcher: (target, init) => new URL(String(target)).hostname === 'apis.track.dpd.co.uk'
        ? Promise.resolve(new Response('', { status: 403 })) : fetch(target, init) })
      .fetch(number!, { budgetMs: 45_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.last_status_text).toBeTruthy();
  }, 55_000);
});
