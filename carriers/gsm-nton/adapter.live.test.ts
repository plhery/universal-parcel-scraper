import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another bill is given.
const NUMBER = process.env.GSM_NTON_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('GSM NtoN live retrieval', () => {
  it('retrieves the requested bill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'gsm-nton' });
    expect(answer).toMatchObject({ carrier: 'gsm-nton', source: 'gsm-nton' });
    expect(answer.attempts[0]).toMatchObject({ source: 'gsm-nton', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows on their stations' wall clocks, none in the future.
    expect(result.events.every((event) => event.provider_code && event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it.skipIf(!process.env.GSM_NTON_UNKNOWN_NUMBER)('reads an unknown bill as not found', async () => {
    await expect(direct().track({ number: process.env.GSM_NTON_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
