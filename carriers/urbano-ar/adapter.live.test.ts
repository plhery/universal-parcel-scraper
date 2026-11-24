import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.URBANO_AR_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Urbano Argentina live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'urbano-ar' });
    expect(answer).toMatchObject({ carrier: 'urbano-ar', source: 'urbano-ar' });
    expect(answer.attempts[0]).toMatchObject({ source: 'urbano-ar', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    for (const event of result.events) expect(event.local_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
    if (!process.env.URBANO_AR_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Su envio fue entregado' });
    }
  }, 45_000);

  it('reads a code the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.URBANO_AR_UNKNOWN_NUMBER ?? '22730000000099999990' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
