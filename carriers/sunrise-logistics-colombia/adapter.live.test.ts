import { expect, it } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.SUNRISE_CO_TRACKING_NUMBER;
const missing = process.env.SUNRISE_CO_UNKNOWN_NUMBER;

it.skipIf(!number)('keeps Sunrise’s historical booking wording and omits the placeholder date', async () => {
  const result = await tracker.track({ number: directTrackingNumber('sunrise-logistics-colombia', number!) });
  expect(result.last_status_text).toBe('CONFIRMACION DE RESERVA');
  expect(result.last_update).toBeUndefined();
  expect(result.last_update_local).toBeUndefined();
}, 20_000);

it.skipIf(!missing)('recognizes the live missing air waybill response', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
