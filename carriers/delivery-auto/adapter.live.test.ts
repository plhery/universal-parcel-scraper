import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const known = process.env.DELIVERY_AUTO_TRACKING_NUMBER;
const unknown = process.env.DELIVERY_AUTO_UNKNOWN_NUMBER;

describe('Delivery guest tracking', () => {
  it.skipIf(!known)('reads a receipt status', async () => {
    await expect(tracker.track({ number: known! })).resolves.toMatchObject({
      last_status_text: expect.any(String), summary_only: true,
    });
  });
  it.skipIf(!unknown)('reports the empty reply for an unknown receipt', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
