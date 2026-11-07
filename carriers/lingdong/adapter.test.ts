import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LingdongTracker } from './adapter.js';
import { LINGDONG_ORIGIN, parseLingdongPage, parseLingdongTrack, repeatsLingdongRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'SZLD9999999980';
const UNKNOWN = 'SZLD9900000009';
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

  it('reads Poste Italiane’s relayed scans on Beijing time, the clock the platform writes them on', () => {
    const payload = structuredClone(fixture('track')) as Array<{ data: Array<{ trackDetails: Array<Record<string, string>> }> }>;
    const details = payload[0]!.data[0]!.trackDetails;
    // Written at 16:53 in Beijing, 09:53 in Rome: read on Rome's clock, the scan would come after its own writing.
    details.unshift({ ...details[0]!, track_content: 'In transito, la spedizione è in transito', track_kind: '', track_location: 'SYNTHETIC HUB',
      track_date: '2026-03-05 13:34:09', track_createdate: '2026-03-05 16:53:11' });
    const [scan] = parseLingdongTrack(payload, NUMBER, Date.parse('2026-03-05T09:00:00Z'))!.events ?? [];
    expect(scan).toMatchObject({ time: '2026-03-05T13:34:09+08:00', written_at: '2026-03-05T16:53:11+08:00', stage: 'in_transit' });
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

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'lingdong', providerCode: 'ARRIVAL', description: 'Shipment arrived at facility' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'lingdong', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
    for (const description of ['预计10.28航班/Flight scheduled for October 28th', '预计1.2航班/Flight scheduled for January 2nd', '预计30号航班【Expect flight 30th.】', '预计2号航班【Expect flight 2nd.】']) {
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
