import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const positive = process.env.CARGOX_TRACKING_NUMBER;
const unknown = process.env.CARGOX_UNKNOWN_NUMBER;

describe('Cargo X live guest retrieval', () => {
  it.skipIf(!positive)('reads dated scans for the requested number', async () => {
    const result = await tracker.track({ number: positive! }, {});
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.time && event.description)).toBe(true);
  });
  it.skipIf(!unknown)('reports an unknown number', async () => {
    await expect(tracker.track({ number: unknown! }, {})).rejects.toMatchObject({ kind: 'not_found' });
  });
});
