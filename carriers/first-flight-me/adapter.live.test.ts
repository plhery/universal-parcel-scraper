import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';

const number = process.env.FIRST_FLIGHT_ME_TRACKING_NUMBER;
const browser = process.env.FLARESOLVERR_URL;

it.skipIf(!number || !browser)('reads the requested air waybill through the public tracker', async () => {
  const result = await adapter({
    trawl: new TrawlClient(browser!), browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
  }).track({ number: number! }, {});
  expect(result.events?.length).toBeGreaterThan(0);
}, 45_000);
