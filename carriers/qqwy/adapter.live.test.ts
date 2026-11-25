import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A number in a shape the tracker cannot hold.
const UNKNOWN = process.env.QQWY_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('Global Security live retrieval', () => {
  it.skipIf(!process.env.QQWY_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.QQWY_TRACKING_NUMBER!, carrier: 'qqwy' });
    expect(answer).toMatchObject({ carrier: 'qqwy', source: 'qqwy' });
    expect(answer.attempts[0]).toMatchObject({ source: 'qqwy', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows on Beijing's clock, none still ahead of the lookup, or the copied rows' wall clocks.
    expect(answer.result.events.every((event) => event.description
      && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
