import { describe, expect, it } from 'vitest';
import { GelTracker } from './adapter.js';

describe('GEL Express live direct retrieval', () => {
  it.skipIf(!process.env.GEL_EXPRESS_TRACKING_NUMBER)('retrieves the current status', async () => {
    const result = await new GelTracker().fetch(process.env.GEL_EXPRESS_TRACKING_NUMBER!);
    expect(result.events).toHaveLength(1);
    expect(result.events![0]).toMatchObject({ time: expect.any(String), description: expect.any(String) });
    expect(result.last_status_text).toBeTruthy();
  });
  it.skipIf(!process.env.GEL_EXPRESS_UNKNOWN_NUMBER)('identifies the not-found answer', async () => {
    await expect(new GelTracker().fetch(process.env.GEL_EXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
