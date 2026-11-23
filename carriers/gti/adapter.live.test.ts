import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GTI live retrieval', () => {
  it.skipIf(!process.env.GTI_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.GTI_TRACKING_NUMBER!, carrier: 'gti' });
    expect(answer).toMatchObject({ carrier: 'gti', source: 'gti' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gti', kind: 'ok' });
    expect(answer.result.current_stage).toBeDefined();
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.description && (event.time || event.local_time))).toBe(true);
    // The forwarder's own rows on its Beijing clock, none still ahead of the lookup; USPS's keep their wall clocks.
    const own = events.filter((event) => event.time && !event.local_time);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((event) => event.time!.endsWith('+08:00') && Date.parse(event.time!) <= Date.now())).toBe(true);
  });

  it.skipIf(!process.env.GTI_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.GTI_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
