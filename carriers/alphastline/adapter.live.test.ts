import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Alphastline live retrieval', () => {
  it.skipIf(!process.env.ALPHASTLINE_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.ALPHASTLINE_TRACKING_NUMBER!, carrier: 'alphastline' });
    expect(answer).toMatchObject({ carrier: 'alphastline', source: 'alphastline' });
    expect(answer.attempts[0]).toMatchObject({ source: 'alphastline', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its instant on the clock it is written in.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ALPHASTLINE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ALPHASTLINE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
