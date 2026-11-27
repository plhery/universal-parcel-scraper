import { describe, expect, it } from 'vitest';
import { LongtengTracker } from './adapter.js';

// The public sample from kuaidi100's carrier list, unless another is set outside the repository, and a number in
// Longteng's layout dated years before the tracker's samples.
const NUMBER = process.env.LONGTENG_TRACKING_NUMBER ?? 'S2025100990405';
const UNKNOWN = process.env.LONGTENG_UNKNOWN_NUMBER ?? 'S2019000000017';

describe('Longteng live retrieval', () => {
  it('retrieves the waybill history', async () => {
    const result = await new LongtengTracker().fetch(NUMBER);
    expect(result.events!.length).toBeGreaterThan(0);
    // Every row is dated on US Pacific time, none after the lookup.
    expect(result.events!.every((event) => event.description && event.local_time && event.time_zone === 'America/Los_Angeles'
      && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
    expect(result.last_update).toBe(result.events![0]!.time);
  }, 30_000);

  it('reads an unknown waybill as not found', async () => {
    await expect(new LongtengTracker().fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
