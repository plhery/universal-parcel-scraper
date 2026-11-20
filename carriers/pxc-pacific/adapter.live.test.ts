import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { PXC_PACIFIC_TRACKING_NUMBER: found, PXC_PACIFIC_UNKNOWN_NUMBER: unknown } = process.env;

describe('PXC Pacific Global live retrieval', () => {
  it.skipIf(!found)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: found!, carrier: 'pxc-pacific' });
    expect(answer).toMatchObject({ carrier: 'pxc-pacific', source: 'pxc-pacific' });
    expect(answer.attempts[0]).toMatchObject({ source: 'pxc-pacific', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.local_time && event.description)).toBe(true);
  }, 45_000);

  it.skipIf(!unknown)('reads a number PXC does not hold as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
