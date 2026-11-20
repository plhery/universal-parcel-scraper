import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const chromium = process.env.TRACKING_CHROMIUM_PATH?.trim() || null;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: chromium });

describe('COSCO SHIPPING Lines live retrieval', () => {
  it.skipIf(!process.env.COSCO_SHIPPING_LINES_TRACKING_NUMBER)('retrieves dated milestones for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], chromiumPath: chromium ?? undefined })
      .track({ number: process.env.COSCO_SHIPPING_LINES_TRACKING_NUMBER!, carrier: 'cosco-shipping-lines' });
    expect(answer).toMatchObject({ carrier: 'cosco-shipping-lines', source: 'cosco-shipping-lines', attempts: [{ source: 'cosco-shipping-lines', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.COSCO_SHIPPING_LINES_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.COSCO_SHIPPING_LINES_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);

  it.skipIf(!process.env.COSCO_SHIPPING_LINES_TRACKING_NUMBER || !chromium)('reads the shipment through the cargo tracking page in a local browser', async () => {
    const { fetchCoscoInBrowser } = await import('./browser.js');
    const { coscoQuery } = await import('./parser.js');
    const result = await fetchCoscoInBrowser(coscoQuery(process.env.COSCO_SHIPPING_LINES_TRACKING_NUMBER!), chromium!, AbortSignal.timeout(60_000), 60_000);
    expect(result.events?.length).toBeGreaterThan(0);
  }, 75_000);
});
