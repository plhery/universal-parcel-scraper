import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { noHistoryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JOOM_LOGISTICS_API, JoomLogisticsTracker, joomLogisticsLookupUrl } from './adapter.js';
import { isJoomLogisticsNotFound, joomLogisticsRequestNumbers, normalizeJoomLogisticsNumber, parseJoomLogistics } from './parser.js';
import { joomLogisticsMappedStage, joomLogisticsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

type Row = Record<string, unknown>;
type Parcel = Row & { trackingNumber: string; trackingNumbers: string[]; checkpoints: Row[] };
type Reply = { data: Parcel };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** A fixture's reply with its parcel changed in place by `change`. */
const changed = (change: (parcel: Parcel, reply: Reply) => void, name = 'delivered-us'): Reply => {
  const reply = fixture(name);
  change(reply.data, reply);
  return reply;
};

// The public samples the fixtures answer, an invented number, and public GOFO Canada and 5Post numbers.
const US = fixture('delivered-us').data.trackingNumber;
const RU = fixture('delivered-ru').data.trackingNumber;
const DE = fixture('delivered-de').data.trackingNumber;
const UNKNOWN = 'ZZ729461835XX';
const GOFO = 'GFCA01071289947136';
const FIVE_POST = '99970849367338';

const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';
const clocks = (reply: Reply, number: string) => parseJoomLogistics(reply, number).events!
  .map((event) => [event.time ?? event.local_time, event.location ?? null, event.provider_code ?? null, event.stage ?? null]);

describe('Joom Logistics HTTP adapter', () => {
  it('asks the tracker’s interface for the whole number, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered-ru')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JoomLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${RU.toLowerCase().slice(0, 6)} ${RU.slice(6)} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${JOOM_LOGISTICS_API}?trackingNumber=${RU}&lang=en`);
    expect(joomLogisticsLookupUrl('AB 1')).toBe(`${JOOM_LOGISTICS_API}?trackingNumber=AB%201&lang=en`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', Origin: 'https://joomlogistics.com', Referer: 'https://joomlogistics.com/',
      'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(init.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'joom-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps Joom Logistics’ own scans as instants and the relayed ones as wall clocks, newest first', () => {
    const result = parseJoomLogistics(fixture('delivered-ru'), RU);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Package received', last_update: null, last_update_local: '2024-03-13T13:53:42', destination_country: 'RU' });
    for (const field of ['delivery_tracking_number', 'delivery_carrier', 'summary_only']) expect(result).not.toHaveProperty(field);
    expect(clocks(fixture('delivered-ru'), RU)).toEqual([
      ['2024-03-13T13:53:42', 'Yekaterinburg 85, RU', 'confirmedDelivery', 'delivered'],
      ['2024-03-13T07:26:42', null, 'issuingPoint', 'ready_for_pickup'],
      ['2024-03-13T01:44:13', 'Ekaterinburg MSC, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-12T12:08:04', 'Ekaterinburg MSC COSP, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-12T10:51:35', 'Ekaterinburg MSC, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-11T05:58:15', 'Novosibirsk LPC, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-11T03:03:05', 'Novosibirsk LPC MMPO, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-11T03:03:05', 'Novosibirsk LPC MMPO, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-11T02:43:38', 'Novosibirsk LPC Sps-2-Cm, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-11T02:42:45', 'Novosibirsk LPC Sps-2-Cm, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-10T22:39:33', 'Novosibirsk LPTs MMPO UOPK, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-10T10:44:18', 'Novosibirsk LPC MMPO, RU', 'destinationCountry', 'in_transit'],
      ['2024-03-10T10:44:18', 'Novosibirsk LPTs MMPO UOPK, RU', 'destinationCountry', 'customs'],
      ['2024-03-01T11:35:00', 'Changsha, China', 'inTransit', 'in_transit'],
      ['2024-02-29T13:35:34', 'Dongguan', 'inTransit', 'in_transit'],
      ['2024-02-18T09:44:01', 'China', 'originCountry', 'in_transit'],
      ['2024-02-18T07:44:01', 'China', 'originCountry', 'in_transit'],
      ['2024-02-18T01:12:34', null, 'inTransit', 'in_transit'],
      // The order system's own rows, stamped to the millisecond 3.7 s after the warehouse's check-in.
      ['2024-02-17T09:35:46Z', 'CN', 'parcelCheckIn', 'accepted'],
      ['2024-02-16T07:49:07Z', 'CN', 'parcelCheckIn', 'accepted'],
      ['2024-02-16T07:49:04Z', 'Dongguan, CN', 'parcelCheckIn', 'accepted'],
      ['2024-02-03T12:25:31Z', 'Shenzhen, CN', 'informationReceived', 'registered'],
    ]);
    const events = result.events!;
    expect(events.filter((event) => event.time).every((event) => event.local_time === undefined)).toBe(true);
    expect(events.filter((event) => event.local_time).every((event) => event.time === undefined)).toBe(true);
  });

  it('reads the relayed lines’ and posts’ clocks as wall clocks', () => {
    // USPS's rows, relayed without a code, beside Pitney Bowes' own rows for the same moments; the
    // carrier delivers at 13:50 and starts its round at 06:10 local time.
    expect(clocks(fixture('delivered-us'), US)).toEqual([
      ['2023-03-08T13:50:00', 'ARVADA, CO, US', 'confirmedDelivery', 'delivered'],
      ['2023-03-08T06:10:00', null, null, 'out_for_delivery'],
      ['2023-03-07T11:56:00', null, null, 'in_transit'],
      ['2023-03-07T10:41:00', null, null, 'in_transit'],
      ['2023-03-03T11:32:15', 'Sparks, NV, US', 'destinationCountry', 'in_transit'],
      ['2023-03-03T11:32:00', null, null, 'in_transit'],
      ['2023-03-01T00:31:39', 'COMMERCE, CA, US', 'destinationCountry', 'in_transit'],
      ['2023-03-01T00:31:00', null, null, 'in_transit'],
      ['2023-02-28T19:50:17', 'COMMERCE, CA, US', 'destinationCountry', 'in_transit'],
      ['2023-02-28T19:50:00', null, null, 'in_transit'],
      ['2023-02-26T04:23:00', 'LAX', 'destinationCountry', 'in_transit'],
      ['2023-02-25T20:16:00', 'HKG', 'internationalTransit', 'in_transit'],
      // The air line's manifest, twelve minutes before the flight lands at Los Angeles.
      ['2023-02-24T16:00:00', null, 'originCountry', 'in_transit'],
      ['2023-02-24T05:17:36Z', 'Hong Kong, CN', 'inTransit', 'in_transit'],
      ['2023-02-21T10:37:33Z', 'Hong Kong, CN', 'inTransit', 'in_transit'],
      ['2023-02-21T02:38:48', null, null, 'in_transit'],
      ['2023-02-20T06:07:08', 'Hong Kong', 'originCountry', 'accepted'],
      ['2023-02-17T08:00:00', 'KIX', 'originCountry', 'accepted'],
      ['2023-02-14T17:10:21Z', 'HIGASHI-OSAKA, JP', 'informationReceived', 'registered'],
    ]);
    // SEKO's flight from Hong Kong to Liège: 12h15 between the two airports' wall clocks, 5h15 read as UTC.
    const flight = parseJoomLogistics(fixture('delivered-de'), DE).events!.filter((event) => /^International flight/.test(event.description!));
    expect(flight.map((event) => [event.local_time, event.location])).toEqual([
      ['2022-11-18T20:20:00', 'Liège, Belgium'], ['2022-11-18T15:05:00', 'Hong Kong, Hong Kong']]);
    expect(flight.every((event) => event.time === undefined)).toBe(true);
    expect(clocks(fixture('delivered-de'), DE).slice(-4)).toEqual([
      ['2022-11-14T05:04:41Z', 'Hong Kong, CN', 'inTransit', 'in_transit'],
      ['2022-11-11T10:47:40Z', 'Hong Kong, CN', 'inTransit', 'in_transit'],
      ['2022-11-11T08:49:29Z', 'Hong Kong, CN', 'originCountry', 'accepted'],
      ['2022-11-03T07:07:08Z', 'KADOMA, JP', 'informationReceived', 'registered'],
    ]);
  });

  it('keeps a wall clock for a scan in the destination country, without one, or without a code', () => {
    const scan = (row: Row) => parseJoomLogistics(changed((parcel) => {
      parcel.checkpoints.push({ operationTime: '2023-03-09T10:00:00.250Z', time: '2023-03-09T10:00:00.250Z', message: 'Sample scan', ...row });
    }), US).events![0]!;
    expect(scan({ event: 'inTransit', country: 'CN' })).toMatchObject({ time: '2023-03-09T10:00:00Z', location: 'CN' });
    expect(scan({ event: 'originCountry', country: 'JP', location: 'Osaka' })).toMatchObject({ time: '2023-03-09T10:00:00Z', location: 'Osaka, JP' });
    expect(scan({ event: 'parcelCheckIn' })).toMatchObject({ time: '2023-03-09T10:00:00Z' });
    for (const row of [{ event: 'inTransit', country: 'US' }, { event: 'inTransit' }, { event: 'originCountry', location: 'Hong Kong' },
      { country: 'CN' }, { event: 'destinationCountry', country: 'CN' }, { event: 'internationalTransit', country: 'CN' }]) {
      expect(scan(row), JSON.stringify(row)).toMatchObject({ local_time: '2023-03-09T10:00:00' });
      expect(scan(row), JSON.stringify(row)).not.toHaveProperty('time');
    }
    // Without a destination, a country before the border cannot be told from one after it.
    const undirected = parseJoomLogistics(changed((parcel) => {
      delete parcel.destinationCountry;
      parcel.checkpoints.push({ operationTime: '2023-03-09T10:00:00Z', event: 'inTransit', country: 'CN', message: 'Sample scan' });
    }), US);
    expect(undirected.events![0]).toMatchObject({ local_time: '2023-03-09T10:00:00' });
    expect(undirected).not.toHaveProperty('destination_country');
  });

  it('lets the reply’s delivered flag decide when the last scan does not', () => {
    const outForDelivery = (delivered: boolean) => parseJoomLogistics(changed((parcel) => {
      parcel.checkpoints.pop();
      parcel.delivered = delivered;
    }), US);
    expect(outForDelivery(false)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'Delivery in progress', last_update_local: '2023-03-08T06:10:00' });
    expect(outForDelivery(true)).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery in progress' });
    // A newer note that moves nothing leaves the delivery standing; one the map does not know keeps its wording.
    const noted = parseJoomLogistics(changed((parcel) => {
      parcel.delivered = false;
      parcel.checkpoints.push({ operationTime: '2023-03-09T10:00:00Z', message: 'Data from the trading platform received' });
    }), US);
    expect(noted).toMatchObject({ current_stage: 'delivered', last_status_text: 'Data from the trading platform received' });
    expect(noted.events![0]).not.toHaveProperty('stage');
    const unknown = parseJoomLogistics(changed((parcel) => {
      parcel.checkpoints.push({ operationTime: '2023-03-09T10:00:00Z', message: 'Sample note' });
    }), US);
    expect(unknown).toMatchObject({ current_stage: 'delivered', last_status_text: 'Sample note' });
  });

  it('keeps a scan listed twice once, and sorts scans by their clock', () => {
    expect(parseJoomLogistics(changed((parcel) => parcel.checkpoints.push(parcel.checkpoints.at(-1)!)), US).events).toHaveLength(19);
    // Russian Post's rows of one second come a millisecond apart, which orders them.
    const reversed = parseJoomLogistics(changed((parcel) => parcel.checkpoints.reverse(), 'delivered-ru'), RU);
    expect(reversed.events).toEqual(parseJoomLogistics(fixture('delivered-ru'), RU).events);
    // Two rows of the same instant keep the reply's order, read backwards.
    const descriptions = (reply: Reply) => parseJoomLogistics(reply, DE).events!.map((event) => event.description);
    const listed = descriptions(fixture('delivered-de'));
    expect(listed.slice(7, 9)).toEqual(['Package is ready for customs clearance', 'Package cleared customs']);
    expect(descriptions(changed((parcel) => parcel.checkpoints.reverse(), 'delivered-de')))
      .toEqual([...listed.slice(0, 7), listed[8], listed[7], ...listed.slice(9)]);
  });

  it('reads a parcel without scans as listed, or as delivered when the reply says so', async () => {
    const empty = (change: (parcel: Parcel) => void = () => undefined) => changed((parcel) => {
      parcel.checkpoints = [];
      parcel.delivered = false;
      change(parcel);
    });
    expect(() => parseJoomLogistics(empty(), US))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseJoomLogistics(empty((parcel) => { delete (parcel as Row).checkpoints; }), US))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    // A listed parcel still proposes the number its delivering carrier tracks it by.
    const listed = Promise.resolve().then(() => parseJoomLogistics(empty((parcel) => { parcel.actualTrackingNumber = GOFO; }), US));
    await expect(listed.catch((error) => noHistoryHandoff('joom-logistics', US, error)))
      .resolves.toMatchObject({ carrier: 'gofo-ca', number: GOFO });
    expect(parseJoomLogistics(empty((parcel) => { parcel.delivered = true; }), US)).toEqual({ status: 'delivered', current_stage: 'delivered',
      current_stage_source: 'carrier_map', last_status_text: null, last_update: null, summary_only: true, destination_country: 'US', events: [] });
  });

  it('hands the parcel to the number its delivering carrier tracks it by, naming the carrier only when one rule claims it', () => {
    const actual = (number: unknown) => parseJoomLogistics(changed((parcel) => { parcel.actualTrackingNumber = number; }), US);
    expect(actual(GOFO)).toMatchObject({ delivery_carrier: 'gofo-ca', delivery_tracking_number: GOFO });
    expect(actual(` ${GOFO.toLowerCase()} `)).toMatchObject({ delivery_carrier: 'gofo-ca', delivery_tracking_number: GOFO });
    // Several carriers' rules share fourteen digits.
    const shared = actual(FIVE_POST);
    expect(shared).toMatchObject({ delivery_tracking_number: FIVE_POST });
    expect(shared).not.toHaveProperty('delivery_carrier');
    for (const number of [US, US.toLowerCase(), '', null, undefined, 'not a number']) {
      const result = actual(number);
      expect(result, String(number)).not.toHaveProperty('delivery_tracking_number');
      expect(result, String(number)).not.toHaveProperty('delivery_carrier');
    }
  });

  it('reads the interface’s answer naming the number as not found, and no other 404', async () => {
    const lookup = (response: () => Response, number = UNKNOWN) =>
      carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number });
    await expect(lookup(() => json(fixture('not-found'), { status: 404 })))
      .rejects.toMatchObject({ kind: 'not_found', message: 'Joom Logistics has no parcel under this number' });
    expect(isJoomLogisticsNotFound(fixture('not-found'), UNKNOWN)).toBe(true);
    // The answer for another number, another 404 body, or a page under 404 is a moved or changed route.
    await expect(lookup(() => json(fixture('not-found'), { status: 404 }), US)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json({ type: 'api.bad_request', message: 'failed to get tracking by tracking number ZZ729461835XX' }, { status: 404 })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json('', { status: 404 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'schema' });
    // The not-found answer under HTTP 200 is not a parcel.
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks a reference in the hyphenated layout with its hyphens first, then as given', async () => {
    // A public sample the tracker finds only with its hyphens; the reply is a fixture filed under it.
    const printed = 'EL356-230927-0298';
    const bare = 'EL3562309270298';
    const asked = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) =>
      fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('trackingNumber'));
    const found = vi.fn<typeof fetch>().mockResolvedValue(json(changed((parcel) => {
      parcel.trackingNumber = printed;
      parcel.trackingNumbers = [printed];
    })));
    await expect(carrier(found).track({ number: bare })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(asked(found)).toEqual([printed]);
    // Unknown with its hyphens, it is asked as given; unknown both ways, it is not found.
    const missing = vi.fn<typeof fetch>().mockImplementation(async (url) => json({ type: 'api.not_found',
      message: `failed to get tracking by tracking number ${new URL(String(url)).searchParams.get('trackingNumber')}` }, { status: 404 }));
    await expect(carrier(missing).track({ number: printed })).rejects.toMatchObject({ kind: 'not_found' });
    expect(asked(missing)).toEqual([printed, bare]);
    // Another failure is not retried in the other form.
    const refused = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 403 }));
    await expect(carrier(refused).track({ number: bare })).rejects.toMatchObject({ kind: 'challenge' });
    expect(new Set(asked(refused))).toEqual(new Set([printed]));
    // Other numbers, and a group that is no date, are asked as given.
    expect(joomLogisticsRequestNumbers('EL3562313270298')).toEqual(['EL3562313270298']);
    expect(joomLogisticsRequestNumbers(RU)).toEqual([RU]);
  });

  it('keeps a refusal, a browser check, a moved route and a broken reply apart from not found', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: US });
    await expect(lookup(() => new Response('<html><body>Forbidden</body></html>', { status: 403, headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json({ type: 'api.forbidden' }, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    // The site's own page in place of the reply.
    await expect(lookup(() => new Response('<!DOCTYPE html><html><head><title>Joom Logistics</title></head><body><div id=__next></div></body></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json('{"data":'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json('', { status: 302, headers: { Location: 'https://joomlogistics.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json('', { status }));
    await expect(carrier(fetcher).track({ number: US })).rejects.toMatchObject({ kind });
  });

  it('keeps only a parcel filed under the whole number asked', () => {
    expect(() => parseJoomLogistics(fixture('delivered-us'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Joom Logistics answered for another parcel' }));
    expect(() => parseJoomLogistics(fixture('delivered-us'), US.slice(0, -1)))
      .toThrow(expect.objectContaining({ message: 'Joom Logistics answered for another parcel' }));
    expect(() => parseJoomLogistics(changed((parcel) => { parcel.trackingNumber = UNKNOWN; parcel.trackingNumbers = [UNKNOWN]; }), US))
      .toThrow(expect.objectContaining({ message: 'Joom Logistics answered for another parcel' }));
    // The parcel's other numbers name it too.
    expect(parseJoomLogistics(changed((parcel) => { parcel.trackingNumber = UNKNOWN; parcel.trackingNumbers = [UNKNOWN, US]; }), US).events)
      .toHaveLength(19);
    expect(parseJoomLogistics(changed((parcel) => { parcel.trackingNumber = RU.toLowerCase(); }, 'delivered-ru'), RU).events).toHaveLength(22);
  });

  it('rejects a changed reply', () => {
    const row = (change: (row: Row) => void) => changed((parcel) => change(parcel.checkpoints.at(-1)!));
    for (const [index, reply] of [
      fixture('delivered-us').data,
      { data: [fixture('delivered-us').data] },
      { data: null },
      changed((parcel) => { delete (parcel as Row).trackingNumber; }),
      changed((parcel) => { (parcel as Row).trackingNumber = 4208; }),
      changed((parcel) => { (parcel as Row).trackingNumbers = US; }),
      changed((parcel) => { (parcel as Row).trackingNumbers = [US, 7]; }),
      changed((parcel) => { parcel.trackingNumbers = Array.from({ length: 21 }, () => US); }),
      changed((parcel) => { parcel.delivered = 'true'; }),
      changed((parcel) => { parcel.destinationCountry = 840; }),
      changed((parcel) => { parcel.actualTrackingNumber = 4208; }),
      changed((parcel) => { (parcel as Row).checkpoints = {}; }),
      changed((parcel) => { parcel.checkpoints = Array.from({ length: 301 }, () => parcel.checkpoints[0]!); }),
      changed((parcel) => { parcel.checkpoints[0] = 'scan' as unknown as Row; }),
      row((scan) => { scan.operationTime = '2023-03-08 13:50:00'; }),
      row((scan) => { scan.operationTime = '2023-03-08T13:50:00'; }),
      row((scan) => { scan.operationTime = '2023-03-08T13:50:00+01:00'; }),
      row((scan) => { scan.operationTime = '2023-02-30T13:50:00Z'; }),
      row((scan) => { scan.operationTime = '2023-03-08T24:00:00Z'; }),
      row((scan) => { scan.operationTime = ''; }),
      row((scan) => { delete scan.operationTime; }),
      row((scan) => { scan.operationTime = 1678283400000; }),
      row((scan) => { scan.message = ''; }),
      row((scan) => { scan.message = null; }),
      row((scan) => { scan.event = 7; }),
      row((scan) => { scan.country = 840; }),
      row((scan) => { scan.location = ['ARVADA']; }),
    ].entries()) {
      expect(() => parseJoomLogistics(reply, US), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('refuses what is not a number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'ABC', 'ABCDEFGH', '1'.repeat(41), `${US},${RU}`, 'RA10398413#MN', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: US }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJoomLogisticsNumber(` ${RU.slice(0, 2).toLowerCase()} ${RU.slice(2, 7)}-${RU.slice(7)} `)).toBe(RU);
    expect(normalizeJoomLogisticsNumber(DE)).toBe(DE);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: US }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed under Joom Logistics to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered-de')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DE, carrier: 'joom-logistics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'joom-logistics', source: 'joom-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(JOOM_LOGISTICS_API))).toBe(true);
  });
});

describe('Joom Logistics status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string | null }[]) {
      const answer = statusMapAnswer({ carrier: 'joom-logistics', providerCode: entry.code ?? null, description: entry.wording });
      const label = `${entry.code ?? '-'} ${entry.wording}`;
      if (entry.stage === null) {
        expect(answer, label).toEqual({ kind: 'intentional_gap', note: expect.any(String) });
        expect(joomLogisticsStage(entry.code ?? null, entry.wording), label).toBeNull();
        continue;
      }
      expect(answer, label).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(joomLogisticsStage(entry.code ?? null, entry.wording), label).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('stages the fixtures’ every scan by the map', () => {
    for (const [name, number] of [['delivered-us', US], ['delivered-ru', RU], ['delivered-de', DE]] as const) {
      expect(parseJoomLogistics(fixture(name), number).events!.every((event) => event.stage_source === 'carrier_map'), name).toBe(true);
    }
  });

  it('leaves an unknown code and wording to the shared rules', () => {
    expect(statusMap.stage('sampleCode', 'sample note')).toBeUndefined();
    expect(joomLogisticsMappedStage(null, 'sample note')).toBeUndefined();
    expect(joomLogisticsStage(null, 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(joomLogisticsStage(null, 'Sample note')).toBeNull();
    // A code the map knows stages a wording it does not.
    expect(joomLogisticsStage('destinationCountry', 'Sample note')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'joom-logistics', providerCode: 'sampleCode', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
