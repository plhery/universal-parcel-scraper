import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

describe('Pasha Hawaii live retrieval', () => {
  it.skipIf(!process.env.PASHA_HAWAII_TRACKING_NUMBER)('retrieves dated moves for the requested container, bill or booking with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PASHA_HAWAII_TRACKING_NUMBER!, carrier: 'pasha-hawaii' });
    expect(answer).toMatchObject({ carrier: 'pasha-hawaii', source: 'pasha-hawaii', attempts: [{ source: 'pasha-hawaii', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.PASHA_HAWAII_UNKNOWN_NUMBER)('reads a number not on file as not found', async () => {
    await expect(adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null })
      .track({ number: process.env.PASHA_HAWAII_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});
