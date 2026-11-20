import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.AEROLINEAS_ARGENTINAS_CARGO_TRACKING_NUMBER;
const empty = process.env.AEROLINEAS_ARGENTINAS_CARGO_EMPTY_NUMBER;

it.skipIf(!number)('returns booking through delivery for the published Aerolíneas Cargo waybill', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.stage === 'accepted')).toBe(true);
  expect(result.events?.some(event => event.stage === 'in_transit')).toBe(true);
  expect(result.events?.some(event => event.stage === 'delivered')).toBe(true);
}, 20_000);

it.skipIf(!empty)('keeps the old published air waybill unconfirmed when the carrier returns a blank result', async () => {
  await expect(tracker.track({ number: empty! })).rejects.toMatchObject({ kind: 'indeterminate' });
}, 20_000);
