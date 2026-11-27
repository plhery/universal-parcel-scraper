import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('LingXun Logistics live retrieval', () => {
  it.skipIf(!process.env.LINGXUN_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LINGXUN_LOGISTICS_TRACKING_NUMBER!, carrier: 'lingxun-logistics' });
    expect(answer).toMatchObject({ carrier: 'lingxun-logistics', source: 'lingxun-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'lingxun-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows in China read on the tracker's Beijing clock, none still ahead of the lookup; the copies abroad keep their wall clocks.
    expect(answer.result.events.every((event) => event.description && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it.skipIf(!process.env.LINGXUN_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LINGXUN_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
