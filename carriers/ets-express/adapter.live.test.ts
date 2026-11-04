import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ETS Express live retrieval', () => {
  it.skipIf(!process.env.ETS_EXPRESS_TRACKING_NUMBER)('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ETS_EXPRESS_TRACKING_NUMBER!, carrier: 'ets-express' });
    expect(answer).toMatchObject({ carrier: 'ets-express', source: 'ets-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ets-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  });

  it.skipIf(!process.env.ETS_EXPRESS_UNKNOWN_NUMBER)('reads explicit absence as not found', async () => {
    await expect(direct().track({ number: process.env.ETS_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
