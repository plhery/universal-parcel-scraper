import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';

const number = process.env.JTL_EXPRESS_TRACKING_NUMBER ?? 'C4BLT002-0323-00006';
const unknown = process.env.JTL_EXPRESS_UNKNOWN_NUMBER;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

describe('JTL Express live tracker', () => {
  it('returns the resi’s rows on their wall clocks', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
  }, 30_000);
  it.skipIf(!unknown)('reads an unknown resi as not found', async () => {
    await expect(tracker().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
