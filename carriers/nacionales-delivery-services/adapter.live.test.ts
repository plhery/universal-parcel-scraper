import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.NEXGO_TRACKING_NUMBER;

it.skipIf(!number)('returns collection, transit and delivery scans for the published shipment', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.map(event => event.stage)).toEqual(expect.arrayContaining(['accepted', 'in_transit', 'delivered']));
}, 20_000);
