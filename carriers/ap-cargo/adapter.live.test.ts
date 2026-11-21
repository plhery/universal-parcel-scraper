import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { AP_CARGO_TRACKING_NUMBER: found, AP_CARGO_UNKNOWN_NUMBER: missing } = process.env;

it.skipIf(!found)('reads the history of a waybill newest first on branch wall clocks', async () => {
  const result = await tracker.track({ number: found! }, { budgetMs: 30_000 });
  const events = result.events ?? [];
  expect(events.length).toBeGreaterThan(0);
  // The tracker gives wall clocks without a zone, a bare date for a row without a time of day.
  expect(events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
  expect(events.some((event) => 'time' in event)).toBe(false);
  expect(events.some((event) => event.stage_source === 'carrier_map')).toBe(true);
  const clocks = events.map((event) => event.local_time!.length === 10 ? `${event.local_time}T24` : event.local_time!);
  expect(clocks).toEqual([...clocks].sort().reverse());
}, 45_000);

it.skipIf(!missing)('reads the tracker’s answer for an unknown number as not found', async () => {
  await expect(tracker.track({ number: missing! }, { budgetMs: 30_000 })).rejects.toMatchObject({ kind: 'not_found' });
}, 45_000);
