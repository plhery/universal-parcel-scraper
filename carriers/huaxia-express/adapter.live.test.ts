import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.HUAXIA_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Huaxia Express live retrieval', () => {
  it('retrieves the waybill history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'huaxia-express' });
    expect(answer).toMatchObject({ carrier: 'huaxia-express', source: 'huaxia-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'huaxia-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
    // The public sample's record names SF Express and its number.
    if (!process.env.HUAXIA_EXPRESS_TRACKING_NUMBER) expect(result).toMatchObject({ delivery_carrier: 'sf-express' });
  }, 30_000);

  it('reads an unknown waybill as not found', async () => {
    const unknown = process.env.HUAXIA_EXPRESS_UNKNOWN_NUMBER ?? 'HE1000999990';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
