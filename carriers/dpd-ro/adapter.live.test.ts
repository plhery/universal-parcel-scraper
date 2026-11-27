import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, DpdRoTracker } from './adapter.js';

const trawl = TrawlClient.fromEnvironment();
const browserProxy = process.env.DPD_RO_BROWSER_PROXY_URL?.trim() || null;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DPD Romania live retrieval', () => {
  it.skipIf(!process.env.DPD_RO_TRACKING_NUMBER)('reads the endpoint without the tracker\'s Turnstile token as a challenge', async () => {
    await expect(direct().track({ number: process.env.DPD_RO_TRACKING_NUMBER! })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it.skipIf(!trawl || !process.env.DPD_RO_TRACKING_NUMBER)('retrieves dated history for the requested waybill through the tracker page', async () => {
    const result = await new DpdRoTracker({ trawl, browserProxy }).fetch(process.env.DPD_RO_TRACKING_NUMBER!, { budgetMs: 60_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time && event.provider_code)).toBe(true);
  }, 70_000);

  it.skipIf(!trawl || !process.env.DPD_RO_UNKNOWN_NUMBER)('reads the not-found page for an unknown waybill as not found', async () => {
    await expect(new DpdRoTracker({ trawl, browserProxy }).fetch(process.env.DPD_RO_UNKNOWN_NUMBER!, { budgetMs: 60_000 }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 70_000);
});
