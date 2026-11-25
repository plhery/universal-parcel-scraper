import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A number in a shape the tracker cannot hold.
const UNKNOWN = process.env.QYUN_UNKNOWN_NUMBER ?? 'ZZ0000000000ZZ';

describe('Qyun Express live retrieval', () => {
  it.skipIf(!process.env.QYUN_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.QYUN_TRACKING_NUMBER!, carrier: 'qyun' });
    expect(answer).toMatchObject({ carrier: 'qyun', source: 'qyun' });
    expect(answer.attempts[0]).toMatchObject({ source: 'qyun', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Rows on Beijing's clock, none still ahead of the lookup, or the line's days.
    expect(answer.result.events.every((event) => event.description
      && (event.time ? Date.parse(event.time) <= Date.now() : event.local_time))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
