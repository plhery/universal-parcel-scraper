import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A number in VYANG's layout whose serial sits below the range in use.
const UNKNOWN = process.env.VYANG_UNKNOWN_NUMBER ?? 'VY000000000000YQ';

describe('VYANG live retrieval', () => {
  it.skipIf(!process.env.VYANG_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.VYANG_TRACKING_NUMBER!, carrier: 'vyang' });
    expect(answer).toMatchObject({ carrier: 'vyang', source: 'vyang' });
    expect(answer.attempts[0]).toMatchObject({ source: 'vyang', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows on Beijing's or DHL's clock, none still ahead of the lookup, or a wall clock abroad.
    expect(answer.result.events.every((event) => event.description
      && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
