import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Swire Shipping live retrieval', () => {
  it.skipIf(!process.env.SWIRE_SHIPPING_TRACKING_NUMBER)('retrieves the moves of the requested bill or container with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SWIRE_SHIPPING_TRACKING_NUMBER!, carrier: 'swire-shipping' });
    expect(answer).toMatchObject({ carrier: 'swire-shipping', source: 'swire-shipping' });
    expect(answer.attempts[0]).toMatchObject({ source: 'swire-shipping', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.SWIRE_SHIPPING_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.SWIRE_SHIPPING_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
