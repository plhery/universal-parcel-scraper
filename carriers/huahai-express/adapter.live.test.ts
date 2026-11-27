import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Huahai Express live retrieval', () => {
  it.skipIf(!process.env.HUAHAI_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.HUAHAI_EXPRESS_TRACKING_NUMBER!, carrier: 'huahai-express' });
    expect(answer).toMatchObject({ carrier: 'huahai-express', source: 'huahai-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'huahai-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows in China read on the tracker's Beijing clock, none still ahead of the lookup; rows abroad keep their wall clocks.
    expect(answer.result.events.every((event) => event.description && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it.skipIf(!process.env.HUAHAI_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.HUAHAI_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
