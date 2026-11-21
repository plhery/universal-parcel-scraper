import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { TRACKINGS_GE_TRACKING_NUMBER: number, TRACKINGS_GE_UNKNOWN_NUMBER: unknown } = process.env;

describe('Trackings.GE live retrieval', () => {
  it.skipIf(!number)('reads the dated rows of the requested parcel', async () => {
    const result = await tracker.track({ number: number! });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    // Wall clocks or bare dates, newest first; none is an instant.
    expect(events.every((event) => event.description && !('time' in event)
      && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?$/.test(String(event.local_time)))).toBe(true);
    const clocks = events.map((event) => String(event.local_time));
    expect(clocks).toEqual([...clocks].sort().reverse());
    expect(result).toMatchObject({ last_update: null, last_update_local: clocks[0] });
    expect(result.last_status_text).toBeTruthy();
  }, 60_000);

  it.skipIf(!unknown)('reads a made-up number as not found', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
