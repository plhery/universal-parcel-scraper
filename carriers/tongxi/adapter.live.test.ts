import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('TongXi live retrieval', () => {
  it.skipIf(!process.env.TONGXI_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TONGXI_TRACKING_NUMBER!, carrier: 'tongxi' });
    expect(answer).toMatchObject({ carrier: 'tongxi', source: 'tongxi' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tongxi', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The line's rows read on the tracker's Beijing clock, none still ahead of the lookup; the delivery carrier's keep their wall clocks.
    expect(answer.result.events.every((event) => event.description && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it.skipIf(!process.env.TONGXI_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TONGXI_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
