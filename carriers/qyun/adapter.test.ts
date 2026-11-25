import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, QyunTracker } from './adapter.js';
import { isQyunImileRow, parseQyunPage, parseQyunTrack, QYUN_ORIGIN, qyunClock, splitQyunRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from a tracking directory's Qyun page, iMile's waybill, and a number in a shape
// the tracker cannot hold.
const NUMBER = '6013025456576';
const UNKNOWN = 'ZZ0000000000ZZ';
// The forwarder's own waybill and the shipper's reference, which the record holds beside iMile's number.
const WAYBILL = 'CI2023103020250217150140800';
const REFERENCE = '892502965672346';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-25T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, content: string, location = '', code = '') => ({ clock, content, location, code });

describe('Qyun Express numbers', () => {
  it('leaves the iMile waybill to detection and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('qyun');
    expect(parseTrackingInput(`http://106.52.192.65:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'qyun' });
  });
});

describe('Qyun Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('compensated')));
    await expect(new QyunTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER} `))
      .resolves.toMatchObject({ current_stage: 'exception', destination_country: 'MX' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${QYUN_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(QYUN_ORIGIN).toBe('http://106.52.192.65:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'qyun', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the rows on Beijing’s clock, the line’s hand-written ones by their day, without iMile’s categories or its copy of the receipt', async () => {
    const result = parseQyunTrack(fixture('compensated'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', last_status_text: 'Abnormal LT',
      last_update: '2025-04-05T01:31:31+08:00', service_name: '墨西哥免税专线普货', destination_country: 'MX',
    });
    // The waybill is iMile's, whose scans the record copies: iMile delivers the parcel under the number asked.
    expect(result).toMatchObject({ delivery_carrier: 'imile' });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events!.map(({ time, local_time: local, location, description, stage, provider_code: code }) => [time ?? local, location, description, stage, code]))
      .toEqual([
        ['2025-04-05T01:31:31+08:00', 'Mexico Center', 'Abnormal LT', 'exception', undefined],
        ['2025-02-26T14:20:30+08:00', 'Mexico Center', 'Arrived at the transit point.', 'in_transit', undefined],
        ['2025-02-26T14:10:31+08:00', 'HQ-MEX.DS', '【HQ-MEX.DS】Received.', 'in_transit', undefined],
        ['2025-02-23', 'ciudad de mexico', 'Arrived at destination airport', 'in_transit', undefined],
        ['2025-02-22', 'hongkong', 'Departure from the original airport', 'in_transit', undefined],
        ['2025-02-19', 'hongkong', 'Arrived at the port of departure', 'in_transit', undefined],
        ['2025-02-19', 'hongkong', 'Customs Clearance Completed', 'in_transit', undefined],
        ['2025-02-17T16:00:41+08:00', 'shenzhen', 'Your order has been shipped from 【shenzhen】.', 'in_transit', undefined],
        ['2025-02-17T16:00:41+08:00', 'shenzhen', 'Departed from Facility in Shenzhen.', 'in_transit', 'SHIPMENT'],
        ['2025-02-17T15:01:41+08:00', 'shenzhen', 'Arrived at the processing center', 'in_transit', undefined],
        ['2025-02-17T15:01:41+08:00', 'shenzhen', 'Received the package in Shenzhen.', 'accepted', 'ARRIVAL'],
        ['2025-01-30T16:01:15+08:00', undefined, 'Order Submited.', 'registered', undefined],
        ['2025-01-30T16:01:14+08:00', undefined, 'Shipment information received.', 'registered', undefined],
      ]);
    for (const number of [WAYBILL, REFERENCE]) {
      const found = parseQyunTrack(fixture('compensated'), number, READ_AT)!;
      expect(found).toMatchObject({ delivery_carrier: 'imile', delivery_tracking_number: NUMBER, current_stage: 'exception' });
      expect(found).not.toHaveProperty('canonical_tracking_number');
    }
    // The tracker drops the copy too.
    const fetched = await new QyunTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(json(fixture('compensated'))) }).fetch(NUMBER);
    expect(fetched.events!.filter(({ description }) => description === 'Received the package in Shenzhen.')).toHaveLength(1);
  });

  it('hands the record to iMile only with a copy of its scans, under a waybill its detection offers, to a country it serves', () => {
    const changed = (change: (record: Record<string, unknown>) => void) => {
      const reply = fixture('compensated');
      change(reply[0].data[0]);
      return parseQyunTrack(reply, NUMBER, READ_AT)!;
    };
    expect([row('', 'scan 【HQ-MEX.DS】Received.'), row('', 'submitted Order Submited.'), row('', 'Arrived at the transit point.')].map(isQyunImileRow))
      .toEqual([true, true, false]);
    // No row copied from iMile.
    expect(changed((record) => {
      record.trackDetails = (record.trackDetails as Record<string, string>[]).filter((detail) => !isQyunImileRow(row('', detail.track_content!)));
    })).not.toHaveProperty('delivery_carrier');
    // A country iMile does not serve.
    expect(changed((record) => { record.consigneeCountry = 'US'; })).not.toHaveProperty('delivery_carrier');
    // A channel naming another carrier.
    expect(changed((record) => { record.channel_name = 'DHL Express'; })).not.toHaveProperty('delivery_carrier');
    // A tracking number iMile's detection does not offer, found by the forwarder's waybill.
    const other = fixture('compensated');
    other[0].data[0].trackingNumber = 'QY0000000000MX';
    expect(parseQyunTrack(other, WAYBILL, READ_AT)).not.toHaveProperty('delivery_carrier');
  });

  it('keeps an uncoded row that is no copy of a coded one, and reads a clock by its minutes', () => {
    const reply = fixture('compensated');
    const copy = reply[0].data[0].trackDetails.find((detail: Record<string, string>) => !detail.track_kind && detail.track_content === 'Received the package in Shenzhen.');
    copy.track_date = '2025-02-17 15:02:41';
    expect(parseQyunTrack(reply, NUMBER, READ_AT)!.events!.filter(({ description }) => description === 'Received the package in Shenzhen.')
      .map(({ time, provider_code: code }) => [time, code]))
      .toEqual([['2025-02-17T15:02:41+08:00', undefined], ['2025-02-17T15:01:41+08:00', 'ARRIVAL']]);
    expect(splitQyunRow('scan  Your order has been shipped from 【shenzhen】. ', 'shenzhen'))
      .toEqual({ content: 'Your order has been shipped from 【shenzhen】. ', location: 'shenzhen' });
    expect(splitQyunRow('submitted Order Submited.', '')).toEqual({ content: 'Order Submited.', location: '' });
    expect(splitQyunRow('Delivered.', 'GDL Guadalajara SP3')).toEqual({ content: 'Delivered.', location: 'GDL Guadalajara SP3' });
    expect([row('2026-07-22 00:00:00', 'Import Customs Clearance Completed', 'ciudad de mexico'),
      row('2026-07-16 14:00:00', 'Arrived at the port of departure', 'hongkong'),
      row('2026-07-25 12:41:09', 'Delivered.', 'GDL Guadalajara SP3'),
      row('2026-07-14 13:15:49', 'Received the package in Shenzhen.', 'shenzhen', 'ARRIVAL')].map(qyunClock))
      .toEqual(['day', 'day', 'platform', 'platform']);
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseQyunTrack(fixture('no-track'), UNKNOWN, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${QYUN_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseQyunPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('compensated')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['60130', `${NUMBER},${UNKNOWN}`]) {
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

  it('maps every wording it lists, whatever iMile’s warehouse, centre or station is called', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'qyun', description: 'Your order has been shipped from 【GDL Guadalajara Center】.' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'qyun', description: 'Abnormal  LT' })).toEqual({ kind: 'mapped', stage: 'exception' });
    expect(statusMapAnswer({ carrier: 'qyun', providerCode: 'ARRIVAL', description: 'Received the package in Shenzhen.' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
  });
});
