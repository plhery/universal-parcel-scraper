import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Skif-Cargo live retrieval', () => {
  it.skipIf(!process.env.SKIF_CARGO_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SKIF_CARGO_TRACKING_NUMBER!, carrier: 'skif-cargo' });
    expect(answer).toMatchObject({ carrier: 'skif-cargo', source: 'skif-cargo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'skif-cargo', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every point has its wording and a day, or the issue its wall clock; an instant is one deduced from its place.
    expect(answer.result.events.every((event) => event.description && event.local_time && (!event.time || event.time_zone_basis))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SKIF_CARGO_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SKIF_CARGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
