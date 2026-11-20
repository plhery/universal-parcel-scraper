import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
const number = process.env.NCM_CAPAR_TRACKING_NUMBER;

describe('NCM Çapar live guest tracking', () => {
  it.skipIf(!number)('loads a dated history with one tracking number', async () => {
    const result = await tracker.track({ number: number! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.time && event.description)).toBe(true);
  });
});
