import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// No public page shows a DPD China number, so a found number comes from outside the repository.
const positive = process.env.DPD_CN_TRACKING_NUMBER;
// The all-zero number: the registry refuses it as a placeholder, so it goes to the adapter itself.
const UNKNOWN = '00000000000000';

describe('DPD China live retrieval', () => {
  it.skipIf(!positive)('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: positive!, carrier: 'dpd-cn' });
    expect(answer).toMatchObject({ carrier: 'dpd-cn', source: 'dpd-cn' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dpd-cn', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Each scan on its facility's wall clock, dated by its place; none a day ahead.
    expect(events.every((event) => event.description && event.local_time && event.time
      && Date.parse(event.time) <= Date.now() + 86_400_000)).toBe(true);
  }, 45_000);

  it('reads the NotFound row for an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
