import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
const positive = process.env.A_HARTRODT_TRACKING_NUMBER;
const unknown = process.env.A_HARTRODT_UNKNOWN_NUMBER;

describe('a. hartrodt live guest tracking', () => {
  it.skipIf(!positive)('reads dated messages for the exact reference', async () => {
    const result = await tracker.track({ number: positive! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.description && event.time)).toBe(true);
  });

  it.skipIf(!unknown)('reports the native shipment miss', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
