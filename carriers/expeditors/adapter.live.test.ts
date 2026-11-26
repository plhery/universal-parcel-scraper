import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The guest search drops a shipment some months after it ends, so the public samples age out one by one.
const SAMPLES = process.env.EXPEDITORS_TRACKING_NUMBER ? [process.env.EXPEDITORS_TRACKING_NUMBER]
  : numbers.records.filter((record) => record.role === 'shipment' && record.context.assessment === 'confirmed').map((record) => record.number);

describe('Expeditors live retrieval', () => {
  it('retrieves a public shipment on its local clocks', async (context) => {
    for (const number of SAMPLES) {
      const result = await direct().track({ number }).catch((error: unknown) => {
        if ((error as { kind?: string }).kind === 'not_found') return null;
        throw error;
      });
      if (!result) continue;
      expect(result.events!.length).toBeGreaterThan(0);
      // Every scan is an instant with its offset, and none is in the future.
      expect(result.events!.every((event) => event.description && !event.local_time
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time))
        && Date.parse(String(event.time)) <= Date.now())).toBe(true);
      return;
    }
    context.skip('Expeditors guest search no longer holds the public samples: add a fresher one to numbers.json');
  }, 60_000);

  it('reads an unknown reference as not found', async () => {
    const unknown = process.env.EXPEDITORS_UNKNOWN_NUMBER ?? '99Z9999999';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
