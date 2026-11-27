import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { HualeiTracker, parseHualeiPage, parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { DYJ_EXPRESS, DYJ_EXPRESS_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, which `delivered.json` answers, USPS's number its record holds,
// and the invented number the tracker does not know.
const NUMBER = 'DYJCN1020496267CN';
const USPS = '9200190404993200365035';
const UNKNOWN = 'DYJCN7300581946CN';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-27T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const unknownLookup = () => vi.fn<typeof fetch>().mockResolvedValueOnce(json(own('no-track.json'))).mockResolvedValueOnce(html(own('page-unknown.html')));

describe('DYJ Express numbers', () => {
  it('takes the forwarder’s names', () => {
    for (const name of ['DYJ Express', 'DYJ', '达运佳国际物流', '深圳达运佳国际物流']) {
      expect(carrierIdFromName(name), name).toBe('dyj-express');
    }
  });

  it('claims its waybills by their prefix, leaves USPS its number and reads the number out of a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'dyj-express', confidence: 'high' });
    for (const other of ['DYJCN102049626CN', 'DYJUS1020496267CN', 'DYJCN1020496267US']) {
      expect(detectCarrierMatch(other).candidates, other).not.toContain('dyj-express');
    }
    expect(detectCarrierMatch(USPS)).toMatchObject({ carrier: 'usps', confidence: 'high' });
    expect(parseTrackingInput(`http://43.138.180.250:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'dyj-express' });
  });
});

describe('DYJ Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(own('delivered.json')));
    await expect(new HualeiTracker(DYJ_EXPRESS, { fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER.toLowerCase()} `))
      .resolves.toMatchObject({ current_stage: 'delivered', delivery_carrier: 'usps' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DYJ_EXPRESS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(DYJ_EXPRESS_ORIGIN).toBe('http://43.138.180.250:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'dyj-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('hands the parcel to USPS and reads USPS’s copies on their wall clocks, the line’s order row on Beijing’s', () => {
    const result = parseHualeiTrack(JSON.parse(own('delivered.json')), NUMBER, DYJ_EXPRESS, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Parcel Locker', last_update: null, last_update_local: '2025-11-18T10:53:00',
      service_name: 'US Standard Line(Battery)', destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: USPS,
    });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    const events = result.events!;
    expect(events.map((event) => [event.time ?? event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2025-11-18T10:53:00', 'Delivered, Parcel Locker', 'HOLLAND,MI', 'delivered'],
      ['2025-11-18T06:10:00', 'Out for Delivery', 'HOLLAND,MI', 'out_for_delivery'],
      ['2025-11-18T02:25:00', 'Arrived at Post Office', 'HOLLAND,MI', 'in_transit'],
      ['2025-11-18T00:51:00', 'Arrived at USPS Facility', 'HOLLAND,MI', 'in_transit'],
      ['2025-11-17T14:38:00', 'In Transit, Arriving On Time', undefined, 'in_transit'],
      ['2025-11-17T14:38:00', 'In Transit to Next Facility', undefined, 'in_transit'],
      ['2025-11-17T14:22:00', 'Departed USPS Regional Facility', 'GRAND RAPIDS MI DISTRIBUTION CENTER', 'in_transit'],
      ['2025-11-17T07:54:00', 'Arrived at USPS Regional Facility', 'GRAND RAPIDS MI DISTRIBUTION CENTER', 'in_transit'],
      ['2025-11-17T04:37:00', 'In Transit to Next Facility', undefined, 'in_transit'],
      ['2025-11-17T02:03:00', 'Departed USPS Facility', 'INDIANAPOLIS,IN', 'in_transit'],
      ['2025-11-16T21:59:00', 'Arrived at USPS Facility', 'INDIANAPOLIS,IN', 'in_transit'],
      ['2025-11-16', 'In Transit to Next Facility', undefined, 'in_transit'],
      ['2025-11-15T02:13:00', 'Departed USPS Regional Facility', 'SAN DIEGO CA DISTRIBUTION CENTER', 'in_transit'],
      ['2025-11-15T00:06:00', 'Arrived at USPS Regional Origin Facility', 'SAN DIEGO CA DISTRIBUTION CENTER', 'in_transit'],
      ['2025-11-14T22:51:00', 'Accepted at USPS Origin Facility', 'SAN DIEGO,CA', 'in_transit'],
      ['2025-11-11T21:36:00', 'Shipping Label Created, USPS Awaiting Item', 'SAN DIEGO,CA', 'registered'],
      ['2025-11-03T15:26:11+08:00', 'Shipment information received', undefined, 'registered'],
    ]);
    // USPS's copies keep their wall clock without a zone, and its midnight row its day alone.
    expect(events[0]).not.toHaveProperty('time');
    expect(events[11]).toMatchObject({ local_time: '2025-11-16' });
    // The platform's custom track rows, the warehouse in Shenzhen to the clearance in Los Angeles, are planned steps, not scans.
    expect(result.written_ahead).toHaveLength(6);
    expect(result.planned_events?.map((step) => [step.time, step.description, step.stage])).toEqual([
      ['2025-11-07T05:10:51+08:00', 'warehouse and scanning is complete', 'accepted'],
      ['2025-11-08T05:10:51+08:00', 'The package has been sorted and sent from the warehouse', 'in_transit'],
      ['2025-11-10T01:40:51+08:00', 'Departure from the starting port', 'in_transit'],
      ['2025-11-11T07:52:51+08:00', 'Hand over to airline', 'in_transit'],
      ['2025-11-11T21:04:51+08:00', 'Shipment arrived at airport', 'in_transit'],
      ['2025-11-12T20:40:51+08:00', 'Complete customs clearance', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/signperson|customer_code|49424|92111/);
  });

  it('finds the record by USPS’s number too, and then names DYJ’s own number as the canonical one', () => {
    const payload = JSON.parse(own('delivered.json'));
    const result = parseHualeiTrack(payload, USPS, DYJ_EXPRESS, READ_AT);
    expect(result).toMatchObject({ canonical_tracking_number: NUMBER, delivery_carrier: 'usps' });
    // USPS delivers under the number asked, so no other number is named for it.
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('names no delivery carrier without USPS’s number, or when a channel names another carrier', () => {
    const payload = JSON.parse(own('delivered.json'));
    const [record] = payload[0].data;
    record.business_channeltransfercode = '';
    expect(parseHualeiTrack(payload, NUMBER, DYJ_EXPRESS, READ_AT)).not.toHaveProperty('delivery_carrier');
    record.business_channeltransfercode = USPS;
    record.channel_name = 'UniUni';
    expect(parseHualeiTrack(payload, NUMBER, DYJ_EXPRESS, READ_AT)).not.toHaveProperty('delivery_carrier');
  });

  it('reads the no-row answer for an unknown number, which the page settles as not found', async () => {
    expect(parseHualeiTrack(JSON.parse(own('no-track.json')), UNKNOWN, DYJ_EXPRESS, READ_AT)).toBeNull();
    const fetcher = unknownLookup();
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${DYJ_EXPRESS_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHualeiPage(own('page-unknown.html'), UNKNOWN, DYJ_EXPRESS, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The same page for another number is no answer for this one.
    expect(() => parseHualeiPage(own('page-unknown.html'), NUMBER, DYJ_EXPRESS, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes by the same lookup', async () => {
    await expect(adapter(environment(unknownLookup())).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(own('delivered.json')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['DYJ', `${NUMBER},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json('[{"ack":"true","data":{}}]')))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)) ?? null, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'dyj-express', providerCode: null, description: 'Delivered, Parcel Locker' }))
      .toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'dyj-express', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('searchUrl');
  });
});
