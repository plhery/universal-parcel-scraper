import { describe, expect, it } from 'vitest';
import { WedoTracker } from './adapter.js';

describe('One by Allegro CZ guest history', () => {
  it.skipIf(!process.env.WEDO_TRACKING_NUMBER)('retrieves offset-dated scans', async () => {
    const result = await new WedoTracker().fetch(process.env.WEDO_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time && !event.local_time)).toBe(true);
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.WEDO_UNKNOWN_NUMBER)('keeps an empty retained history inconclusive', async () => {
    await expect(new WedoTracker().fetch(process.env.WEDO_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  });
});
