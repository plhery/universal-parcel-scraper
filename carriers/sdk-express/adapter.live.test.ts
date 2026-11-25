import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A string in no shape the tracker issues, so it never names a parcel.
const UNKNOWN = process.env.SDK_EXPRESS_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('SDK Express live retrieval', () => {
  it.skipIf(!process.env.SDK_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SDK_EXPRESS_TRACKING_NUMBER!, carrier: 'sdk-express' });
    expect(answer).toMatchObject({ carrier: 'sdk-express', source: 'sdk-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'sdk-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row has its wording and a clock or a day.
    expect(answer.result.events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
