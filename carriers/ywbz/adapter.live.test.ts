import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('YWBZ Express live retrieval', () => {
  it.skipIf(!process.env.YWBZ_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.YWBZ_TRACKING_NUMBER!, carrier: 'ywbz' });
    expect(answer).toMatchObject({ carrier: 'ywbz', source: 'ywbz' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ywbz', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // A scan has its instant when the line states its offset, else its wall clock.
    expect(answer.result.events.every((event) => event.description
      && (event.time || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.YWBZ_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.YWBZ_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
