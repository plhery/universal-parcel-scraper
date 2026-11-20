import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Tuomeida live retrieval', () => {
  it.skipIf(!process.env.TUOMEIDA_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TUOMEIDA_TRACKING_NUMBER!, carrier: 'tuomeida' });
    expect(answer).toMatchObject({ carrier: 'tuomeida', source: 'tuomeida' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tuomeida', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
    // Every row keeps the wall clock the tracker gives it.
    expect(events.every((event) => event.local_time)).toBe(true);
  });

  it.skipIf(!process.env.TUOMEIDA_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TUOMEIDA_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
