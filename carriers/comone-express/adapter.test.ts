import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, COMONE_LOOKUP } from './adapter.js';
import { normalizeComoneNumber, parseComone } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The first public sample in numbers.json, and an invented number the tracker does not know.
const SAMPLE = '881137924';
const OTHER = 'CM9900000017';
// A synthetic waybill for parcels built here.
const SYNTHETIC = '990000000017';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const reply = (...data: unknown[]) => ({ code: 0, data, msg: '', success: true });
// A synthetic parcel in the reply's shape, with the merchant's order number, a driver's name in
// the remarks and a delivery photo.
const parcel = (fields: Record<string, unknown> = {}) => ({
  customerOrderNo: 'SYNTHETIC-ORDER-1', customerWeight: 1.5, desCountryId: 'MY', expressNo: SYNTHETIC, number: SYNTHETIC,
  remark: '派送员名字:SYNTHETIC DRIVER', statusCode: 80, supplierName: 'SPRX-MY', supplierTrackingNo: '',
  traces: [
    { imgUrl: '[{"url": "https://images.example/pod.jpg"}]', podStatusCode: 'OFD', remark: '派送员名字:SYNTHETIC DRIVER',
      traceEventCn: '出去派送', traceEventEn: 'Out For delivery', traceLocation: 'My,Kuala Lumpur', traceTime: '2030-01-12 10:15:00' },
    { podStatusCode: 'ICST', traceEventCn: '进口清关开始', traceEventEn: 'Import Clearance Start', traceLocation: 'Malaysia', traceTime: '2030-01-11 09:00:00' },
    { podStatusCode: 'SPU', traceEventCn: '收到货物', traceEventEn: 'Shipment Picked Up', traceLocation: 'Gd,BANTIAN', traceTime: '2030-01-08 20:39:47' },
  ],
  ...fields,
});

