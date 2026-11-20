import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const chromium = process.env.TRACKING_CHROMIUM_PATH?.trim() || null;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: chromium });

describe('HMM live retrieval', () => {
  it.skipIf(!process.env.HMM_TRACKING_NUMBER || !chromium)('retrieves dated moves for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [], chromiumPath: chromium! })
      .track({ number: process.env.HMM_TRACKING_NUMBER!, carrier: 'hmm' });
    expect(answer).toMatchObject({ carrier: 'hmm', source: 'hmm', attempts: [{ source: 'hmm', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.HMM_UNKNOWN_NUMBER || !chromium)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.HMM_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});
