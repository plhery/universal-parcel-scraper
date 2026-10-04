import { describe, expect, it } from 'vitest';
import { NovaPoshtaTracker } from './adapter.js';
describe('Nova Poshta live tracking', () => {
  it.skipIf(!process.env.NOVA_POSHTA_TRACKING_NUMBER)('returns a Ukrainian shipment summary', async () => {
    const result = await new NovaPoshtaTracker().fetch(process.env.NOVA_POSHTA_TRACKING_NUMBER!);
    expect(result.summary_only).toBe(true); expect(result.last_status_text).toEqual(expect.any(String));
  });
});
