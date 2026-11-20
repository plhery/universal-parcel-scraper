import { expect, it } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.AEROMEXICO_CARGO_AWB;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('finds the published waybill and its carrier-reported delivery', async () => {
  const result = await tracker.track({ number: directTrackingNumber('aeromexico-cargo', number!) });

  expect(result.provider_code).toBe('DLV');
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.length).toBeGreaterThanOrEqual(17);
}, 20_000);
