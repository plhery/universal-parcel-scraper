import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// An invented number: two letters, ten digits and two letters, with a serial far beyond the range in use.
const UNKNOWN = process.env.SHENGAO_UNKNOWN_NUMBER ?? 'SA9900000009GJ';

describe('SHENGAO live retrieval', () => {
  it.skipIf(!process.env.SHENGAO_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SHENGAO_TRACKING_NUMBER!, carrier: 'shengao' });
    expect(answer).toMatchObject({ carrier: 'shengao', source: 'shengao' });
    expect(answer.attempts[0]).toMatchObject({ source: 'shengao', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows read on the tracker's Beijing clock, none still ahead of the lookup.
    expect(answer.result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
