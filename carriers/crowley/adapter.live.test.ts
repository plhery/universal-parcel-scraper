import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const {
  CROWLEY_TRACKING_NUMBER: number, CROWLEY_UNKNOWN_NUMBER: missing, CROWLEY_PAGINATED_NUMBER: paginatedNumber,
} = process.env;
const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.skipIf(!number)('returns dated movements from the public Crowley bill search', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.length).toBeGreaterThan(1);
  expect(result.events?.[0]?.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
}, 25_000);

it.skipIf(!missing)('reports the carrier’s empty movement count as not found', async () => {
  await expect(tracker.track({ number: missing! })).rejects.toMatchObject({ kind: 'not_found' });
}, 25_000);

it.skipIf(!paginatedNumber)('follows the public history beyond its first page', async () => {
  const result = await tracker.track({ number: paginatedNumber! });
  expect(result.events?.length).toBeGreaterThan(10);
}, 25_000);
