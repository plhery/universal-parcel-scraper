import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A number in Shilianxin's layout whose serial sits below the range in use.
const UNKNOWN = process.env.SHILIANXIN_UNKNOWN_NUMBER ?? 'SLX000000000CN';

describe('Shilianxin live retrieval', () => {
  it.skipIf(!process.env.SHILIANXIN_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SHILIANXIN_TRACKING_NUMBER!, carrier: 'shilianxin' });
    expect(answer).toMatchObject({ carrier: 'shilianxin', source: 'shilianxin' });
    expect(answer.attempts[0]).toMatchObject({ source: 'shilianxin', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows on Beijing's clock, none still ahead of the lookup, or USPS's wall clocks.
    expect(answer.result.events.every((event) => event.description
      && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
