import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, WP_GROUND_ENDPOINT, WpGroundTracker } from './adapter.js';
import { parseWpGround } from './parser.js';

const NUMBER = 'WPG0000000001';
type Row = { trackingNumber?: string; trackTime?: string; nodeCode?: string; trackAddress?: string; remarks?: string };
const row = (overrides: Row = {}): Row => ({ trackingNumber: NUMBER, trackTime: '2026-03-12 14:30:52', nodeCode: 'Synthetic node',
  trackAddress: 'Los Angeles, CA', remarks: 'Arrived at the sorting center', ...overrides });
const answer = (list: unknown[]) => ({ success: true, code: 200, message: 'ok', data: { type: 1, list,
  trackFiles: [{ trackingNumber: NUMBER, path: 'PRIVATE proof' }],
  trackAddress: { senderInfo: [{ trackingNumber: NUMBER, osaCity: 'PRIVATE sender city' }], receiverInfo: [{ trackingNumber: NUMBER, oraCity: 'PRIVATE recipient city' }] },
  sizeAndWeight: [{ trackingNumber: NUMBER, ordersWeight: 9, weightUnit: 'lb' }] } });
const scans = [
  row({ trackTime: '2026-03-13 09:05:00', trackAddress: '123 Private Street, Pasadena, CA 91101', remarks: 'Delivered', nodeCode: 'Delivered' }),
  row({ trackTime: '2026-03-13 07:10', trackAddress: 'Los Angeles, CA 90001', remarks: 'Out for delivery' }),
  row(),
];
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'SyntheticHost/1.0' });

describe('WP Ground tracking', () => {
  it('reads the scans as wall clocks with their places, and nothing about the people or the parcel', () => {
    const result = parseWpGround(answer(scans), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-03-13T09:05:00' });
    expect(result.events).toEqual([
      { local_time: '2026-03-13T09:05:00', description: 'Delivered', provider_code: 'Delivered', stage: 'delivered', stage_source: expect.any(String) },
      { local_time: '2026-03-13T07:10:00', description: 'Out for delivery', provider_code: 'Synthetic node', location: 'Los Angeles, CA',
        stage: 'out_for_delivery', stage_source: expect.any(String) },
      { local_time: '2026-03-12T14:30:52', description: 'Arrived at the sorting center', provider_code: 'Synthetic node', location: 'Los Angeles, CA',
        stage: expect.any(String), stage_source: expect.any(String) },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Private|91101|90001|weight/);
  });

  it('takes an empty list as the tracker\'s "No Data", and only the requested number\'s rows', () => {
    expect(() => parseWpGround(answer([]), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseWpGround(answer([row({ trackingNumber: 'WPG0000000002' })]), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseWpGround(answer([row({ trackingNumber: 'WPG0000000002', remarks: 'Other parcel' }), row()]), NUMBER).events).toHaveLength(1);
  });

  it('flags a history only when distinct scans exceed the cap', () => {
    const rows = Array.from({ length: 101 }, (_, i) => row({ remarks: `Movement ${i}` }));
    expect(parseWpGround(answer(rows), NUMBER).history_truncated).toBe(true);
    expect(parseWpGround(answer([...rows.slice(0, 100), rows[0]!]), NUMBER).history_truncated).toBeFalsy();
  });

  it('keeps refusals and changed answers apart from absence', () => {
    expect(() => parseWpGround({ success: false, message: 'busy' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWpGround({ success: true, data: {} }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const broken of [row({ trackTime: '13/03/2026 09:05' }), row({ remarks: '', nodeCode: '' })]) {
      expect(() => parseWpGround(answer([broken]), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const unmapped = parseWpGround(answer([row({ remarks: 'Synthetic unmapped wording', nodeCode: '' })]), NUMBER);
    expect(unmapped).toMatchObject({ status: 'unknown' });
    expect(unmapped.events![0]!.stage).toBeUndefined();
  });

  it('posts the one number as the tracker does, over the supplied transport and signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(answer(scans)));
    await expect(carrier(fetcher).track({ number: ` ${NUMBER.toLowerCase()} ` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls[0]![0]).toBe(WP_GROUND_ENDPOINT);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: `trackNumberList=${NUMBER}`, signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    await expect(new WpGroundTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(carrier(fetcher).track({ number: 'WPG,1' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('tells a block page from a changed answer', async () => {
    const page = (html: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response(html))).track({ number: NUMBER });
    await expect(page('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(page('<html><title>WPG</title></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[404, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i as %s', async (status, kind) => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }))).track({ number: NUMBER })).rejects.toMatchObject({ kind });
  });
});
