import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The tracking page's sample AWB, unless another is given.
const NUMBER = process.env.CAUTCURIER_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('CautCurier live retrieval', () => {
  it('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'cautcurier' });
    expect(answer).toMatchObject({ carrier: 'cautcurier', source: 'cautcurier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'cautcurier', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // UTC instants, none in the future, each with its type.
    expect(events.every((event) => event.provider_code && event.description && /Z$/.test(String(event.time))
      && Date.parse(String(event.time)) <= Date.now())).toBe(true);
    expect(answer.result.current_stage).toBeDefined();
  }, 45_000);

  it.skipIf(!process.env.CAUTCURIER_UNKNOWN_NUMBER)('reads an unknown AWB as not found', async () => {
    await expect(direct().track({ number: process.env.CAUTCURIER_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
