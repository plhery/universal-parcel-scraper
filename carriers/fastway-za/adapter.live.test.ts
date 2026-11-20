import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const known = process.env.FASTWAY_ZA_TRACKING_NUMBER;
const unknown = process.env.FASTWAY_ZA_UNKNOWN_NUMBER;

describe('Fastway South Africa guest tracking', () => {
  it.skipIf(!known)('reads dated scans for the label', async () => {
    const result = await tracker.track({ number: known! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.last_update_local).toEqual(expect.any(String));
  });
  it.skipIf(!unknown)('reports no scans for the unknown label', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ name: 'NoHistoryError' });
  });
});
