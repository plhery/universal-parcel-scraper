import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, FeimaTracker } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { FEIMA_ORIGIN, parseFeimaPage, parseFeimaTrack } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'FM9900000017CN';
// The public sample the tracker no longer holds, whose answers the fixtures keep.
const UNKNOWN = 'FM663550656CN';
const REFERENCE = 'FMTEST00000001';
// After the record's newest clock.
const READ_AT = Date.parse('2026-03-25T00:00:00Z');
type Reply = [{ data: [{ trackDetails: Record<string, string>[] }] }];
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Feima numbers', () => {
  it('names Feima for FM, ten digits and CN, and suggests it for FM, nine digits and CN', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'feima', confidence: 'high' });
    expect(detectCarrierMatch(UNKNOWN)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['feima'] });
    for (const other of ['FM98765432101CN', 'FM12345678CN', 'FM9900000017US', 'FN9900000017CN', 'FMX900000017CN']) {
      const match = detectCarrierMatch(other);
      expect([match.carrier, ...(match.candidates ?? [])], other).not.toContain('feima');
    }
  });

  it('reads the number out of the link the forwarder’s site opens', () => {
    expect(parseTrackingInput(`http://47.111.22.87:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'feima' });
  });

  it('takes 17TRACK’s names for the forwarder and its brand', () => {
    for (const name of ['FEIMA', '飞马物流', '飛馬物流', 'FINMA PEGASUS']) expect(carrierIdFromName(name), name).toBe('feima');
  });
});

describe('Feima tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new FeimaTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ destination_country: 'CA' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FEIMA_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(FEIMA_ORIGIN).toBe('http://47.111.22.87:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'feima', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('keeps the row written after its clock and names the timeline written ahead of it, on Beijing time', () => {
    const result = parseFeimaTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'accepted', last_status_text: 'Shipment picked up',
      last_update: '2026-03-01T12:31:05+08:00', service_name: 'Synthetic Canada Line', destination_country: 'CA',
    });
    expect(result.events!.map(({ time, description, location }) => [time, description, location])).toEqual([
      ['2026-03-01T12:31:05+08:00', 'Shipment picked up', 'US'],
    ]);
    expect(result.written_ahead).toHaveLength(9);
    expect(result.written_ahead![0]).toBe('2026-03-22T16:20:31+08:00');
    expect(result.planned_events!.at(-1)).toMatchObject({ time: '2026-03-22T16:20:31+08:00', description: 'Shipping by courier', location: 'CA-Montreal' });
    expect(result.canonical_tracking_number ?? result.delivery_carrier ?? result.delivery_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of [REFERENCE, 'TEST1']) expect(text, value).not.toContain(value);
  });

  it('holds back the delivery row a timeline written ahead ends in, and keeps one among scans', () => {
    const reply = structuredClone(fixture('track'));
    // The script's delivery, written hours after its clock, the rest of the record days before theirs.
    reply[0].data[0].trackDetails.unshift({ track_date: '2026-03-24 10:00:00', track_createdate: '2026-03-24 15:05:00',
      track_content: 'CA-Montreal，Delivered', track_location: 'CA-Montreal' });
    const result = parseFeimaTrack(reply, NUMBER, READ_AT)!;
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Shipment picked up' });
    expect(result.events).toHaveLength(1);
    expect(result.written_ahead).toHaveLength(10);
    expect(result.planned_events!.at(-1)).toMatchObject({ time: '2026-03-24T10:00:00+08:00', description: 'Delivered', stage: 'delivered' });
    for (const row of reply[0].data[0].trackDetails) row.track_createdate = row.track_date!;
    const scanned = parseFeimaTrack(reply, NUMBER, READ_AT)!;
    expect(scanned).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(scanned.written_ahead).toBeUndefined();
  });

  it('reads rows written as scans with the stages its map and the shared rules give, without the place repeated', () => {
    const reply = structuredClone(fixture('track'));
    for (const row of reply[0].data[0].trackDetails) row.track_createdate = row.track_date!;
    const result = parseFeimaTrack(reply, NUMBER, READ_AT)!;
    expect(result.written_ahead).toBeUndefined();
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Shipping by courier' });
    expect(result.events!.map(({ time, description, location, stage }) => [time, description, location, stage])).toEqual([
      ['2026-03-22T16:20:31+08:00', 'Shipping by courier', 'CA-Montreal', 'in_transit'],
      ['2026-03-20T11:02:17+08:00', 'Package has departed from a facility', 'CA-Montreal', 'in_transit'],
      ['2026-03-18T04:08:55+08:00', 'In Transit', 'CA-Montreal', 'in_transit'],
      ['2026-03-15T08:33:40+08:00', 'Customs clearance status updated. Note - The item is being processed by customs.', 'CA-Montreal', 'customs'],
      ['2026-03-13T00:51:09+08:00', 'Clearance processing complete at CA-Montreal', 'CA-Montreal', 'in_transit'],
      ['2026-03-10T16:47:23+08:00', 'Arrived at Sort Facility', 'CA-Montreal', 'in_transit'],
      ['2026-03-08T13:38:16+08:00', 'Shipment is in transit to destination', 'US', 'in_transit'],
      ['2026-03-06T07:20:05+08:00', 'Shipment has departed from a facility US', 'US', 'in_transit'],
      ['2026-03-03T22:40:11+08:00', 'Processed at US', 'US', 'in_transit'],
      ['2026-03-01T12:31:05+08:00', 'Shipment picked up', 'US', 'accepted'],
    ]);
  });

  it('reads the page’s unknown-number answer as not found, and recognizes the number as unknown', async () => {
    const unknown = () => vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    const fetcher = unknown();
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${FEIMA_ORIGIN}/trackIndex.htm`);
    expect(() => parseFeimaPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
    await expect(adapter(environment(unknown())).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'feima', description: 'Shipping by courier' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(carrier.portal).not.toHaveProperty('url');
  });
});
