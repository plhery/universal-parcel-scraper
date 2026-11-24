import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A number in ED POST's layout whose serial sits below the range in use.
const UNKNOWN = process.env.ED_POST_UNKNOWN_NUMBER ?? 'YDPOZ0000000000YQ';

describe('ED POST live retrieval', () => {
  it.skipIf(!process.env.ED_POST_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ED_POST_TRACKING_NUMBER!, carrier: 'ed-post' });
    expect(answer).toMatchObject({ carrier: 'ed-post', source: 'ed-post' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ed-post', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows on Beijing's clock or DHL's, none still ahead of the lookup, or a delivery carrier's wall clock.
    expect(answer.result.events.every((event) => event.description
      && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
