import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A string in no shape the tracker issues, so it never names a parcel.
const UNKNOWN = process.env.YCEX_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('YCEX live retrieval', () => {
  it.skipIf(!process.env.YCEX_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.YCEX_TRACKING_NUMBER!, carrier: 'ycex' });
    expect(answer).toMatchObject({ carrier: 'ycex', source: 'ycex' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ycex', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row dated, the ones copied from DHL on DHL's wall clock, none ahead of the lookup.
    expect(answer.result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
