import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ZhongzhouLogisticsTracker } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { parseZhongzhouTrack, ZHONGZHOU_ORIGIN } from './parser.js';
import { isZhongzhouNotice, statusMap, zhongzhouEnglish } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic fixture's numbers: Zhongzhou's own, the line's reference and GOFO France's, which
// the record holds in no field.
const OWN = 'ZZ9999999990CN';
const REFERENCE = 'FC9999999999901';
const GOFO = 'GFFR26300999999990';
// The invented number the tracker does not know, whose real answer the page fixture is.
const UNKNOWN = 'ZZ9999999999CN';
// Noon in Beijing on 15 March, after the fixture's rows.
const READ_AT = Date.parse('2026-03-15T04:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const track = () => JSON.parse(own('track.json'));
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Zhongzhou Logistics numbers', () => {
  it('takes the universal providers’ names for the forwarder', () => {
    for (const name of ['ZZWL', 'Zhongzhou Logistics', '中洲物流', '莆田市中洲物流供应链有限公司']) expect(carrierIdFromName(name), name).toBe('zhongzhou-logistics');
  });

  it('claims no number shape: its own numbers are offered to nobody, and GOFO France’s stay GOFO France’s', () => {
    expect(detectCarrierMatch(OWN).candidates ?? []).not.toContain('zhongzhou-logistics');
    expect(detectCarrierMatch(GOFO)).toMatchObject({ carrier: 'gofo-fr', confidence: 'high' });
  });
});

