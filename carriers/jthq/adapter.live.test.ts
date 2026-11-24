import { describe, expect, it } from 'vitest';
import { JthqTracker } from './adapter.js';

// A number in JTHQ's layout whose serial sits below the range in use.
const UNKNOWN = process.env.JTHQ_UNKNOWN_NUMBER ?? 'JTHQ000000000000';

describe('JTHQ live retrieval', () => {
  it.skipIf(!process.env.JTHQ_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new JthqTracker().fetch(process.env.JTHQ_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan states its offset, none still ahead of the lookup.
    expect(result.events!.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
    expect(result.events!.some((event) => event.time?.endsWith('+08:00'))).toBe(true);
  }, 30_000);

  it('reads an unknown waybill as not found', async () => {
    await expect(new JthqTracker().fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
