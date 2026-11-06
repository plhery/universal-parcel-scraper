import { describe, expect, it } from 'vitest';
import { PostOneTracker } from './adapter.js';

describe('Post One guest tracking live', () => {
  it.skipIf(!process.env.POST_ONE_TRACKING_NUMBER)('reads the whole bound item history', async () => {
    const result = await new PostOneTracker().fetch(process.env.POST_ONE_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
  });
  it.skipIf(!process.env.POST_ONE_UNKNOWN_NUMBER)('keeps the exact home redirect separate', async () => {
    await expect(new PostOneTracker().fetch(process.env.POST_ONE_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
