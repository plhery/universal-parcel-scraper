import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('USEND Chile live retrieval', () => {
  it.skipIf(!process.env.USEND_CHILE_TRACKING_NUMBER)('retrieves the history of the requested guide with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.USEND_CHILE_TRACKING_NUMBER!, carrier: 'usend-chile' });
    expect(answer).toMatchObject({ carrier: 'usend-chile', source: 'usend-chile' });
    expect(answer.attempts[0]).toMatchObject({ source: 'usend-chile', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every movement keeps the agency's wall clock and its wording; an instant is only deduced from the zone.
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))
      && (!event.time || event.time_zone_basis))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.USEND_CHILE_UNKNOWN_NUMBER)('reads a guide the tracker does not hold as not found', async () => {
    await expect(direct().track({ number: process.env.USEND_CHILE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
