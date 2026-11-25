import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, QqwyTracker } from './adapter.js';
import { parseQqwyPage, parseQqwyTrack, QQWY_ORIGIN, qqwyClock } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a later capture of a tracking directory's QQWY page, and a number in a
// shape the tracker cannot hold.
const NUMBER = 'DYY666910851XB';
const UNKNOWN = 'ZZ0000000000ZZ';
// UniUni's number, which the record holds as its transfer number, and the line's own waybill.
const UNIUNI = 'UUS5C92502603020525';
const WAYBILL = 'SZZT20251206144134183';
// The SpeedX number of the directory page's earlier sample, whose line names it in a row.
const SPEEDX = 'SPXJFK086000122418';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
type Row = Record<string, string | null>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, content: string, location = '', code = '') => ({ clock, content, location, code });

/**
 * The fixture's record with the earlier sample's kind of rows in place of its own: the line's
 * rows in China and at New York's airport, its row naming SpeedX's number and SpeedX's own.
 */
function speedx(transfer: string): Reply {
  const reply = fixture('delivered');
  const record = reply[0].data[0];
  const template: Row = record.trackDetails[0];
  const rows: [string, string, string, string, string][] = [
    ['2025-07-25 05:20:47', '2025-07-25 17:42:02', '', 'Bronx, NY 10459', 'Delivered. Position: Meet customer'],
    ['2025-07-23 09:25:36', '2025-07-23 22:09:31', '', 'Linden, NJ 07036', 'Processing at Designated Facility'],
    ['2025-07-23 00:56:00', '2025-07-23 22:09:31', '', 'JFK', 'Delivery to local courier'],
    ['2025-07-17 15:07:59', '2025-07-17 23:24:27', '', '', `Last mile, tracking number ${SPEEDX}`],
    ['2025-07-17 11:46:08', '2025-07-17 23:24:27', '', 'DONGGUAN', 'Departed from Facility'],
    ['2025-07-16 16:48:52', '2025-07-16 16:48:52', 'ARRIVAL', '深圳', '到达收货点'],
    ['2025-06-29 09:11:19', '2025-07-16 16:48:52', '', '', '货物电子信息已经收到'],
  ];
  record.trackDetails = rows.map(([date, written, kind, location, content], index) => ({
    ...template, track_id: String(index + 1), track_date: date, track_createdate: written, track_kind: kind,
    track_location: location, track_content: content,
  }));
  record.business_channeltransfercode = transfer;
  record.productKindName = '美国Parcel Express小包';
  return reply;
}

describe('Global Security numbers', () => {
  it('claims no number by its shape and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://www.qqwy56.com:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'qqwy' });
  });
});

