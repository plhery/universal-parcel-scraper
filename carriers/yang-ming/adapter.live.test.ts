import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

describe('Yang Ming live retrieval', () => {
  it.skipIf(!process.env.YANG_MING_TRACKING_NUMBER)('retrieves dated moves for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.YANG_MING_TRACKING_NUMBER!, carrier: 'yang-ming' });
    expect(answer).toMatchObject({ carrier: 'yang-ming', source: 'yang-ming', attempts: [{ source: 'yang-ming', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.YANG_MING_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null })
      .track({ number: process.env.YANG_MING_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});
