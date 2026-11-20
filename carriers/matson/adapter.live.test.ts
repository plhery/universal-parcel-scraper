import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('Matson live retrieval', () => {
  it.skipIf(!process.env.MATSON_TRACKING_NUMBER)('retrieves dated events for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MATSON_TRACKING_NUMBER!, carrier: 'matson' });
    expect(answer).toMatchObject({ carrier: 'matson', source: 'matson', attempts: [{ source: 'matson', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.MATSON_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.MATSON_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