describe('Global Security tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new QqwyTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase()))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'US' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${QQWY_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(QQWY_ORIGIN).toBe('http://www.qqwy56.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'qqwy', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('hands the parcel to UniUni and keeps the copied rows on their wall clocks without their Chinese copies', () => {
    const result = parseQqwyTrack(fixture('delivered'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2025-12-19T14:55:37', service_name: 'DYY-T11', destination_country: 'US',
      delivery_carrier: 'uniuni', delivery_tracking_number: UNIUNI,
    });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.events!.map(({ time, local_time: local, location, description, stage }) => [time ?? local, location, description, stage])).toEqual([
      ['2025-12-19T14:55:37', 'Shoreline WA', 'Delivered', 'delivered'],
      ['2025-12-18T17:05:59', 'Shoreline WA', 'Out for delivery', 'out_for_delivery'],
      ['2025-12-17T21:40:05', 'Shoreline WA', 'Failed delivery attempt, returning to the warehouse. (Contact Failed and Inaccessible)', 'failed_attempt'],
      ['2025-12-16T15:07:36', 'Shoreline WA', 'Out for delivery', 'out_for_delivery'],
      ['2025-12-15T15:21:13', 'Shoreline WA', 'Failed delivery attempt, returning to the warehouse. (Business Closed)', 'failed_attempt'],
      ['2025-12-15T08:35:53', 'Shoreline WA', 'Out for delivery', 'out_for_delivery'],
      ['2025-12-15T08:15:08', 'Seattle WA', 'Arrival scan', 'in_transit'],
      ['2025-12-12T16:40:03', 'Los Angeles CA', 'Gateway transit in', 'in_transit'],
      ['2025-12-09T20:14:20', undefined, 'Departed from Facility', 'in_transit'],
      ['2025-12-09T18:58:34', '深圳', 'Shipment arrived at facility', 'accepted'],
      ['2025-12-09T17:55:28', undefined, 'Shipment information received', 'registered'],
      ['2025-12-09T09:55:27', 'UNI DATA CENTER', 'Order received', 'registered'],
      ['2025-11-24T09:09:23+08:00', undefined, 'The electronic information of the goods has been received.', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toContain('中文');
    for (const number of [WAYBILL, UNIUNI]) {
      expect(parseQqwyTrack(fixture('delivered'), number, READ_AT)).toMatchObject({ canonical_tracking_number: NUMBER, delivery_carrier: 'uniuni' });
    }
  });

  it('keeps the line’s rows on Beijing’s clock, shows its Chinese ones in English and reads its last-mile row as a notice', () => {
    const result = parseQqwyTrack(speedx(SPEEDX), NUMBER, READ_AT)!;
    expect(result).toMatchObject({ delivery_carrier: 'speedx', delivery_tracking_number: SPEEDX, service_name: 'US Parcel Express Small Parcel' });
    expect(result.events!.map(({ time, local_time: local, location, description, stage, provider_code: code }) => [time ?? local, location, description, stage, code]))
      .toEqual([
        ['2025-07-25T05:20:47', 'Bronx, NY', 'Delivered. Position: Meet customer', 'delivered', undefined],
        ['2025-07-23T09:25:36', 'Linden, NJ', 'Processing at Designated Facility', 'in_transit', undefined],
        ['2025-07-23T00:56:00+08:00', 'JFK', 'Delivery to local courier', 'in_transit', undefined],
        ['2025-07-17T15:07:59+08:00', undefined, `Last mile, tracking number ${SPEEDX}`, 'in_transit', undefined],
        ['2025-07-17T11:46:08+08:00', 'DONGGUAN', 'Departed from Facility', 'in_transit', undefined],
        ['2025-07-16T16:48:52+08:00', '深圳', 'Arrived at the collection point', 'accepted', 'ARRIVAL'],
        ['2025-06-29T09:11:19+08:00', undefined, 'Shipment information received', 'registered', undefined],
      ]);
    // Without a transfer number, the line's row names the carrier's number, which SpeedX claims whole.
    expect(parseQqwyTrack(speedx(''), NUMBER, READ_AT)).toMatchObject({ delivery_carrier: 'speedx', delivery_tracking_number: SPEEDX });
    expect([row('2025-07-24 02:05:54', 'Processing at Designated Facility', 'Springfield Gardens, NY 11413'),
      row('2025-12-09 18:58:34', 'Shipment arrived at facility(中文:快件到达作业中心)', '深圳'),
      row('2025-07-21 10:04:00', 'Flight Arrived', 'JFK'), row('2025-07-18 04:32:00', 'Arrived at AIRPORT of Origin', 'SZX'),
      row('2025-12-09 09:55:27', 'Order received', 'UNI DATA CENTER')].map(qqwyClock))
      .toEqual(['wall', 'wall', 'platform', 'platform', 'platform']);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseQqwyTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${QQWY_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseQqwyPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['DYY00', `${NUMBER},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'true', data: {} }])))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'false', message: '系统繁忙' }])))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('maps every wording it lists, whatever place, reason or number it names, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)) ?? null, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'qqwy', description: 'Delivered. Position: Front door' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'qqwy', description: 'Failed delivery attempt, returning to the warehouse. (Business Closed)' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'qqwy', providerCode: 'ARRIVAL', description: '到达收货点' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'qqwy', description: `Last mile, tracking number ${SPEEDX}` })).toMatchObject({ kind: 'intentional_gap' });
  });
});
