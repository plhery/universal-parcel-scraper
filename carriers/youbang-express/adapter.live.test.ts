import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A number in YouBang Express's layout whose serial sits far beyond the range in use.
const UNKNOWN = process.env.YOUBANG_EXPRESS_UNKNOWN_NUMBER ?? 'YB9900000009CN';

describe('YouBang Express live retrieval', () => {
  it.skipIf(!process.env.YOUBANG_EXPRESS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.YOUBANG_EXPRESS_TRACKING_NUMBER!, carrier: 'youbang-express' });
    expect(answer).toMatchObject({ carrier: 'youbang-express', source: 'youbang-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'youbang-express', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows read on the tracker's Beijing clock, none still ahead of the lookup.
    expect(answer.result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
