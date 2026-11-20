import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.ALHOSARY_SHIPPING_NUMBER;
it.skipIf(!number)('reads an Alhosary shipment number supplied in the environment', async () => {
  const tracker = adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(0);
});
