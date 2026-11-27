import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.BVC_LOGISTICS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('BVC Logistics live retrieval', () => {
  it('retrieves the shipping note and its history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'bvc-logistics' });
    expect(answer).toMatchObject({ carrier: 'bvc-logistics', source: 'bvc-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'bvc-logistics', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Instants on India's clock, none in the future.
    expect(events.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+05:30$/.test(String(event.time))
      && Date.parse(String(event.time)) <= Date.now() && event.description)).toBe(true);
  }, 45_000);

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BVC_LOGISTICS_UNKNOWN_NUMBER ?? 'DS9907413' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
