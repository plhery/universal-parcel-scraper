import { describe, expect, it } from 'vitest';
import { ProfitFieldsTracker } from './adapter.js';

describe('Profit Fields live retrieval', () => {
  it.skipIf(!process.env.PROFIT_FIELDS_TRACKING_NUMBER)('reads matching dated history', async () => {
    const result = await new ProfitFieldsTracker().fetch(process.env.PROFIT_FIELDS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && (event.local_time || event.time))).toBe(true);
  });

  it.skipIf(!process.env.PROFIT_FIELDS_UNKNOWN_NUMBER)('retains the exact absence signature', async () => {
    await expect(new ProfitFieldsTracker().fetch(process.env.PROFIT_FIELDS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
