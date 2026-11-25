import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The international public sample, unless another number is given.
const NUMBER = process.env.XPRESS_COURIER_LINK_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('ECL live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'xpress-courier-link' });
    expect(answer).toMatchObject({ carrier: 'xpress-courier-link', source: 'xpress-courier-link' });
    expect(answer.attempts[0]).toMatchObject({ source: 'xpress-courier-link', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every scan keeps its wall clock.
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.XPRESS_COURIER_LINK_TRACKING_NUMBER) {
      expect(result).toMatchObject({ destination_country: 'AE' });
      expect(result.events.length).toBeGreaterThan(10);
      expect(JSON.stringify(result)).not.toMatch(/SHIPPER|CONSIGNEE/);
    }
  }, 60_000);

  it('reads a number neither service knows as not found', async () => {
    await expect(direct().track({ number: process.env.XPRESS_COURIER_LINK_UNKNOWN_NUMBER ?? 'EC9900000017' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});
