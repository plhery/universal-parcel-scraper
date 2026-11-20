import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const chromium = process.env.TRACKING_CHROMIUM_PATH?.trim() || null;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: chromium });

describe('OOCL live retrieval', () => {
  it.skipIf(!process.env.OOCL_TRACKING_NUMBER || !chromium)('retrieves dated milestones for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], chromiumPath: chromium! })
      .track({ number: process.env.OOCL_TRACKING_NUMBER!, carrier: 'oocl' });
    expect(answer).toMatchObject({ carrier: 'oocl', source: 'oocl', attempts: [{ source: 'oocl', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.OOCL_UNKNOWN_NUMBER || !chromium)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.OOCL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});
