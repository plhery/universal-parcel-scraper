import { describe, expect, it } from 'vitest';
import { TorbonTracker } from './adapter.js';

// The public sample from kuaidi100's carrier list, unless another is set outside the repository, and a number in
// Torbon's layout whose serial sits far below the range in use.
const NUMBER = process.env.TORBON_TRACKING_NUMBER ?? 'TB2025026636CN';
const UNKNOWN = process.env.TORBON_UNKNOWN_NUMBER ?? 'TB0000000000CN';

describe('Torbon live retrieval', () => {
  it('retrieves the waybill history', async () => {
    const result = await new TorbonTracker().fetch(NUMBER);
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan states its offset, none still ahead of the lookup.
    expect(result.events!.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
    expect(result.events!.some((event) => event.time?.endsWith('+08:00'))).toBe(true);
  }, 30_000);

  it('reads an unknown waybill as not found', async () => {
    await expect(new TorbonTracker().fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
