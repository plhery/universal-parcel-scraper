import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A string in no shape the tracker issues, so it never names a parcel.
const UNKNOWN = process.env.SUOCANG_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('Suoexpress live retrieval', () => {
  it.skipIf(!process.env.SUOCANG_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SUOCANG_TRACKING_NUMBER!, carrier: 'suocang' });
    expect(answer).toMatchObject({ carrier: 'suocang', source: 'suocang' });
    expect(answer.attempts[0]).toMatchObject({ source: 'suocang', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows on Beijing's clock and DHL's dated in its towns' zone, none ahead of the lookup.
    expect(answer.result.events.every((event) => event.description
      && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
