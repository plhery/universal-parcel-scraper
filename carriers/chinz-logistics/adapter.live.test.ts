import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const positive = process.env.CHINZ_LOGISTICS_TRACKING_NUMBER;
const unknown = process.env.CHINZ_LOGISTICS_UNKNOWN_NUMBER;

describe('Chinz Logistics live guest retrieval', () => {
  it.skipIf(!positive)('reads dated scans for the requested order', async () => {
    const result = await tracker.track({ number: positive! }, {});
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time && event.description)).toBe(true);
  });
  it.skipIf(!unknown)('reports a confirmed miss', async () => {
    await expect(tracker.track({ number: unknown! }, {})).rejects.toMatchObject({ kind: 'not_found' });
  });
});
