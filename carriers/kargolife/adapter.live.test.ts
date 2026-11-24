import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another order number is given.
const NUMBER = process.env.KARGOLIFE_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Kargolife live retrieval', () => {
  it('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'kargolife' });
    expect(answer).toMatchObject({ carrier: 'kargolife', source: 'kargolife' });
    expect(answer.attempts[0]).toMatchObject({ source: 'kargolife', kind: 'ok' });
    expect(answer.result).toMatchObject({ summary_only: true, events: [] });
    expect(answer.result.last_status_text).toBeTruthy();
  });

  it('reads an invented order number as not found', async () => {
    await expect(direct().track({ number: process.env.KARGOLIFE_UNKNOWN_NUMBER ?? '99999999901' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
