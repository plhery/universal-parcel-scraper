import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.PAQUETEX_NUMBER;
it.skipIf(!number)('reads the PaquetEx box supplied in the environment', async () => {
  const tracker = adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
  const answer = await tracker.track({ number: number! });
  expect(answer.canonical_tracking_number).toMatch(/^(?:MEX|GUA|SLV|HON|NIC)\d+$/);
  expect(answer.events?.length).toBeGreaterThan(0);
});
