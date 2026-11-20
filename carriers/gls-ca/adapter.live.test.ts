import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const known = process.env.GLS_CA_TRACKING_NUMBER;
const unknown = process.env.GLS_CA_UNKNOWN_NUMBER;

describe('GLS Canada guest tracking', () => {
  it.skipIf(!known)('reads the parcel activity list', async () => {
    const result = await tracker.track({ number: known! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.last_update_local).toEqual(expect.any(String));
  });
  it.skipIf(!unknown)('reports the matching no-record result', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
