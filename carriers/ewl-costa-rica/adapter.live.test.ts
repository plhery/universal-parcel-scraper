import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.EWL_COSTA_RICA_NUMBER;
it.skipIf(!number)('reads an EWL guide on the public tracker', async () => {
  const tracker = adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(0);
  expect(result.last_update_local).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});
