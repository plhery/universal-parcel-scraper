import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A string in no shape the tracker issues, so it never names a parcel.
const UNKNOWN = process.env.XS_EXPRESS_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('Xinshu Logistics live retrieval', () => {
  it.skipIf(!process.env.XS_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.XS_EXPRESS_TRACKING_NUMBER!, carrier: 'xs-express' });
    expect(answer).toMatchObject({ carrier: 'xs-express', source: 'xs-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'xs-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The line's rows on Beijing's clock and USPS's copies on their wall clocks, none ahead of the lookup.
    expect(answer.result.events.every((event) => event.description
      && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
