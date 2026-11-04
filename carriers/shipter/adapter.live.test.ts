import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shipter live retrieval', () => {
  it.skipIf(!process.env.SHIPTER_TRACKING_NUMBER)('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SHIPTER_TRACKING_NUMBER!, carrier: 'shipter' });
    expect(answer).toMatchObject({ carrier: 'shipter', source: 'shipter' });
    expect(answer.attempts[0]).toMatchObject({ source: 'shipter', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  });

  it.skipIf(!process.env.SHIPTER_UNKNOWN_NUMBER)('reads the service-specific absence signature', async () => {
    await expect(direct().track({ number: process.env.SHIPTER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
