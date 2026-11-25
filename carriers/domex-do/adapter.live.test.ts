import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const positive = process.env.DOMEX_DO_TRACKING_NUMBER;
const unknown = process.env.DOMEX_DO_UNKNOWN_NUMBER;

describe('Domex Expreso live guest retrieval', () => {
  it.skipIf(!positive)('reads dated scans for the requested guide', async () => {
    const result = await tracker.track({ number: positive! }, {});
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time && event.description)).toBe(true);
  });
  it.skipIf(!unknown)('reports the tracker\'s invalid-guide notice as not found', async () => {
    await expect(tracker.track({ number: unknown! }, {})).rejects.toMatchObject({ kind: 'not_found' });
  });
});
