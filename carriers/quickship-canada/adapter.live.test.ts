import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.QUICKSHIP_TRACKING_NUMBER;
const handoff = process.env.QUICKSHIP_LAST_MILE_AWB;
const missing = process.env.QUICKSHIP_UNKNOWN_NUMBER;

it.skipIf(!number)('returns booking, transit and delivery for the published QuickShip waybill', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.stage === 'registered')).toBe(true);
  expect(result.events?.some(event => event.stage === 'in_transit')).toBe(true);
  expect(result.delivered_at).toBeTruthy();
}, 20_000);

it.skipIf(!handoff)('returns a shipment through its published last-mile waybill', async () => {
  const result = await tracker.track({ number: handoff! });
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.some(event => event.stage === 'delivered')).toBe(true);
}, 20_000);

it.skipIf(!missing)('recognizes the carrier’s missing waybill response', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 20_000);
