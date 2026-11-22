import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Qilin International live retrieval', () => {
  it.skipIf(!process.env.QLGJ_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.QLGJ_TRACKING_NUMBER!, carrier: 'qlgj' });
    expect(answer).toMatchObject({ carrier: 'qlgj', source: 'qlgj' });
    expect(answer.attempts[0]).toMatchObject({ source: 'qlgj', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows in China read on the tracker's Beijing clock, none still ahead of the lookup; rows abroad keep their wall clocks.
    expect(answer.result.events.every((event) => event.description && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it.skipIf(!process.env.QLGJ_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.QLGJ_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
