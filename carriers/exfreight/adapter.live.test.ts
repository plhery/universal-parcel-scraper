import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.EXFREIGHT_TRACKING_NUMBER;
const summary = process.env.EXFREIGHT_SUMMARY_NUMBER;

it.skipIf(!number)('returns transport history and delivery for the published shipment', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.description === 'Departed transshipment port')).toBe(true);
}, 20_000);

it.skipIf(!summary)('returns the delivered summary for the shipment with undated movements', async () => {
  const result = await tracker.track({ number: summary! });
  expect(result).toMatchObject({ current_stage: 'delivered', summary_only: true });
}, 20_000);
