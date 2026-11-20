import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Phantom Couriers live retrieval', () => {
  it.skipIf(!process.env.PHANTOM_COURIERS_TRACKING_NUMBER)('retrieves the milestones of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PHANTOM_COURIERS_TRACKING_NUMBER!, carrier: 'phantom-couriers' });
    expect(answer).toMatchObject({ carrier: 'phantom-couriers', source: 'phantom-couriers' });
    expect(answer.attempts[0]).toMatchObject({ source: 'phantom-couriers', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone is an instant the order's record gives, labelled with its code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && event.time && !event.time_zone_basis)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.PHANTOM_COURIERS_UNKNOWN_NUMBER)('reads an order the courier does not hold as not found', async () => {
    await expect(direct().track({ number: process.env.PHANTOM_COURIERS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
