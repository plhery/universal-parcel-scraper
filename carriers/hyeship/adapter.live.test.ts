import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.HYESHIP_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Hongyuan Express live retrieval', () => {
  it('retrieves the waybill history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'hyeship' });
    expect(answer).toMatchObject({ carrier: 'hyeship', source: 'hyeship' });
    expect(answer.attempts[0]).toMatchObject({ source: 'hyeship', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
    // The courier's mobile never reaches the result.
    expect(JSON.stringify(result).replaceAll(NUMBER, '')).not.toMatch(/(?<!\d)1[3-9]\d{9}(?!\d)/);
  }, 30_000);

  it('reads an unknown waybill as not found', async () => {
    const unknown = process.env.HYESHIP_UNKNOWN_NUMBER ?? 'ZZ999999990US';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});
