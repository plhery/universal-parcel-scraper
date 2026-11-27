import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given. TTK Europe's numbers run in dense sequences, so the
// unknown one is invented far from any range seen.
const POSITIVE = process.env.TTK_EUROPE_TRACKING_NUMBER ?? numbers.records[0]!.number;
const UNKNOWN = process.env.TTK_EUROPE_UNKNOWN_NUMBER ?? 'TE900000005GB';

describe('TTK Europe live retrieval', () => {
  it('retrieves the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: POSITIVE, carrier: 'ttk-europe' });
    expect(answer).toMatchObject({ carrier: 'ttk-europe', source: 'ttk-europe' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ttk-europe', kind: 'ok' });
    const { result } = answer;
    expect(result.current_stage).toBeTruthy();
    expect(result.events.length).toBeGreaterThan(0);
    // Every row keeps its wall clock; a placed one is dated on its place's clock, none ahead of the read.
    const now = new Date().toISOString();
    expect(result.events.every((event) => event.description && event.local_time && (!event.time || event.time <= now))).toBe(true);
    expect(result.events.some((event) => event.time_zone_basis === 'place')).toBe(true);
  }, 45_000);

  it('reads a number the tracker has no parcel under as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
