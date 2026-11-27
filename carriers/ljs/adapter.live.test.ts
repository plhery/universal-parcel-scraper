import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('LJS live retrieval', () => {
  it.skipIf(!process.env.LJS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LJS_TRACKING_NUMBER!, carrier: 'ljs' });
    expect(answer).toMatchObject({ carrier: 'ljs', source: 'ljs' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ljs', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // The line's rows on the tracker's Beijing clock and Sagawa's on Japan's, none still ahead of the lookup.
    expect(answer.result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it.skipIf(!process.env.LJS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LJS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
