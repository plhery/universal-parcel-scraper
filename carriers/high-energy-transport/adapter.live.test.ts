import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another order number is given.
const NUMBER = process.env.HIGH_ENERGY_TRANSPORT_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('High Energy Transport live retrieval', () => {
  it('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'high-energy-transport' });
    expect(answer).toMatchObject({ carrier: 'high-energy-transport', source: 'high-energy-transport' });
    expect(answer.attempts[0]).toMatchObject({ source: 'high-energy-transport', kind: 'ok' });
    expect(answer.result.provider_code).toMatch(/^[a-z_]+$/);
    expect(answer.result.last_status_text).toBeTruthy();
  });

  it('reads an unknown order as not found', async () => {
    await expect(direct().track({ number: process.env.HIGH_ENERGY_TRANSPORT_UNKNOWN_NUMBER ?? 'ZZ99887766' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
