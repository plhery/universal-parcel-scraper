import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const example = fixture('example.json');
const awb = '48504606350';

describe('Astral Aviation cargo tracking', () => {
  it('replays the one dated booking and the two observed departures', () => {
    expect(parseTracking(example, awb)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'explicit_mapping',
      last_status_text: 'Departed', last_update: '2023-05-26T09:00:31.166Z',
      expected_delivery: null,
      events: [
        { time: '2023-05-26T09:00:31.166Z', location: 'DWC', description: 'Goods departed', provider_code: 'FSUDEP',
          stage: 'in_transit', stage_source: 'explicit_mapping' },
        { time: '2023-05-25T09:10:30.275Z', location: 'DWC', description: 'Goods departed', provider_code: 'FSUDEP',
          stage: 'in_transit', stage_source: 'explicit_mapping' },
        { local_time: '2023-05-25', description: 'Shipment booked on a specific flight', provider_code: 'FSUBKD',
          stage: 'registered', stage_source: 'explicit_mapping' },
      ],
    });
  });

  it('verifies both the shipment and the waybill on every retained message', () => {
    expect(() => parseTracking(example, '48500000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mismatched = example.replace('"awbno": "' + awb + '"', '"awbno": "48500000000"');
    expect(() => parseTracking(mismatched, awb)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a blank reply inconclusive and recognises unexpected JSON or an interstitial', () => {
    expect(() => parseTracking(fixture('empty.txt'), awb)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('{"error":"temporarily unavailable"}', awb)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', awb)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('sends the whole air waybill with the caller’s user agent and signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({
      fetcher, userAgent: 'Astral Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: '485-04606350' }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://fr8manage.app/dashboard-widget-detail/awbTracking?awbNo=48504606350&userSchema=gsatier2'),
      expect.objectContaining({ signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'Astral Test' }) }),
    );
  });
});
