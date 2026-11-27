import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LingdongTracker } from './adapter.js';
import { LINGDONG_ORIGIN, parseLingdongPage, parseLingdongTrack, repeatsLingdongRow } from './parser.js';
import { lingdongEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'SZLD9999999980';
const UNKNOWN = 'SZLD9900000009';
// The delivery carrier's number, which takes the order's tracking number on the tracker once the forwarder hands it on.
const PARTNER = '9900000000000000000001';
// Noon in Beijing on 5 March, after the fixture's rows.
const READ_AT = Date.parse('2026-03-05T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Lingdong International numbers', () => {
  it('claims SZLD and ten digits, and nothing shorter, longer or under another prefix', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'lingdong', confidence: 'high', candidates: ['lingdong'] });
    for (const other of ['SZLD990000001', 'SZLD99000000001', 'SZLX9900000001', 'XSZLD9900000001', 'SZLD9900000001X']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('lingdong');
    }
  });

  it('reads the number out of a link to its tracker', () => {
    expect(parseTrackingInput(`http://tms.lingdong56.com:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'lingdong' });
  });
});

describe('Lingdong International tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new LingdongTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LINGDONG_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(LINGDONG_ORIGIN).toBe('http://tms.lingdong56.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'lingdong', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads its warehouse rows on Beijing time, without the parties', () => {
    const result = parseLingdongTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Shipment departed from facility',
      last_update: '2026-03-04T21:58:03+08:00', service_name: 'Synthetic Line', destination_country: 'DE',
    });
    expect(result.events).toEqual([
      { time: '2026-03-04T21:58:03+08:00', description: 'Shipment departed from facility', location: 'SHENZHEN', provider_code: 'SHIPMENT',
        stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-04T21:58:03+08:00' },
      { time: '2026-03-03T07:58:04+08:00', description: 'Shipment arrived at facility', location: 'SHENZHEN', provider_code: 'ARRIVAL',
        stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-03T07:58:04+08:00' },
    ]);
    expect(result.canonical_tracking_number ?? result.delivery_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Synthetic Shop', 'LD-TEST-001', 'LDTEST0000000000001']) expect(text, value).not.toContain(value);
  });

  it('keeps the fuller of the two rows it lists for one partner scan, headline alone and with its sentence', () => {
    const payload = structuredClone(fixture('track')) as Array<{ data: Array<{ trackDetails: Array<Record<string, string>> }> }>;
    const details = payload[0]!.data[0]!.trackDetails;
    const row = (content: string, date: string) => ({ ...details[0]!, track_content: content, track_kind: '', track_location: 'SYNTHETIC HUB',
      track_date: date, track_createdate: date });
    // Newest first, as the tracker lists them: the fuller row above the headline alone, then an earlier scan.
    details.unshift(row('In transito, la spedizione è in transito', '2026-03-05 10:00:00'), row('In transito', '2026-03-05 10:00:00'),
      row('In transito', '2026-03-05 09:00:00'));
    const events = parseLingdongTrack(payload, NUMBER, Date.parse('2026-03-05T06:00:00Z'))!.events ?? [];
    expect(events.slice(0, 2).map(({ time, description, stage }) => [time, description, stage])).toEqual([
      ['2026-03-05T10:00:00+08:00', 'In transito, la spedizione è in transito', 'in_transit'],
      ['2026-03-05T09:00:00+08:00', 'In transito', 'in_transit'],
    ]);
    expect(events).toHaveLength(4);
    expect(repeatsLingdongRow('In transito', 'In transito, la spedizione è in transito')).toBe(true);
    expect(repeatsLingdongRow('In transito, la spedizione è in transito', 'In transito')).toBe(false);
    // A headline whose fuller row gives another stage, or a headline the map does not know, stays its own row.
    expect(repeatsLingdongRow('In consegna', 'In consegna, la spedizione è stata consegnata')).toBe(false);
    expect(repeatsLingdongRow('Synthetic', 'Synthetic, the same')).toBe(false);
  });

  it('shows the English half of a row worded in Chinese and then in English, staged by the whole row', () => {
    const payload = structuredClone(fixture('track')) as Array<{ data: Array<{ trackDetails: Array<Record<string, string>> }> }>;
    const details = payload[0]!.data[0]!.trackDetails;
    const row = (content: string, date: string) => ({ ...details[0]!, track_content: content, track_kind: '', track_location: '',
      track_date: date, track_createdate: date });
    details.unshift(row('航班抵达【Flight arrival】', '2026-03-05 10:00:00'),
      row('There is a delay in the flight schedule. It is expected to arrive at the local time on the 5th', '2026-03-05 09:30:00'),
      row('预计11.9航班/Scheduled flight on November 9st', '2026-03-05 09:00:00'));
    const events = parseLingdongTrack(payload, NUMBER, Date.parse('2026-03-05T06:00:00Z'))!.events ?? [];
    expect(events.slice(0, 3).map(({ description, stage, stage_source }) => [description, stage, stage_source])).toEqual([
      ['Flight arrival', 'in_transit', 'carrier_map'],
      // The flight booked before it flies, and its expected landing, are forecasts: notices on the stage of the scan before them.
      ['There is a delay in the flight schedule. It is expected to arrive at the local time on the 5th', 'in_transit', 'none'],
      ['Scheduled flight on November 9st', 'in_transit', 'none'],
    ]);
    expect(events.slice(3).find((event) => event.stage)?.stage).toBe('in_transit');
    // The app reads the English half shown alone by the same map, the flight booked as a notice.
    for (const description of ['Flight arrival', 'Received by local delivery company']) {
      expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description }), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    for (const description of ['Scheduled flight on November 9st', 'Flight scheduled for October 28th', 'Expect flight 30th.',
      'It is expected to arrive at the local time on the 17th', 'There is a delay in the flight schedule. It is expected to arrive at the local time on the 21st']) {
      expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description }), description)
        .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage of the scan before it/) });
    }
    // A row in one language, or whose halves are not Chinese and then English, is shown whole.
    for (const wording of ['货物电子信息已经收到', 'Shipment arrived at facility', 'Example/Sample', '示例/示例', 'Example 示例/Sample', '示例【示例】']) {
      expect(lingdongEnglish(wording), wording).toBeUndefined();
    }
  });

  it('reads a row of punctuation alone as a notice on the stage of the scan before it', () => {
    const payload = structuredClone(fixture('track')) as Array<{ data: Array<{ trackDetails: Array<Record<string, string>> }> }>;
    const details = payload[0]!.data[0]!.trackDetails;
    details.unshift({ ...details[0]!, track_content: '.', track_kind: '', track_location: '', track_date: '2026-03-05 10:00:00',
      track_createdate: '2026-03-05 10:00:00' });
    const [row, before] = parseLingdongTrack(payload, NUMBER, Date.parse('2026-03-05T06:00:00Z'))!.events ?? [];
    expect(row).toMatchObject({ description: '.', stage: before!.stage, stage_source: 'none' });
    expect(before!.stage_source).toBe('carrier_map');
    expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description: '.' }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage of the scan before it/) });
  });

  it('reads Poste Italiane’s relayed scans on Beijing time, the clock the platform writes them on', () => {
    const payload = structuredClone(fixture('track')) as Array<{ data: Array<{ trackDetails: Array<Record<string, string>> }> }>;
    const details = payload[0]!.data[0]!.trackDetails;
    // Written at 16:53 in Beijing, 09:53 in Rome: read on Rome's clock, the scan would come after its own writing.
    details.unshift({ ...details[0]!, track_content: 'In transito, la spedizione è in transito', track_kind: '', track_location: 'SYNTHETIC HUB',
      track_date: '2026-03-05 13:34:09', track_createdate: '2026-03-05 16:53:11' });
    const [scan] = parseLingdongTrack(payload, NUMBER, Date.parse('2026-03-05T09:00:00Z'))!.events ?? [];
    expect(scan).toMatchObject({ time: '2026-03-05T13:34:09+08:00', written_at: '2026-03-05T16:53:11+08:00', stage: 'in_transit' });
  });

  it('reads GOFO’s scans on the line into the United States on GOFO’s clocks, as JRT’s tracker does', () => {
    const payload = structuredClone(fixture('track')) as Array<{ data: Array<{ trackDetails: Array<Record<string, string>> }> }>;
    const details = payload[0]!.data[0]!.trackDetails;
    // GOFO's hub dates its scans on Chicago's clock and its label on Pacific time; read on Beijing time the hub scan comes 14 hours early.
    details.unshift({ ...details[0]!, track_content: 'Arrived at GOFO Regional Hub', track_kind: '', track_location: 'Melrose Park,IL',
      track_date: '2026-03-06 05:12:40', track_createdate: '2026-03-06 19:13:02' },
    { ...details[0]!, track_content: 'Shipping Label Created', track_kind: '', track_location: '',
      track_date: '2026-03-05 02:10:00', track_createdate: '2026-03-05 18:11:00' });
    const result = parseLingdongTrack(payload, NUMBER, Date.parse('2026-03-07T00:00:00Z'))!;
    const event = (description: string) => result.events?.find((row) => row.description === description);
    expect(event('Arrived at GOFO Regional Hub')).toMatchObject({ time: '2026-03-06T05:12:40-06:00', time_zone: 'America/Chicago', time_zone_basis: 'place' });
    expect(event('Shipping Label Created')).toMatchObject({ time: '2026-03-05T02:10:00-08:00', time_zone: 'America/Los_Angeles', time_zone_basis: 'carrier' });
    expect(event('Shipment departed from facility')).toMatchObject({ time: '2026-03-04T21:58:03+08:00' });
    expect(result.last_update).toBe('2026-03-06T05:12:40-06:00');
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${LINGDONG_ORIGIN}/trackIndex.htm`);
    expect(() => parseLingdongPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('reads an order the page holds by its tracking number, before any piece, destination or scan, as having no history yet', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-order')));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toBeInstanceOf(NoHistoryError);
    expect(() => parseLingdongPage(page('page-order'), NUMBER, READ_AT)).toThrow('no scans for the shipment yet');
    // Another number is not the order.
    expect(() => parseLingdongPage(page('page-order'), 'SZLD9900000009', READ_AT)).toThrow('did not show the number as one shipment');
  });

  it('reads an order found by its own number once the delivery carrier’s number has taken the tracking number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-handed')));
    const result = await adapter(environment(fetcher)).track({ number: NUMBER });
    expect(result).toMatchObject({ last_status_text: 'Shipment information received', last_update: '2026-03-02T16:15:01+08:00',
      destination_country: 'ES', delivery_tracking_number: PARTNER, current_stage: 'registered', current_stage_source: 'carrier_map' });
    expect(result.events).toHaveLength(1);
    // The page shows the order for the one number its form echoes, and not for an own number it shows as the tracking number.
    expect(() => parseLingdongPage(page('page-handed'), UNKNOWN, READ_AT)).toThrow('did not show the number as one shipment');
    expect(() => parseLingdongPage(page('page-handed').replaceAll(PARTNER, UNKNOWN), NUMBER, READ_AT)).toThrow('did not show the number as one shipment');
    // The track interface stops returning the number the same way.
    const record = (fixture('track') as [{ data: Record<string, unknown>[] }])[0].data[0]!;
    const handed = [{ ack: 'true', data: [{ ...record, trackingNumber: PARTNER, business_seqinvoicecode: 'LDTEST0000000000001' }] }];
    expect(parseLingdongTrack(handed, NUMBER, READ_AT)).toMatchObject({ current_stage: 'in_transit', delivery_tracking_number: PARTNER });
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage ?? undefined);
    expect(statusMapAnswer({ carrier: 'lingdong', providerCode: 'ARRIVAL', description: 'Shipment arrived at facility' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
    for (const description of ['预计10.28航班/Flight scheduled for October 28th', '预计1.2航班/Flight scheduled for January 2nd', '预计30号航班【Expect flight 30th.】', '预计2号航班【Expect flight 2nd.】',
      '预计11.9航班/Scheduled flight on November 9st', '预计12.21航班/Scheduled flight on December 21st', 'Expected flight on Nov. 19th',
      '预计11.19航班/Expected flight on Nov. 19th', '预计航班【Expected flight on Dec. 2nd】']) {
      // The flight booked before it flies is a forecast: it keeps the stage of the scan before it.
      expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description }), description)
        .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage of the scan before it/) });
    }
    // The label, the order data sent to DPD and the sender still preparing the parcel before the first scan, the hand-over to GOFO in the United
    // States after the release, and GOFO's hub.
    for (const [description, stage] of [['Shipping Label Created', 'registered'], ['Order information has been transmitted to DPD.', 'registered'],
      ['Your package is being prepared by the sender and will be handed over to us soon', 'registered'], ['包裹交接给本地物流商处理/Received by local delivery company', 'in_transit'],
      ['Arrived at GOFO Regional Hub', 'in_transit']] as const) {
      expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description })).toEqual({ kind: 'mapped', stage });
    }
    // UPS's label in Chinese and in English, then the export clearance, the airline, the import release and the delivering partner's
    // collection on the line through UPS.
    for (const [description, stage] of [['发件人已创建标签，但是 UPS 尚未收到包裹。', 'registered'],
      ['Label Created, Shipper created a label, UPS has not received the package yet.', 'registered'], ['Customs export clearance completed', 'in_transit'],
      ['Package handed over to airline', 'in_transit'], ['Customs import clearance completed, awaiting pickup by local carrier', 'in_transit'],
      ['Package picked up by last-mile carrier', 'in_transit']] as const) {
      expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description })).toEqual({ kind: 'mapped', stage });
    }
    // The flight's departure in English alone, and its arrival at whichever airport it names.
    for (const description of ['Departed from Port of Origin', 'Arrived at Sample Airport', 'Arrived at Sample Town Airport']) {
      expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    // The delivery partner's scans as the forwarder relays them, in capitals.
    for (const description of ['FIRST PARCEL SCAN ALONG POSTE ITALIANE’S LOGISTIC NETWORK', 'IN TRANSIT ALONG POSTE ITALIANE’S LOGISTIC NETWORK']) {
      expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    // Its Italian rows, the headline alone or with Poste Italiane's sentence.
    for (const [description, stage] of [['In transito', 'in_transit'], ['In transito, la spedizione è in transito', 'in_transit'], ['In consegna', 'out_for_delivery'], ['Consegnata, la spedizione è stata consegnata', 'delivered']] as const) {
      expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description })).toEqual({ kind: 'mapped', stage });
    }
    expect(carrier.portal).not.toHaveProperty('url');
  });
});
