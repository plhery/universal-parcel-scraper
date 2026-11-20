import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');
const number = 'PNJ62131222';

describe('Parcelninja guest waybill tracking', () => {
  it('reads dated scans without incorporating the signer', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2023-04-21T10:28:46',
    });
    expect(result.events?.map(event => [event.description, event.local_time, event.stage])).toEqual([
      ['Delivered', '2023-04-21T10:28:46', 'delivered'],
      ['Delivered', '2023-04-21T10:28:00', 'delivered'],
      ['Out for delivery', '2023-04-21T09:54:00', 'out_for_delivery'],
      ['Out for delivery', '2023-04-21T09:43:13', 'out_for_delivery'],
      ['Routing delivery', '2023-04-20T18:53:52', 'in_transit'],
      ['Collected By Courier', '2023-04-20T09:46:37', 'accepted'],
      ['Collected By Courier', '2023-04-20T09:46:00', 'accepted'],
      ['Submitted To Courier', '2023-04-20T09:19:16', 'registered'],
      ['Waybill Printed', '2023-04-20T09:19:16', 'registered'],
      ['Shipment Created', '2023-04-20T09:19:14', 'registered'],
    ]);
  });

  it('distinguishes an absent shipment from an unbound or changed result', () => {
    expect(() => parseTracking(fixture('missing'), 'ZZZZ000000000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(example, 'PNJ00000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('<title>ParcelNinja</title>', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('performs one public GET with the waybill and caller signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({
      fetcher, userAgent: 'Parcelninja Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: number.toLowerCase() }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://store.parcelninja.com/tracking.aspx?WaybillNo=PNJ62131222'),
      expect.objectContaining({ signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'Parcelninja Test' }) }),
    );
  });
});
