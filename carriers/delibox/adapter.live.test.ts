import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
const positive = process.env.DELIBOX_TRACKING_NUMBER;
const unknown = process.env.DELIBOX_UNKNOWN_NUMBER;

describe('Delibox live guest retrieval', () => {
  it.skipIf(!positive)('reads dated scans for the requested waybill', async () => {
    const result = await tracker.track({ number: positive! }, {});
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.every(event => event.local_time && event.description)).toBe(true);
  });
  it.skipIf(!unknown)('preserves the generic lookup alert as inconclusive', async () => {
    await expect(tracker.track({ number: unknown! }, {})).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });
});
