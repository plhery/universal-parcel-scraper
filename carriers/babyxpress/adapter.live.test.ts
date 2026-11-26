import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another consignment is given.
const NUMBER = process.env.BABYXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('BabyXpress live retrieval', () => {
  it('retrieves the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'babyxpress' });
    expect(answer).toMatchObject({ carrier: 'babyxpress', source: 'babyxpress' });
    expect(answer.attempts[0]).toMatchObject({ source: 'babyxpress', kind: 'ok' });
    const { result } = answer;
    expect(result.provider_code).toMatch(/^\d{1,4}$/);
    // Scans at the instant the platform wrote them, none in the future.
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.provider_code && event.time?.endsWith('Z') && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it('reads an unknown consignment as not found', async () => {
    await expect(direct().track({ number: process.env.BABYXPRESS_UNKNOWN_NUMBER ?? 'SC9900001' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
