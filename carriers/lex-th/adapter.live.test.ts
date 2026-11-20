import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const known = process.env.LEX_TH_TRACKING_NUMBER;
const unknown = process.env.LEX_TH_UNKNOWN_NUMBER;

describe('LEX Thailand guest tracking', () => {
  it.skipIf(!known)('reads the requested parcel’s Thai LEX status', async () => {
    await expect(tracker.track({ number: known! })).resolves.toMatchObject({
      provider_code: expect.any(String), summary_only: true, events: [],
    });
  });
  it.skipIf(!unknown)('reports an empty result for an unknown number', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
