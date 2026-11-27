import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, SpeedyTracker } from './adapter.js';

const trawl = TrawlClient.fromEnvironment();
const browserProxy = process.env.SPEEDY_BROWSER_PROXY_URL?.trim() || null;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Speedy live retrieval', () => {
  it.skipIf(!process.env.SPEEDY_TRACKING_NUMBER)('reads the endpoint without the tracker\'s Turnstile token as a challenge', async () => {
    await expect(direct().track({ number: process.env.SPEEDY_TRACKING_NUMBER! })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it.skipIf(!trawl || !process.env.SPEEDY_TRACKING_NUMBER)('retrieves dated history for the requested shipment through the tracker page', async () => {
    const result = await new SpeedyTracker({ trawl, browserProxy }).fetch(process.env.SPEEDY_TRACKING_NUMBER!, { budgetMs: 60_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time)).toBe(true);
  }, 70_000);

  it.skipIf(!trawl || !process.env.SPEEDY_TRACKING_NUMBER)('confirms the shipment through the tracker page in browser recognition', async () => {
    const instance = adapter({ recorder: NOOP_RECORDER, env: { SPEEDY_BROWSER_PROXY_URL: browserProxy ?? '' }, trawl, browserExecutablePath: null });
    await expect(instance.recognizeWithBrowser!(process.env.SPEEDY_TRACKING_NUMBER!, { budgetMs: 60_000 }))
      .resolves.toMatchObject({ known: true, lastActivityAt: expect.any(String) });
  }, 70_000);

  it.skipIf(!trawl || !process.env.SPEEDY_UNKNOWN_NUMBER)('reads the missing-resource page for an unknown number as not found', async () => {
    await expect(new SpeedyTracker({ trawl, browserProxy }).fetch(process.env.SPEEDY_UNKNOWN_NUMBER!, { budgetMs: 60_000 }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 70_000);
});
