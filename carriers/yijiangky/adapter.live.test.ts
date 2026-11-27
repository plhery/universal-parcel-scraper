import { describe, expect, it } from 'vitest';
import { YijiangTracker } from './adapter.js';

// The public sample from kuaidi100's Yijiang Express page, unless another is set outside the repository, and an
// invented number in the sample's layout.
const NUMBER = process.env.YIJIANG_TRACKING_NUMBER ?? 'YJ362260506067';
const UNKNOWN = process.env.YIJIANG_UNKNOWN_NUMBER ?? 'YJ100200300400';

describe('Yijiang Express live retrieval', () => {
  it('retrieves the waybill history', async () => {
    const result = await new YijiangTracker().fetch(NUMBER);
    expect(result.events!.length).toBeGreaterThan(0);
    // Every row is dated on China's clock, none after the lookup.
    expect(result.events!.every((event) => event.description && event.local_time && event.time?.endsWith('+08:00')
      && Date.parse(event.time) <= Date.now())).toBe(true);
    expect(result.last_update).toBe(result.events![0]!.time);
  }, 30_000);

  it('reads an unknown waybill as not found', async () => {
    await expect(new YijiangTracker().fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
