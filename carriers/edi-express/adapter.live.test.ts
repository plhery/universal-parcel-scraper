import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.EDI_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('EDI Express live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'edi-express' });
    expect(answer).toMatchObject({ carrier: 'edi-express', source: 'edi-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'edi-express', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    for (const event of result.events) expect(event.local_time).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (!process.env.EDI_EXPRESS_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', destination_country: 'US' });
      expect(result.events.length).toBeGreaterThan(1);
    }
  }, 45_000);

  it('reads a PRO number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.EDI_EXPRESS_UNKNOWN_NUMBER ?? '000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
