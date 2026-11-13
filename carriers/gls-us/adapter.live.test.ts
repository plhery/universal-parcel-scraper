import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GLS US live retrieval', () => {
  it('reads a well-formed unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.GLS_US_UNKNOWN_NUMBER ?? 'SH730418265903179913' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);

  it.skipIf(!process.env.GLS_US_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GLS_US_TRACKING_NUMBER!, carrier: 'gls-us' });
    expect(answer).toMatchObject({ carrier: 'gls-us', source: 'gls-us' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gls-us', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is a wall clock the tracker dates on its place's zone.
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 45_000);
});
