import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.GJSGUOJI_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('GJS Express live retrieval', () => {
  it('retrieves the parcel history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'gjsguoji' });
    expect(answer).toMatchObject({ carrier: 'gjsguoji', source: 'gjsguoji' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gjsguoji', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
    expect(JSON.stringify(result.events)).not.toMatch(/(?<!\d)1[3-9]\d{9}(?!\d)/);
  }, 45_000);

  it('reads an unknown parcel as not found', async () => {
    const unknown = process.env.GJSGUOJI_UNKNOWN_NUMBER ?? 'GJS888260399001';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
