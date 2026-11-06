import { describe, expect, it } from 'vitest';
import { SkladusaTracker } from './adapter.js';

describe('SkladUSA public guest tracking', () => {
  it.skipIf(!process.env.SKLADUSA_TRACKING_NUMBER)('reads the scoped whole-reference history', async () => {
    const result = await new SkladusaTracker().fetch(process.env.SKLADUSA_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && !event.event_time)).toBe(true);
  });
  it.skipIf(!process.env.SKLADUSA_UNKNOWN_NUMBER)('keeps the empty guest reply indeterminate', async () => {
    await expect(new SkladusaTracker().fetch(process.env.SKLADUSA_UNKNOWN_NUMBER!))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'expired_or_unknown' });
  });
});