describe('ComOne Express numbers', () => {
  it('takes 6 to 40 letters and digits with at least one digit, in capitals', () => {
    expect(normalizeComoneNumber(` ${SAMPLE.slice(0, 3)} ${SAMPLE.slice(3)} `)).toBe(SAMPLE);
    expect(normalizeComoneNumber(OTHER.toLowerCase())).toBe(OTHER);
    for (const other of ['', '12345', 'ABCDEFGHIJ', `${SAMPLE},${OTHER}`, 'CM99/00000017', `${'A'.repeat(40)}1`, '1'.repeat(65)]) {
      expect(() => normalizeComoneNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('ComOne Express tracking adapter', () => {
  it('posts the number as a form to the lookup the tracking page posts it to', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(COMONE_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(String(init.body)).toBe(`number=${SAMPLE}`);
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(carrier(fetcher)).toMatchObject({ id: 'comone-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s empty list as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, refusals, redirects and changed replies apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>403 Forbidden</h1>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    // The tracker's other refusals leave the answer open, and its throttle is a rate limit.
    expect(await answer(() => json('{"code":500,"data":null,"msg":"系统异常","success":false}'))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"code":0,"data":[],"msg":"","success":false}'))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"code":1,"data":null,"msg":"查询过于频繁","success":false}'))).toMatchObject({ kind: 'rate_limited' });
    // A redirect or a missing route is a moved tracker.
    expect(await answer(() => json('{"status":404,"error":"Not Found","path":"//pod/track/query"}', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://www.com1logistics.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{"message":"error"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<!doctype html><html><body>ComOne</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"data":[]}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('ComOne Express replies', () => {
  it('reads the delivered sample: its scans from Shenzhen to Singapore on their wall clocks, with codes and places', () => {
    const result = parseComone(JSON.parse(DELIVERED), SAMPLE);
    const events = result.events ?? [];
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Shipment Delivered',
      last_update: null, last_update_local: '2026-04-29T13:36:13', expected_delivery: null, destination_country: 'SG',
    });
    // The supplier, SPRX-SG, is no catalog carrier.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(events).toHaveLength(19);
    expect(events[0]).toEqual({ local_time: '2026-04-29T13:36:13', description: 'Shipment Delivered', location: 'SgSingapore1',
      provider_code: 'SD', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[1]).toEqual({ local_time: '2026-04-29T11:49:50', description: 'Out For delivery', location: 'Sg,Singapore',
      provider_code: 'OFD', stage: 'out_for_delivery', stage_source: 'carrier_map' });
    expect(events.at(-1)).toEqual({ local_time: '2026-04-14T14:11:55', description: 'Ready The Shipment', provider_code: 'RD',
      stage: 'registered', stage_source: 'carrier_map' });
    expect(events.map((event) => event.stage)).not.toContain(undefined);
    expect(events.filter((event) => event.provider_code === 'ICST').map((event) => [event.location, event.stage]))
      .toEqual([['Sg,Singapore', 'customs'], ['Singapore', 'customs']]);
  });

  it('reads a number in other case and spacing as the reply’s', () => {
    expect(parseComone(reply(parcel()), ` ${SYNTHETIC.slice(0, 4)} ${SYNTHETIC.slice(4)}`)).toMatchObject({ current_stage: 'out_for_delivery' });
  });

  it('never reads the merchant’s order number, the weight, the remarks or the delivery photos', () => {
    const answer = JSON.stringify(parseComone(reply(parcel()), SYNTHETIC));
    for (const hidden of ['SYNTHETIC', 'images.example', '1.5', 'SPRX']) expect(answer).not.toContain(hidden);
  });

  it('turns an oldest-first list round, and keeps a scan the map does not know visible', () => {
    const traces = [...(parcel().traces)].reverse();
    expect(parseComone(reply(parcel({ traces })), SYNTHETIC).events?.map((event) => event.provider_code)).toEqual(['OFD', 'ICST', 'SPU']);
    const unknown = parseComone(reply(parcel({ statusCode: 60, traces: [{ podStatusCode: 'ZZZ', traceEventEn: 'Parked', traceTime: '2030-01-12 10:15' }] })), SYNTHETIC);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Parked', last_update_local: '2030-01-12T10:15:00' });
    expect(unknown.events).toEqual([{ local_time: '2030-01-12T10:15:00', description: 'Parked', provider_code: 'ZZZ' }]);
    // The status the page names stands in when no scan has a stage.
    expect(parseComone(reply(parcel({ statusCode: 90, traces: [{ traceEventEn: 'Parked', traceTime: '2030-01-12 10:15:00' }] })), SYNTHETIC))
      .toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Parked' });
    // A scan without its English wording reads its Chinese one.
    expect(parseComone(reply(parcel({ traces: [{ podStatusCode: 'SD', traceEventEn: '', traceEventCn: '派送成功', traceTime: '2030-01-12 10:15:00' }] })), SYNTHETIC).events)
      .toEqual([{ local_time: '2030-01-12T10:15:00', description: '派送成功', provider_code: 'SD', stage: 'delivered', stage_source: 'carrier_map' }]);
  });

  it('stands a parcel without scans on the step the page names for its status, else on nothing', () => {
    expect(parseComone(reply(parcel({ statusCode: 90, traces: [] })), SYNTHETIC)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, expected_delivery: null, destination_country: 'MY', summary_only: true, events: [],
    });
    expect(() => parseComone(reply(parcel({ statusCode: 30, traces: null })), SYNTHETIC))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('names the carrier ComOne hands the parcel to only when the catalog knows it and its rules fit the number', () => {
    const handoff = (supplierName: unknown, supplierTrackingNo: unknown, number = SYNTHETIC) => {
      const result = parseComone(reply(parcel({ expressNo: number, number, supplierName, supplierTrackingNo })), number);
      return { carrier: result.delivery_carrier, number: result.delivery_tracking_number };
    };
    expect(handoff('Ninja Van', 'nlmy zz 90000000')).toEqual({ carrier: 'ninja-van', number: 'NLMYZZ90000000' });
    expect(handoff('GDEX', 'MY99000000017')).toEqual({ carrier: 'gdex', number: 'MY99000000017' });
    // The supplier delivering under ComOne's own number names no second one.
    expect(handoff('GDEX', '', 'MY99000000017')).toEqual({ carrier: 'gdex', number: undefined });
    for (const [name, reference] of [['GDEX', 'NLMYZZ90000000'], ['SPRX-SG', 'NLMYZZ90000000'], ['Ninja Van', ''], ['ComOne Express', SYNTHETIC],
      ['', 'MY99000000017'], [null, null]]) {
      expect(handoff(name, reference), `${name} ${reference}`).toEqual({ carrier: undefined, number: undefined });
    }
    // A parcel listed without scans names it too.
    expect(() => parseComone(reply(parcel({ statusCode: 30, traces: [], supplierName: 'GDEX', supplierTrackingNo: 'MY99000000017' })), SYNTHETIC))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', deliveryCarrier: 'gdex', deliveryTrackingNumber: 'MY99000000017' }));
  });

  it('keeps the parcel that names the number asked, and refuses an answer for another', () => {
    const other = parcel({ expressNo: '990000000024', number: '990000000024' });
    expect(parseComone(reply(other, parcel()), SYNTHETIC)).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(() => parseComone(JSON.parse(DELIVERED), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseComone(reply(other), SYNTHETIC)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const scan = (fields: Record<string, unknown>) => parcel({ traces: [{ podStatusCode: 'SD', traceEventEn: 'Shipment Delivered', traceTime: '2030-01-12 10:15:00', ...fields }] });
    for (const changed of [null, [], 'x', {}, { code: '0', data: [], success: true }, { code: 0, data: {}, success: true },
      { code: 0, data: null, success: true }, reply(null), reply({ number: SYNTHETIC }), reply(parcel({ expressNo: 7 })),
      reply(parcel({ traces: {} })), reply(parcel({ statusCode: '90' })), reply(parcel({ desCountryId: 7 })), reply(parcel({ traces: [null] })),
      reply(scan({ traceEventEn: '', traceEventCn: '' })), reply(scan({ traceEventEn: 7 })), reply(scan({ podStatusCode: 'S D' })),
      reply(scan({ traceTime: '12/01/2030 10:15' })), reply(scan({ traceTime: '2030-02-30 10:15:00' })), reply(scan({ traceTime: '' })),
      reply(scan({ traceLocation: {} })), reply(...Array.from({ length: 21 }, () => parcel())),
      reply(parcel({ traces: Array.from({ length: 301 }, () => parcel().traces[0]) }))]) {
      expect(() => parseComone(changed, SYNTHETIC), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('ComOne Express statuses', () => {
  it('maps every scan code, and a relayed scan by its whole wording', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), `${entry.code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'comone-express', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('ZZZ', 'shipment delivered')).toBeUndefined();
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
