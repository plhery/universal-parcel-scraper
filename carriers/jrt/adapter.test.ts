import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { JRT_ORIGIN, parseJrtPage, parseJrtTrack } from './parser.js';
import { statusMap } from './status.js';
import carrier from './carrier.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const REFERENCE = 'REFTEST000003';
const UP_REFERENCE = 'UP0000000000000002';
const READ_AT = Date.parse('2026-03-06T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('JRT tracking adapter', () => {
  it('finds an order without scans by the shipper’s reference on the page, after the interface has no row', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-registered')));
    const result = await adapter(environment(fetcher)).track({ number: REFERENCE });
    expect(result).toMatchObject({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'The electronic cargo information has been received',
      last_update: '2026-03-02T14:34:18+08:00', destination_country: 'CH', canonical_tracking_number: 'JRT0000000000ZZ',
    });
    expect(result.events).toEqual([
      { time: '2026-03-02T14:34:18+08:00', description: 'The electronic cargo information has been received', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toContain('Synthetic Recipient');
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${JRT_ORIGIN}/selectTrack.htm?documentCode=${REFERENCE}`, 'GET'],
      [`${JRT_ORIGIN}/trackIndex.htm`, 'POST'],
    ]);
    expect(JRT_ORIGIN).toBe('http://106.53.64.22:8082');
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe(`documentCode=${REFERENCE}`);
  });

  it('reads JRT’s own number on the same page, and an unknown number as not found', async () => {
    expect(parseJrtPage(page('page-registered'), 'JRT0000000000ZZ', READ_AT).canonical_tracking_number).toBeUndefined();
    expect(parseJrtTrack(fixture('no-track'), 'JRT0000000000ZZ', READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: 'NOTFOUND000003' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads a parcel asked by its UP reference through the flights, the clearance and DHL’s copied rows', () => {
    const result = parseJrtTrack(fixture('track-dhl'), UP_REFERENCE, Date.parse('2026-03-15T00:00:00Z'))!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'loaded to movement / tour vehicle', last_update: '2026-03-14T16:11:00+08:00',
      destination_country: 'SE', service_name: '欧洲合成专线-A', canonical_tracking_number: 'JRT0000000002ZZ',
    });
    // The record names neither a channel nor DHL's number, so nothing is handed over.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events?.map(({ description, stage, stage_source }) => [description, stage, stage_source])).toEqual([
      ['loaded to movement / tour vehicle', 'in_transit', 'carrier_map'],
      ['unloaded from movement / tour vehicle', 'in_transit', 'carrier_map'],
      ['the shipment has been processed in the parcel center of origin', 'in_transit', 'carrier_map'],
      ['已交服务商 Delivered to service provider', 'in_transit', 'carrier_map'],
      ['清关完成，卡车发运 Customs clearance completed; truck dispatched.', 'in_transit', 'carrier_map'],
      ['已提货，清关中 The goods have been picked up and are currently undergoing customs clearance', 'customs', 'carrier_map'],
      ['机场内等待提货，等待清关 Waiting for cargo pickup and customs clearance at the airport.', 'customs', 'carrier_map'],
      ['航班落地，拆板中 Flight landing, dismantling board in progress', 'in_transit', 'carrier_map'],
      ['航班起飞，以实际抵达为准 Flight departure subject to actual arrival time', 'in_transit', 'carrier_map'],
      // The flight the airport row books is still to come.
      ['Goods delivered to airport', 'in_transit', 'carrier_map'],
      ['货物已交机场,等待航班安排中 Cargo delivered to airport, pending flight arrangement', 'in_transit', 'carrier_map'],
      ['the instruction data for this shipment have been provided by the sender to dhl electronically', 'registered', 'carrier_map'],
      // The rows JRT words only in Chinese show the English of the platform's other tenants.
      ['Goods leave the operation center', 'in_transit', 'carrier_map'],
      ['Arrived at the receiving point', 'accepted', 'carrier_map'],
      ['The electronic cargo information has been received', 'registered', 'carrier_map'],
    ]);
    expect(JSON.stringify(result)).not.toContain('Synthetic Recipient');
  });

  it('offers a UP reference to recognition, which asks the tracker', async () => {
    expect(detectCarrierMatch(UP_REFERENCE)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['jrt'] });
    expect(recognitionCandidates(UP_REFERENCE).map(({ carrier }) => carrier)).toEqual(['jrt']);
    expect(detectCarrierMatch('UP000000000000002').candidates).not.toContain('jrt');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('track-dhl')))
      .mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).recognize!(UP_REFERENCE)).resolves.toMatchObject({ known: true });
    await expect(adapter(environment(fetcher)).recognize!('NOTFOUND000003')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('maps every wording it lists as a whole phrase, whatever day the airport row books', () => {
    for (const entry of statuses.entries) {
      for (const wording of 'english' in entry && entry.english ? [entry.wording, entry.english] : [entry.wording]) {
        expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(entry.stage);
      }
    }
    const answer = (description: string) => statusMapAnswer({ carrier: 'jrt', providerCode: null, description });
    expect(answer('货物已交机场,预计18号的航班 Goods delivered to airport, scheduled on flight of the 18th')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('Flight is expected to take off on September 11')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('The flight is expected to depart on 10.27 and land on 10.28')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('The flight has departed and is expected to 1.3 land')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // A hand-over to the delivering carrier, not a delivery.
    expect(answer('已交服务商 Delivered to service provider')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    for (const description of [
      '已交服务商',
      '货物已交机场,预计18号的航班',
      '货物已交机场,预计18号的航班 Goods delivered to airport, scheduled on flight of the 18th CA000',
      '货物已交机场,预计号的航班 Goods delivered to airport, scheduled on flight of the th',
      'loaded to movement / tour vehicle again',
      'The flight is expected to depart on soon and land on 10.27',
    ]) expect(answer(description), description).toEqual({ kind: 'unknown' });
  });

  it('maps the platform’s own row in Chinese and in the English shown for it, and links no plain-HTTP page', () => {
    for (const description of ['货物电子信息已经收到', 'The electronic cargo information has been received']) {
      expect(statusMapAnswer({ carrier: 'jrt', providerCode: null, description })).toEqual({ kind: 'mapped', stage: 'registered' });
    }
    expect(adapter(environment(vi.fn<typeof fetch>()))).toMatchObject({ id: 'jrt', recordsSteps: true, steps: ['direct', 'retry'] });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.portal).not.toHaveProperty('searchUrl');
  });
});
