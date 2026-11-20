import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.SWIFT_DROP_AE_NUMBER;
it.skipIf(!number)('reads a Swift Drop order supplied in the environment', async () => {
  const tracker = adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
  await expect(tracker.track({ number: number! })).resolves.toMatchObject({
    last_status_text: expect.any(String), summary_only: true,
  });
});
