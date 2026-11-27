import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// No public page shows an air waybill, so a found number comes from outside the repository.
const positive = process.env.SKYNET_IN_TRACKING_NUMBER;
// The registry refuses the placeholder, so it goes to the adapter itself.
const UNKNOWN = 'TEST00000000';

describe('Skynet Express India live retrieval', () => {
  it.skipIf(!positive)('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: positive!, carrier: 'skynet-in' });
    expect(answer).toMatchObject({ carrier: 'skynet-in', source: 'skynet-in' });
    expect(answer.attempts[0]).toMatchObject({ source: 'skynet-in', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Wall clocks without an offset, each with its wording and label key.
    expect(events.every((event) => event.description && event.provider_code && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(event.local_time ?? '')
      && event.time === undefined)).toBe(true);
  }, 45_000);

  it('reads the service’s answer for an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
