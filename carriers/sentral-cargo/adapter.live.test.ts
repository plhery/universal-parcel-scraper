import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const known = process.env.SENTRAL_CARGO_TRACKING_NUMBER;
const unknown = process.env.SENTRAL_CARGO_UNKNOWN_NUMBER;

describe('Sentral Cargo guest tracking', () => {
  it.skipIf(!known)('reads dated events for the receipt', async () => {
    const result = await tracker.track({ number: known! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.last_update).toEqual(expect.any(String));
  });
  it.skipIf(!unknown)('reports the matching missing-receipt notice', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
