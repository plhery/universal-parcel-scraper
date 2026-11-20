import { describe, expect, it } from 'vitest';
import { RunforintTracker } from './adapter.js';

describe('Runforint live retrieval', () => {
  it.skipIf(!process.env.RUNFORINT_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new RunforintTracker().fetch(process.env.RUNFORINT_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && (event.time || event.local_time))).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.RUNFORINT_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    // The service refuses a lookup sent within a second or so of another.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await expect(new RunforintTracker().fetch(process.env.RUNFORINT_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
