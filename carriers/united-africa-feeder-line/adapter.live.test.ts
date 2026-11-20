import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const {
  UNITED_AFRICA_FEEDER_LINE_TRACKING_NUMBER: found,
  UNITED_AFRICA_FEEDER_LINE_UNKNOWN_NUMBER: unknown,
} = process.env;

it.skipIf(!found)('reads dated movements for the published UAFL bill', async () => {
  expect((await tracker.track({ number: found! })).events?.length).toBeGreaterThan(0);
}, 35_000);

it.skipIf(!unknown)('recognizes the UAFL no-tracking response', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 35_000);
