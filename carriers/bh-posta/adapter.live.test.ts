import { describe, expect, it } from 'vitest';
import { BhPostaTracker } from './adapter.js';

describe('BH Pošta guest tracking', () => {
  it.skipIf(!process.env.BH_POSTA_TRACKING_NUMBER)('reads whole-bound dated history', async () => {
    const result = await new BhPostaTracker().fetch(process.env.BH_POSTA_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
  }, 25_000);
});
