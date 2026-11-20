import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const chromium = process.env.TRACKING_CHROMIUM_PATH?.trim() || null;
const direct = (browserExecutablePath = chromium) => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath });

describe('MSC live retrieval', () => {
  it.skipIf(!process.env.MSC_TRACKING_NUMBER)('retrieves dated moves for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], ...(chromium ? { chromiumPath: chromium } : {}) })
      .track({ number: process.env.MSC_TRACKING_NUMBER!, carrier: 'msc' });
    expect(answer).toMatchObject({ carrier: 'msc', source: 'msc', attempts: [{ source: 'msc', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.MSC_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MSC_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});
