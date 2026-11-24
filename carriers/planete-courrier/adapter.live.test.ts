import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another order number is given.
const NUMBER = process.env.PLANETE_COURRIER_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Planète Courrier live retrieval', () => {
  it('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'planete-courrier' });
    expect(answer).toMatchObject({ carrier: 'planete-courrier', source: 'planete-courrier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'planete-courrier', kind: 'ok' });
    expect(answer.result.events?.length).toBeGreaterThan(0);
    expect(answer.result.last_status_text).toBeTruthy();
  });

  it('reads an invented order number as not found', async () => {
    await expect(direct().track({ number: process.env.PLANETE_COURRIER_UNKNOWN_NUMBER ?? '19999991' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
