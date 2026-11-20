import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Gaint Logistic live retrieval', () => {
  it.skipIf(!process.env.GAINT_LOGISTIC_TRACKING_NUMBER)('reads the security code and retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GAINT_LOGISTIC_TRACKING_NUMBER!, carrier: 'gaint-logistic' });
    expect(answer).toMatchObject({ carrier: 'gaint-logistic', source: 'gaint-logistic' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gaint-logistic', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan is an instant with its wording.
    expect(answer.result.events.every((event) => event.description && event.time && !event.time_zone_basis)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.GAINT_LOGISTIC_UNKNOWN_NUMBER)('reads a number the tracker has no shipment under as not found', async () => {
    await expect(direct().track({ number: process.env.GAINT_LOGISTIC_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
