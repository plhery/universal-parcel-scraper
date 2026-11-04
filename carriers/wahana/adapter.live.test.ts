import { describe, expect, it } from 'vitest';
import { WahanaTracker } from './adapter.js';

describe('Wahana live retrieval', () => {
  it.skipIf(!process.env.WAHANA_TEST_NUMBER)('reads the whole resi through a fresh image challenge', async () => {
    const tracker = new WahanaTracker();
    try {
      const result = await tracker.fetch(process.env.WAHANA_TEST_NUMBER!);
      expect(result.events?.length).toBeGreaterThan(0);
      expect(result.events?.every(event => event.description && event.local_time)).toBe(true);
      expect(result.last_update_local).toBeTruthy();
    } finally { await tracker.close(); }
  });

  it.skipIf(!process.env.WAHANA_UNKNOWN_NUMBER)('distinguishes the portal miss from verification refusal', async () => {
    const tracker = new WahanaTracker();
    try { await expect(tracker.fetch(process.env.WAHANA_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' }); }
    finally { await tracker.close(); }
  });
});