describe('Zhongzhou Logistics tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
    const result = await new ZhongzhouLogisticsTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(OWN.toLowerCase());
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ZHONGZHOU_ORIGIN}/selectTrack.htm?documentCode=${OWN}`);
    expect(ZHONGZHOU_ORIGIN).toBe('http://zhongzhouwuliu.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Handed over to local agent', last_update: null, last_update_local: '2026-03-14T16:20:00',
      service_name: 'T0001 Europe Standard Line(General)-ZZ', destination_country: 'FR' });
    // Its own number names no delivery carrier: the record keeps GOFO France's number nowhere.
    for (const key of ['canonical_tracking_number', 'delivery_carrier', 'delivery_tracking_number']) expect(result).not.toHaveProperty(key);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'zhongzhou-logistics', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('answers GOFO France’s number with the order the interface finds by it, and hands the parcel to GOFO France under it', () => {
    const result = parseZhongzhouTrack(track(), GOFO.toLowerCase(), READ_AT)!;
    expect(result).toMatchObject({ status: 'in_transit', canonical_tracking_number: OWN, delivery_carrier: 'gofo-fr' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(deliveryHandoff('zhongzhou-logistics', GOFO, normalizeCarrierResult(result))).toEqual({ carrier: 'gofo-fr', number: GOFO, basis: 'partner' });
    // The line's reference finds the order too, and names no delivery carrier.
    const referenced = parseZhongzhouTrack(track(), REFERENCE, READ_AT)!;
    expect(referenced).toMatchObject({ canonical_tracking_number: OWN });
    expect(referenced).not.toHaveProperty('delivery_carrier');
    expect(deliveryHandoff('zhongzhou-logistics', OWN, normalizeCarrierResult(parseZhongzhouTrack(track(), OWN, READ_AT)!))).toBeNull();
  });

  it('takes no record that holds none of a number GOFO France does not claim, nor one of another of its numbers', () => {
    for (const asked of ['ZZ9999999991CN', 'GFFR26300999999991', 'AB1234567890']) {
      expect(() => parseZhongzhouTrack(track(), asked, READ_AT), asked).toThrow(IndeterminateError);
    }
    // A record whose tracking number is not Zhongzhou's is no order found by GOFO France's number.
    const foreign = track();
    foreign[0].data[0].trackingNumber = 'XX9999999990CN';
    expect(() => parseZhongzhouTrack(foreign, GOFO, READ_AT)).toThrow(IndeterminateError);
  });

  it('shows the rows in English on their wall clocks, folds the tracker’s twin rows and keeps a booked flight as a notice', () => {
    const result = parseZhongzhouTrack(track(), OWN, READ_AT)!;
    expect(result.events!.every((event) => !('time' in event) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage, event.stage_source, event.location ?? null])).toEqual([
      ['2026-03-14T16:20:00', 'Handed over to local agent', 'in_transit', 'carrier_map', null],
      ['2026-03-14T09:00:00', 'Import customs clearance complete', 'in_transit', 'carrier_map', null],
      ['2026-03-13T10:00:00', 'French Customs inspection', 'customs', 'carrier_map', null],
      ['2026-03-11T09:15:00', 'Customs clearance in progress', 'customs', 'carrier_map', null],
      ['2026-03-10T13:20:00', 'Deconsolidation & Pickup in Progress', 'in_transit', 'carrier_map', null],
      ['2026-03-10T07:30:00', 'The flight has arrived, customs clearance and unpacking are underway', 'customs', 'carrier_map', null],
      ['2026-03-08T21:00:00', 'The flight has been delayed until the 9th', 'in_transit', 'none', null],
      ['2026-03-07T15:00:00', 'Flight scheduled for March 8th', 'in_transit', 'none', null],
      ['2026-03-07T11:30:00', 'Package handed over to airline', 'in_transit', 'carrier_map', null],
      ['2026-03-06T22:10:00', 'The goods have been dispatched from the Shenzhen warehouse', 'in_transit', 'carrier_map', '深圳'],
      ['2026-03-06T14:05:00', 'Goods arrive at the receiving point at the Shenzhen warehouse', 'accepted', 'carrier_map', '深圳'],
      ['2026-03-05T19:45:31', 'Goods leave the operation center', 'in_transit', 'carrier_map', null],
      // GOFO's label row, which the tracker copies twice, hours apart.
      ['2026-03-05T12:12:09', 'Your package is being prepared by the sender and will be handed over to us soon', 'registered', 'carrier_map', null],
      ['2026-03-05T10:31:07', 'Electronic information about the goods has been received', 'registered', 'carrier_map', null],
      ['2026-03-05T10:30:55', 'Arrived at the receiving point', 'accepted', 'carrier_map', null],
      ['2026-03-05T06:12:09', 'Your package is being prepared by the sender and will be handed over to us soon', 'registered', 'carrier_map', null],
    ]);
    expect(result.events!.filter((event) => event.provider_code).map((event) => event.provider_code)).toEqual(['QGZ', 'SHIPMENT', 'ARRIVAL']);
    expect(JSON.stringify(result)).not.toContain('TESTZZ');
  });

  it('settles the interface’s no-row answer with the page’s answer for the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('no-track.json'))).mockResolvedValueOnce(reply(own('page-unknown.html')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(`${ZHONGZHOU_ORIGIN}/trackIndex.htm`);
    expect(init).toMatchObject({ method: 'POST' });
    expect(String(init!.body)).toBe(`documentCode=${UNKNOWN}`);
    // The page's answer for another number settles nothing.
    const other = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('no-track.json'))).mockResolvedValueOnce(reply(own('page-unknown.html')));
    await expect(adapter(environment(other)).track({ number: 'ZZ9999999998CN' })).rejects.toBeInstanceOf(IndeterminateError);
  });

  it('keeps a bot check, a broken reply and a number it cannot send apart from an unknown number', async () => {
    const once = (response: Response) => new ZhongzhouLogisticsTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response), recorder: NOOP_RECORDER })
      .fetch(OWN);
    await expect(once(reply('<html><head><title>Just a moment...</title></head></html>'))).rejects.toBeInstanceOf(ChallengeError);
    await expect(once(reply('[{"data":[{"trackingNumber":'))).rejects.toBeInstanceOf(SchemaError);
    await expect(once(reply('<html><body>Service Unavailable</body></html>'))).rejects.toBeInstanceOf(SchemaError);
    await expect(new ZhongzhouLogisticsTracker({ fetcher: vi.fn<typeof fetch>(), recorder: NOOP_RECORDER }).fetch(`${OWN},${UNKNOWN}`))
      .rejects.toBeInstanceOf(InvalidInputError);
  });

  it('maps every wording it lists, reads a booked flight’s day as any day, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)) ?? null, entry.wording).toBe(entry.stage);
    }
    for (const wording of ['预计12.24航班（Flight scheduled for December 24th）', '航班延误至1号飞（The flight has been delayed until the 1st）']) {
      expect(isZhongzhouNotice(null, normalizeStatusWording(wording)), wording).toBe(true);
    }
    expect(statusMapAnswer({ carrier: 'zhongzhou-logistics', providerCode: 'QGZ', description: '清关中/Customs clearance in progress' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'zhongzhou-logistics', providerCode: null, description: 'Customs clearance in progress' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'zhongzhou-logistics', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
    expect(zhongzhouEnglish(null, normalizeStatusWording('法国海关查验'), '法国海关查验')).toBe('French Customs inspection');
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.links).toEqual([]);
    expect(carrier.portal).not.toHaveProperty('url');
  });
});
