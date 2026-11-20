import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { SKY_COURIER_CO_TRACKING_NUMBER: found, SKY_COURIER_CO_UNKNOWN_NUMBER: unknown } = process.env;

it.skipIf(!found)('looks up the carrier’s published Sky Courier guide', async () => {
  const result = await tracker.track({ number: found!.replaceAll('-', '') });
  expect(result).toMatchObject({ summary_only: true, last_status_text: expect.any(String), events: [] });
}, 30_000);

it.skipIf(!unknown)('recognizes the native package-not-found reply', async () => {
  await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
}, 30_000);
