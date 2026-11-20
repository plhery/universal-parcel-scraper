import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.LOGEXIM_EXPRESS_NUMBER;
it.skipIf(!number)('reads the Logexim Express waybill supplied in the environment', async () => {
  const tracker = adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
  const answer = await tracker.track({ number: number! });
  expect(answer.last_status_text).toEqual(expect.any(String));
  expect(answer.events?.length).toBeGreaterThan(0);
});
