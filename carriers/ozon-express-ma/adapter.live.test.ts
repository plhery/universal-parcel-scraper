import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.OZON_EXPRESS_MA_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Ozon Express live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'ozon-express-ma' });
    expect(answer).toMatchObject({ carrier: 'ozon-express-ma', source: 'ozon-express-ma' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ozon-express-ma', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Wall clocks in Morocco, without an offset.
    for (const event of result.events) expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))).toBe(true);
    if (!process.env.OZON_EXPRESS_MA_TRACKING_NUMBER) expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Livré' });
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.OZON_EXPRESS_MA_UNKNOWN_NUMBER ?? 'ZZZ000000000ZZ' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
