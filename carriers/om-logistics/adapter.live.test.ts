import { describe, expect, it } from 'vitest';
import { OmLogisticsTracker } from './adapter.js';

describe('Om Logistics live guest retrieval', () => {
  it.skipIf(!process.env.OM_LOGISTICS_TRACKING_NUMBER)('retrieves whole-bound history through the SVG verification form', async () => {
    const result = await new OmLogisticsTracker().fetch(process.env.OM_LOGISTICS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description && !event.time)).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.OM_LOGISTICS_UNKNOWN_NUMBER)('does not finalize the bare upstream error as not-found', async () => {
    await expect(new OmLogisticsTracker().fetch(process.env.OM_LOGISTICS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 30_000);
});
