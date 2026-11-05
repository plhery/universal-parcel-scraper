import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.EXPEDICO_TRACKING_NUMBER;
const unknown = process.env.EXPEDICO_UNKNOWN_NUMBER;
const partner = process.env.EXPEDICO_PARTNER_NUMBER;

describe('Expedico live retrieval', () => {
  it.skipIf(!partner)('binds the recorded partner alias without changing its barcode', async () => {
    const result = await direct().track({ number: partner! });
    expect(result.delivery_tracking_number).toBe(partner);
    expect(result.events!.length).toBeGreaterThan(0);
  });
  it.skipIf(!number)('reads the whole reference and its dated history', async () => {
    const result = await direct().track({ number: number! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && (event.local_time || event.time))).toBe(true);
  });

  it.skipIf(!unknown)('retains the explicit absence signature', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
