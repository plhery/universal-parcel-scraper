import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const chromium = process.env.TRACKING_CHROMIUM_PATH?.trim() || null;
const direct = (browserExecutablePath = chromium) => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath });

describe('ZIM live retrieval', () => {
  it.skipIf(!process.env.ZIM_TRACKING_NUMBER)('retrieves dated activities for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], ...(chromium ? { chromiumPath: chromium } : {}) })
      .track({ number: process.env.ZIM_TRACKING_NUMBER!, carrier: 'zim' });
    expect(answer).toMatchObject({ carrier: 'zim', source: 'zim', attempts: [{ source: 'zim', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.ZIM_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ZIM_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);

  it.skipIf(!process.env.ZIM_TRACKING_NUMBER || !chromium)('retrieves the shipment through the tracking page in a local browser', async () => {
    const { fetchZimInBrowser } = await import('./browser.js');
    const { zimQuery } = await import('./parser.js');
    const reply = await fetchZimInBrowser(zimQuery(process.env.ZIM_TRACKING_NUMBER!), chromium!, AbortSignal.timeout(60_000), 60_000);
    expect(reply.events?.length).toBeGreaterThan(0);
  }, 75_000);
});
