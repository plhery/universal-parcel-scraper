import { describe, expect, it } from 'vitest';
import { DoraGateTracker } from './adapter.js';

describe('Dora Gate live retrieval', () => {
  it.skipIf(!process.env.DORA_GATE_TRACKING_NUMBER)('retrieves the waybill history', async () => {
    const result = await new DoraGateTracker().fetch(process.env.DORA_GATE_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.description && event.local_time)).toBe(true);
    // AnserX's own scans carry their code and Beijing's offset.
    expect(result.events!.filter((event) => event.provider_code).every((event) => event.time_zone === 'Asia/Shanghai')).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.DORA_GATE_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await expect(new DoraGateTracker().fetch(process.env.DORA_GATE_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
