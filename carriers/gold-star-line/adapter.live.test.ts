import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const chromium = process.env.TRACKING_CHROMIUM_PATH?.trim() || null;
const number = process.env.GOLD_STAR_LINE_TRACKING_NUMBER;
const direct = (browserExecutablePath = chromium) => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath });

describe('Gold Star Line live retrieval', () => {
  it.skipIf(!number)('retrieves dated activities for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], ...(chromium ? { chromiumPath: chromium } : {}) })
      .track({ number: number!, carrier: 'gold-star-line' });
    expect(answer).toMatchObject({ carrier: 'gold-star-line', source: 'gold-star-line', attempts: [{ source: 'gold-star-line', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.GOLD_STAR_LINE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.GOLD_STAR_LINE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);

  it.skipIf(!number || !chromium)('retrieves the shipment through the tracking page in a local browser', async () => {
    const { fetchGoldStarLineInBrowser } = await import('./browser.js');
    const { goldStarLineQuery } = await import('./parser.js');
    const reply = await fetchGoldStarLineInBrowser(goldStarLineQuery(number!), chromium!, AbortSignal.timeout(60_000), 60_000);
    expect(reply.events?.length).toBeGreaterThan(0);
  }, 75_000);
});
