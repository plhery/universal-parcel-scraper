import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered Rodo Aéreo minuta with its flights, unless another number is given.
const NUMBER = process.env.RODONAVES_TRACKING_NUMBER ?? numbers.records[1]!.number;

describe('Rodonaves live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'rodonaves' });
    expect(answer).toMatchObject({ carrier: 'rodonaves', source: 'rodonaves' });
    expect(answer.attempts[0]).toMatchObject({ source: 'rodonaves', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every event keeps the wall clock Rodonaves gives without a zone.
    for (const event of result.events) expect(event.local_time ?? event.time).toEqual(expect.any(String));
    if (!process.env.RODONAVES_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', service_name: 'Rodo Aéreo ECO' });
      expect(result.events).toContainEqual(expect.objectContaining({ description: 'EMBARQUE NO VOO (GRU)', location: 'GRU', stage: 'in_transit' }));
    }
  }, 45_000);

  it('reads a number neither system holds as not found', async () => {
    await expect(direct().track({ number: process.env.RODONAVES_UNKNOWN_NUMBER ?? '999999999' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
