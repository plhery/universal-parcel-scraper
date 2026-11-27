import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Pass the Parcel live retrieval', () => {
  it.skipIf(!process.env.PASS_THE_PARCEL_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.PASS_THE_PARCEL_TRACKING_NUMBER!, carrier: 'pass-the-parcel' });
    expect(answer).toMatchObject({ carrier: 'pass-the-parcel', source: 'pass-the-parcel' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pass-the-parcel', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result).not.toHaveProperty('delivery_carrier');
    // Every scan is an instant in UTC with its type as the code.
    expect(answer.result.events.every((event) => event.description && event.provider_code && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.PASS_THE_PARCEL_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.PASS_THE_PARCEL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
