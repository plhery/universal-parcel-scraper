import { constants, createHash, generateKeyPairSync, privateDecrypt, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { keepAdapterHolds, resetAdapterHolds, serviceTag, type AdapterHold } from '../../core/runner/holds.js';
import { adapter, CAINIAO_UNKNOWN_MS, IMILE_API, IMILE_SIGNING, IMILE_SIGNING_SAMPLES, ImileTracker, imileSignature, type ImileSigning } from './adapter.js';
import { cainiaoScans, withCainiaoLeg } from './cainiao.js';
import { imileReceiver, imileSummary, imileWording, normalizeImileNumber, parseImile } from './parser.js';
import { imileRelayedStage, imileStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '6000000000001';
const IN_TRANSIT = '6000000000002';
const UNKNOWN = '6000000000000';
// A waybill made on 1 January 2024, as the dated layout writes it.
const DATED = '6010124000001';

type Row = Record<string, unknown>;
type Shipment = Row & { trackInfos: Row[] };
type Reply = Row & { resultObject: Shipment };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** Cainiao's global feed, which holds the China leg of the parcels Cainiao hands to iMile. */
const CAINIAO_DETAIL = 'https://global.cainiao.com/global/detail.json';
type CainiaoReply = { module: (Row & { detailList: Row[] })[] };
const cainiaoFixture = () => JSON.parse(readFileSync(new URL('./fixtures/cainiao-delivered.json', import.meta.url), 'utf8')) as CainiaoReply;
/** Cainiao's answer for a number it has no record of. */
const cainiaoUnknown = (number: string) => ({ module: [{ mailNo: number, mailNoSource: 'EXTERNAL', detailList: [] }], success: true });
const toCainiao = ([url]: Parameters<typeof fetch>) => String(url).startsWith(`${CAINIAO_DETAIL}?`);
/** The requests a lookup made to iMile itself. */
const imileCalls = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.filter((call) => !toCainiao(call));
const changed = (name: string, change: (shipment: Shipment, reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply.resultObject, reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** iMile's refusal of a lookup that came too soon after the one before it. */
const throttled = () => reply({ status: 'failure', resultCode: 'TRACK_QUERY_RATE_LIMIT', resultObject: null, message: 'Too many requests', traceId: '' },
  { status: 429 });

afterEach(() => {
  vi.useRealTimers();
});

// Two synthetic key pairs: the page's values, and the ones it changes to.
const pair = (salt: string) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, signing: { key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), salt } };
};
const FIRST = pair('syntheticSalt');
const SECOND = pair('otherSalt');
const decrypt = (privateKey: KeyObject, sign: string) => privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(sign, 'base64')).toString();

const SAMPLES: readonly string[] = IMILE_SIGNING_SAMPLES;
const isSample = (url: unknown) => SAMPLES.includes(new URL(String(url)).searchParams.get('waybillNo') ?? '');

/**
 * iMile's site: the lookup answers a shipment, the public samples' among them unless
 * left out, only when its sign decrypts to the number under the key in use, and the
 * same empty reply otherwise.
 */
function site(key: { privateKey: KeyObject; signing: ImileSigning }, shipments: Record<string, unknown>,
  pages: { samples?: readonly string[]; sample?: () => Response; cainiao?: (number: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  const answered: Record<string, unknown> = { ...Object.fromEntries((pages.samples ?? SAMPLES)
    .map((sample) => [sample, changed('delivered', (shipment) => { shipment.waybillNo = sample; })])), ...shipments };
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` === CAINIAO_DETAIL) {
      const number = url.searchParams.get('mailNos')!;
      return pages.cainiao?.(number, init) ?? reply(cainiaoUnknown(number));
    }
    if (`${url.origin}${url.pathname}` === IMILE_API) {
      const number = url.searchParams.get('waybillNo')!;
      if (pages.sample && SAMPLES.includes(number)) return pages.sample();
      const sign = new Headers(init?.headers).get('sign') ?? '';
      let known = false;
      // A ciphertext from another key can also fail RSA decoding. The service
      // rejects either case with its empty reply, rather than a network error.
      try { known = answered[number] !== undefined && decrypt(key.privateKey, sign) === number; } catch { /* Rejected signature. */ }
      return reply(known ? answered[number] : fixture('not-found'));
    }
    throw new Error(`unexpected request to ${String(input)}`);
  });
}

describe('iMile HTTP adapter', () => {
  it('asks the tracking page’s lookup once in English, signed as the page signs it, through the supplied transport', async () => {
    const fetcher = site(FIRST, { [IN_TRANSIT]: fixture('in-transit') });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ImileTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0', signing: FIRST.signing }).fetch(' 6000-0000-00002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'customs' });
    // iMile once, then Cainiao for the leg before iMile's.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${CAINIAO_DETAIL}?mailNos=${IN_TRANSIT}&lang=en-US`);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    const [url, init] = fetcher.mock.calls[0]!;
    const code = createHash('md5').update(`${IN_TRANSIT}syntheticSalt`).digest('hex');
    expect(String(url)).toBe(`${IMILE_API}?waybillNo=${IN_TRANSIT}&code=${code}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', lang: 'en_US', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(decrypt(FIRST.privateKey, (init!.headers as Record<string, string>).sign!)).toBe(IN_TRANSIT);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'imile', step: 'direct', outcome: 'ok' }));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'imile', step: 'cainiao', attempt: 2, outcome: 'not_found' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('signs as the tracking page signed', () => {
    const { code, sign } = imileSignature('CNBR00000000001', SECOND.signing);
    expect(code).toBe(createHash('md5').update('CNBR00000000001otherSalt').digest('hex'));
    expect(decrypt(SECOND.privateKey, sign)).toBe('CNBR00000000001');
    // The values shipped with the adapter read as a key.
    expect(imileSignature(DELIVERED, IMILE_SIGNING).sign).toMatch(/^[A-Za-z0-9+/]{342}==$/);
    // The samples are public numbers.
    const numbers = JSON.parse(readFileSync(new URL('./numbers.json', import.meta.url), 'utf8')) as { records: { number: string }[] };
    expect(SAMPLES.every((sample) => numbers.records.some(({ number }) => number === sample))).toBe(true);
  });

  it('places each scan on the recipient country’s clock and stages it by its code and sentence', () => {
    const result = parseImile(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'SMP: Clearance start.', last_update: '2026-06-04T02:15:00-05:00', expected_delivery: null,
      destination_country: 'CO' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map((event) => [event.time, event.provider_code ?? null, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-06-04T02:15:00-05:00', null, 'customs', null],
      ['2026-06-03T23:15:00-05:00', '1002', 'customs', null],
      // The flight booked before it, still to come, is left out.
      ['2026-06-02T18:00:00-05:00', '1002', 'in_transit', null],
      ['2026-05-31T12:02:11-05:00', '2005', 'accepted', 'Sample Origin Center'],
      ['2026-05-31T08:40:00-05:00', null, 'registered', null],
      ['2026-05-30T19:16:16-05:00', '1001', 'registered', null],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Flight Schedule/);
    // A scan the booked flight follows keeps its own words.
    const received = parseImile(changed('in-transit', (shipment) => {
      shipment.trackInfos[3]!.content = 'Origin port warehouse receive，Flight Schedule ETD【HKG】<2026-06-03 02:00:00>, ETA【SMP】<2026-06-03 12:00:00>.';
      shipment.trackInfos[3]!.trackStage = null;
    }), IN_TRANSIT);
    expect(received.events![3]).toMatchObject({ description: 'Origin port warehouse receive', stage: 'in_transit' });
    // The last-mile number names no courier, so there is no hand-off.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLELM|delivery_tracking_number|Sample Origin Center"?,"dispatch/);
  });

  it('reads the delivery day iMile books until an attempt, a problem or the end comes after it', () => {
    // Delivered: the booking stands no more.
    expect(parseImile(fixture('delivered'), DELIVERED).expected_delivery).toBeNull();
    const upTo = (content: string, change: (rows: Row[]) => void = () => {}) => parseImile(changed('delivered', (shipment) => {
      shipment.trackInfos = shipment.trackInfos.slice(shipment.trackInfos.findIndex((row) => String(row.content).startsWith(content)));
      change(shipment.trackInfos);
    }), DELIVERED);
    // Booked after the failed attempt, then out for delivery that day.
    expect(upTo('Shipment is scheduled')).toMatchObject({ current_stage: 'failed_attempt', expected_delivery: '2026-05-20' });
    expect(upTo('Our delivery associate is out for delivery.You can contact him by clicking +000 500000000'))
      .toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: '2026-05-20' });
    // A booking a failed attempt follows is spent, as is one for a day before the newest scan's.
    expect(upTo('Shipment is scheduled', (rows) => rows.unshift({ ...rows[2]!, time: '2026-05-20 13:00:00' })).expected_delivery).toBeNull();
    expect(upTo('Shipment is scheduled', (rows) => { rows[0]!.content = 'Shipment is scheduled to [2026-05-19] .'; }).expected_delivery).toBeNull();
    // Without a booking there is no day.
    expect(upTo('Delivery attempt finished').expected_delivery).toBeNull();
  });

  it('reads the end of an attempt after the driver’s reason as that attempt, and alone as one', () => {
    const upTo = (content: string, change: (rows: Row[]) => void = () => {}) => parseImile(changed('delivered', (shipment) => {
      shipment.trackInfos = shipment.trackInfos.slice(shipment.trackInfos.findIndex((row) => String(row.content).startsWith(content)));
      change(shipment.trackInfos);
    }), DELIVERED);
    const after = upTo('Delivery attempt finished');
    expect(after).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Delivery attempt finished,return to Local logistics company warehouse.' });
    expect(after.events!.slice(0, 2).map((event) => event.stage_source)).toEqual(['none', 'carrier_map']);
    const alone = upTo('Delivery attempt finished', (rows) => rows.splice(1, 1));
    expect(alone.events![0]).toMatchObject({ stage: 'failed_attempt', stage_source: 'carrier_map' });
  });

  it('keeps the delivery and who took it, without the driver’s phone, its proof or the repeated scan', () => {
    const result = parseImile(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your order has been delivered successfully, Receiver Type: Self.', last_update: '2026-05-20T15:42:10+03:00',
      destination_country: 'SA', signed_by: 'Self' });
    expect(result.events).toHaveLength(15);
    expect(result.events!.slice(0, 8).map((event) => [event.provider_code, event.stage ?? null, event.description])).toEqual([
      ['2060', 'delivered', 'Your order has been delivered successfully, Receiver Type: Self.'],
      ['1003', 'out_for_delivery', 'Our delivery associate is out for delivery.'],
      // A delivery day booked moves nothing.
      ['1003', null, 'Shipment is scheduled to [2026-05-20].'],
      // The attempt's end after the driver's reason is the same attempt.
      ['1003', 'failed_attempt', 'Delivery attempt finished,return to Local logistics company warehouse.'],
      ['1003', 'failed_attempt', 'User not at home'],
      ['1003', 'out_for_delivery', 'Our delivery associate is out for delivery.'],
      ['1003', 'in_transit', 'Your order has assigned delivery drvier.'],
      ['1003', 'in_transit', 'Your order has arrived at SMP DS01'],
    ]);
    // A name opening a scan is its centre, which the location shows, or else heads the sentence.
    expect(result.events!.slice(9, 14).map((event) => [event.stage ?? null, event.description, event.location ?? null])).toEqual([
      ['in_transit', 'Your order has been received.', 'Sample Distribution Center'],
      ['in_transit', 'SMP: AirPlane clearance finish,ready to ship to Sample Distribution Center.', null],
      ['customs', 'Clearance Processing', null],
      ['customs', 'SMP: Flight Arrived - Waiting for customs clearance.', null],
      ['in_transit', 'HKG: The flight has taken off.', null],
    ]);
    // The flight booked for the parcel is still to come: no scan.
    expect(JSON.stringify(result)).not.toMatch(/Flight Schedule/);
    expect(result.events!.find((event) => event.description === 'Clearance Processing')).toMatchObject({ stage: 'customs' });
    expect(result.events!.find((event) => event.description === 'Clearance Processing')).not.toHaveProperty('provider_code');
    expect(JSON.stringify(result)).not.toMatch(/viewPic|example\.invalid|contact him|\+000|0500000001/);
    // The delivery's station is the depot the courier set out from; the delivery run keeps it.
    expect(result.events![0]).not.toHaveProperty('location');
    expect(result.events![1]).toMatchObject({ location: 'SMP DS01' });
    // A delivery left in the mail box says so.
    const mailbox = parseImile(changed('delivered', (shipment) => {
      shipment.trackInfos[0]!.content = 'Your order has been delivered successfully, Receiver Type:【Mail box】.';
    }), DELIVERED);
    expect(mailbox).toMatchObject({ current_stage: 'delivered', last_status_text: 'Your order has been delivered successfully, Receiver Type: Mail box.' });
    expect(mailbox).not.toHaveProperty('signed_by');
    expect(mailbox.events![0]).not.toHaveProperty('location');
    // Without a code, the sentence still reads as the delivery.
    const uncoded = parseImile(changed('delivered', (shipment) => {
      Object.assign(shipment.trackInfos[0]!, { content: 'Your order has been delivered successfully, Receiver Type:【Mail box】.', trackStage: null, trackStageTx: null });
    }), DELIVERED);
    expect(uncoded.events![0]).toMatchObject({ stage: 'delivered', description: 'Your order has been delivered successfully, Receiver Type: Mail box.' });
    // The Brazilian wording names who took the parcel; the sentence still reads as the delivery without its code.
    const named = parseImile(changed('delivered', (shipment) => {
      Object.assign(shipment.trackInfos[0]!, { content: '【DS SMP】Your package was received by 【Sample Person】. If you have any questions, please contact us.',
        trackStage: null, trackStageTx: null });
    }), DELIVERED);
    expect(named).toMatchObject({ current_stage: 'delivered', signed_by: 'Sample Person',
      last_status_text: 'DS SMP: Your package was received by Sample Person.' });
  });

  it('reads return handling as a return under way, until the sender has the parcel back', () => {
    const failed = parseImile(changed('delivered', (shipment) => {
      Object.assign(shipment.trackInfos[0]!, { trackStage: 1008, trackStageTx: 'Return Handling Process',
        content: 'Order delivery failed, returning to sender. If you have any question, please contact us through cs  ' });
    }), DELIVERED);
    expect(failed).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Order delivery failed, returning to sender.' });
    // A centre receiving the parcel and a driver's reason are the way back.
    for (const content of ['【Sample Hub】Shipment received.', '<No Answer>']) {
      const back = parseImile(changed('delivered', (shipment) => {
        Object.assign(shipment.trackInfos[0]!, { trackStage: 1008, trackStageTx: 'Return Handling Process', content });
      }), DELIVERED);
      expect(back).toMatchObject({ current_stage: 'exception', last_status_text: content === '<No Answer>' ? 'No Answer' : 'Sample Hub: Shipment received.' });
    }
    const signed = parseImile(changed('delivered', (shipment) => {
      Object.assign(shipment.trackInfos[0]!, { trackStage: 2065, trackStageTx: 'Returned to Client', content: '【Sample Hub】Return signature' });
    }), DELIVERED);
    expect(signed).toMatchObject({ current_stage: 'returned' });
  });

  it('reads the scans after a return starts under ordinary codes as the way back, until a delivery run', () => {
    const row = (time: string, trackStage: number, content: string) => ({ content, trackStage, trackStageTx: null, time, operateStationName: 'Sample DS', proofs: null });
    const back = [
      row('2026-05-23 15:52:54', 1002, 'Your order has arrived at Sample RDC'),
      row('2026-05-23 13:03:26', 1002, 'Your order has been shipped from Sample DS.'),
      row('2026-05-20 15:18:07', 2004, 'Your order has been received.'),
      row('2026-05-20 15:18:01', 2084, 'Start returning，reason:[Three delivery attempts failed]'),
      row('2026-05-20 15:17:58', 2084, 'Three delivery attempts failed: need to return.'),
    ];
    const returning = parseImile(changed('delivered', (shipment) => { shipment.trackInfos.splice(0, 3, ...back); }), DELIVERED);
    expect(returning).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Your order has arrived at Sample RDC', expected_delivery: null });
    expect(returning.events!.slice(0, 5).map((event) => [event.stage, event.provider_leg])).toEqual([
      ['exception', 'return'], ['exception', 'return'], ['exception', 'return'], ['exception', 'return'], ['exception', undefined]]);
    // The way back under Return Handling Process keeps its own reading.
    const handled = parseImile(changed('delivered', (shipment) => {
      shipment.trackInfos.splice(0, 3, row('2026-05-21 10:00:00', 1008, '【Sample Hub】Shipment received.'),
        row('2026-05-20 22:01:39', 1008, 'Order delivery failed, returning to sender.'));
    }), DELIVERED);
    expect(handled.events!.slice(0, 2).map((event) => [event.stage, event.provider_leg])).toEqual([['exception', 'return'], ['exception', 'return']]);
    // A delivery run after the return started takes the parcel out to the recipient again.
    const resumed = parseImile(changed('delivered', (shipment) => {
      shipment.trackInfos.splice(0, 3, row('2026-05-21 12:00:00', 1002, 'Your order has arrived at Sample RDC'),
        row('2026-05-21 09:05:33', 1003, 'Our delivery associate is out for delivery.'), ...back.slice(2));
    }), DELIVERED);
    expect(resumed.events!.slice(0, 4).map((event) => [event.stage, event.provider_leg])).toEqual([
      ['in_transit', undefined], ['out_for_delivery', undefined], ['exception', 'return'], ['exception', 'return']]);
    expect(resumed.current_stage).toBe('in_transit');
  });

  it('reads a pickup point notice, its names in 【】 as the page writes them, as waiting there', () => {
    const waiting = parseImile(changed('delivered', (shipment) => {
      Object.assign(shipment.trackInfos[0]!, { trackStage: 1003,
        content: 'The parcel has been delivered to 【Sample Shop】. Please collect your parcel promptly at 【Sample Street 1】 using your pickup code.' });
    }), DELIVERED);
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'The parcel has been delivered to Sample Shop. Please collect your parcel promptly at Sample Street 1 using your pickup code.' });
  });

  it('reads a history listed oldest first newest first, as the page shows it', () => {
    const result = parseImile(changed('in-transit', (shipment) => { shipment.trackInfos.reverse(); }), IN_TRANSIT);
    expect(result).toMatchObject({ last_update: '2026-06-04T02:15:00-05:00', current_stage: 'customs' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '1001' });
  });

  it('places New Zealand’s scans on Auckland’s clock, Australia’s on Sydney’s and Peru’s on Lima’s', () => {
    const placed = (country: string) => parseImile(changed('in-transit', (shipment) => { shipment.country = country; }), IN_TRANSIT);
    expect(placed('NZL')).toMatchObject({ last_update: '2026-06-04T02:15:00+12:00', destination_country: 'NZ' });
    expect(placed('AUS')).toMatchObject({ last_update: '2026-06-04T02:15:00+10:00', destination_country: 'AU' });
    // A Queensland hub's scan on Sydney's summer time, which Brisbane does not keep.
    const queensland = parseImile(changed('in-transit', (shipment) => {
      shipment.country = 'AUS';
      shipment.trackInfos[0]!.time = '2026-11-05 19:11:40';
      shipment.trackInfos[0]!.operateStationName = 'Example Coast Hub';
    }), IN_TRANSIT);
    expect(queensland.events![0]).toMatchObject({ time: '2026-11-05T19:11:40+11:00' });
    expect(placed('PER')).toMatchObject({ last_update: '2026-06-04T02:15:00-05:00', destination_country: 'PE' });
    // A delivery at an Auckland station on New Zealand's summer time, not China's clock.
    const delivered = parseImile(changed('delivered', (shipment) => {
      shipment.country = 'NZL';
      shipment.trackInfos[0]!.time = '2026-11-01 15:08:15';
      shipment.trackInfos[0]!.operateStationName = 'AucklandDS';
    }), DELIVERED);
    expect(delivered).toMatchObject({ current_stage: 'delivered', last_update: '2026-11-01T15:08:15+13:00' });
    expect(delivered.events![0]).toMatchObject({ time: '2026-11-01T15:08:15+13:00' });
  });

  it('keeps the wall clocks of a country with several zones or none named', () => {
    for (const country of ['MEX', 'BRA', 'USA', 'XXX', '']) {
      const result = parseImile(changed('in-transit', (shipment) => { shipment.country = country; }), IN_TRANSIT);
      expect(result).toMatchObject({ last_update: null, last_update_local: '2026-06-04T02:15:00' });
      expect(result.events!.every((event) => event.time === undefined && event.local_time !== undefined)).toBe(true);
    }
  });

  it('dates the scans away from a country of several zones on its main clock, not the clock where they happened', () => {
    // A Mexican parcel as iMile shows it: the Shenzhen centre's scans fourteen hours behind the forwarder's
    // copy of them on Beijing's clock, because iMile gives every scan on Mexico's clock.
    const row = (time: string, trackStage: number | null, content: string, operateStationName: string | null = null) =>
      ({ content, trackStage, trackStageTx: null, time, operateStationName, proofs: null });
    const result = parseImile(changed('delivered', (shipment) => {
      shipment.country = 'MEX';
      shipment.trackInfos = [
        row('2026-04-13 17:11:47', 2060, 'Your order has been delivered successfully.'),
        row('2026-04-09 16:23:02', 1002, 'Your order has arrived at Mexico Center', 'Mexico Center'),
        row('2026-04-03 10:00:00', 1002, 'Flight Arrived - Waiting for customs clearance.'),
        row('2026-04-02 10:00:00', 1002, '【HKG】The flight has taken off.'),
        row('2026-03-31 02:49:35', null, 'Your order has been shipped from 【shenzhen】.', 'shenzhen'),
        row('2026-03-30 23:38:55', null, 'Your order has been received at 【shenzhen】.', 'shenzhen'),
        row('2026-03-27 02:46:47', 1001, 'Order submitted, pending to receive.'),
      ];
    }), DELIVERED);
    const clocks = (events: typeof result.events) => events!.map(({ local_time: local, time, time_zone: zone, time_zone_basis: basis }) => [local, time, zone, basis]);
    const away = (local: string, time: string) => [local, time, 'America/Mexico_City', 'destination'];
    const kept = (local: string) => [local, undefined, undefined, undefined];
    expect(result).toMatchObject({ destination_country: 'MX', last_update: null, last_update_local: '2026-04-13T17:11:47' });
    expect(clocks(result.events)).toEqual([
      kept('2026-04-13T17:11:47'),
      kept('2026-04-09T16:23:02'),
      away('2026-04-03T10:00:00', '2026-04-03T10:00:00-06:00'),
      away('2026-04-02T10:00:00', '2026-04-02T10:00:00-06:00'),
      away('2026-03-31T02:49:35', '2026-03-31T02:49:35-06:00'),
      away('2026-03-30T23:38:55', '2026-03-30T23:38:55-06:00'),
      away('2026-03-27T02:46:47', '2026-03-27T02:46:47-06:00'),
    ]);
    // The runner dates the scans in Mexico by their places and leaves those dated here.
    expect(clocks(dateLocalClocks('imile', result).events).slice(2)).toEqual(clocks(result.events).slice(2));
    // Without a scan placed abroad, every scan keeps its wall clock.
    const home = parseImile(changed('delivered', (shipment) => {
      shipment.country = 'MEX';
      shipment.trackInfos = shipment.trackInfos.filter((info) => info.operateStationName !== 'shenzhen');
    }), DELIVERED);
    expect(home.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('takes phones, proof links and support contacts out of the wording and keeps who took the parcel', () => {
    expect(imileWording('【DS SMP】Your package was received by 【Sample Person】. If you have any questions, please contact us so we can assist you.'
      + '📞 WhatsApp: +00 00 0000-0000📧 Email: support@example.invalid🌐 Official website: https://example.invalid/'))
      .toBe('【DS SMP】Your package was received by 【Sample Person】.');
    expect(imileWording('Your order has been delivered successfully, Receiver Type:【Family】.'))
      .toBe('Your order has been delivered successfully, Receiver Type:【Family】.');
    expect(imileReceiver('【DS SMP】Your package was received by 【Sample Person】.')).toBe('Sample Person');
    expect(imileReceiver('Your order has been delivered successfully, Receiver Type:【Family】.')).toBe('Family');
    expect(imileReceiver('【Sample01】Delivered, receiver type:【Self or Family】.')).toBe('Self or Family');
    // A receiver type naming where the parcel was left is not who took it.
    for (const place of ['Mail box', 'Parcel locker', 'Reception']) {
      expect(imileWording(`Your order has been delivered successfully, Receiver Type:【${place}】.`))
        .toBe(`Your order has been delivered successfully, Receiver Type:【${place}】.`);
      expect(imileReceiver(`Your order has been delivered successfully, Receiver Type:【${place}】.`)).toBe('');
    }
    expect(imileReceiver('Your package was received by 【Mail box】.')).toBe('');
    expect(imileReceiver('【DS SMP】Your order has arrived at 【DS SMP】')).toBe('');
    expect(imileWording('Our delivery associate is out for delivery.You can contact him by clicking +000 0500000000.'))
      .toBe('Our delivery associate is out for delivery.');
    expect(imileWording('Our delivery associate is out for delivery. Customer service hotline: 0000000000'))
      .toBe('Our delivery associate is out for delivery.');
    expect(imileWording('Your order has been delivered successfully.<div class="viewPic" data-pic="https://example.invalid/a.jpg">View</div>'))
      .toBe('Your order has been delivered successfully.');
    expect(imileWording('Driver called 000 000 0000 , no answer')).toBe('Driver called, no answer');
    // Dates, flight clocks and centre names stay.
    expect(imileWording('Shipment is scheduled to [2026-05-20] .')).toBe('Shipment is scheduled to [2026-05-20].');
    expect(imileWording('Flight Schedule ETD【<HKG>】<2026-05-17 11:40:00>, ETA【<SMP>】<2026-05-17 16:15:00>.'))
      .toBe('Flight Schedule ETD【<HKG>】<2026-05-17 11:40:00>, ETA【<SMP>】<2026-05-17 16:15:00>.');
    expect(imileWording(' Customer Wants to Change Location')).toBe('Customer Wants to Change Location');
  });

  it('reads the empty reply as not found, a failed lookup as inconclusive and a shipment without scans as no history', () => {
    expect(() => parseImile(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseImile({ ...fixture('not-found'), status: 'fail', message: 'System error' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseImile({ ...fixture('not-found'), status: 'fail', message: 'Requests are too frequent' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseImile(changed('delivered', (shipment) => { shipment.trackInfos = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseImile(changed('delivered', (shipment) => { delete (shipment as Row).trackInfos; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseImile(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'iMile answered for another shipment' }));
    const reference = parseImile(changed('in-transit', (shipment) => { shipment.waybillNo = 'CNBR00000000001'; }), 'cnbr00000000001');
    expect(reference.events).toHaveLength(6);
    expect(() => parseImile(changed('in-transit', (shipment) => { shipment.waybillNo = 'CNBR00000000001'; }), 'CNBR0000000000'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_shipment: Shipment, body: Reply) => { delete (body as Row).status; },
      (_shipment: Shipment, body: Reply) => { body.resultObject = 'shipment' as never; },
      (shipment: Shipment) => { delete shipment.waybillNo; },
      (shipment: Shipment) => { shipment.trackInfos = 'scans' as never; },
      (shipment: Shipment) => { shipment.trackInfos = Array.from({ length: 501 }, () => shipment.trackInfos[0]!); },
      (shipment: Shipment) => { shipment.trackInfos[0] = 'scan' as never; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = '20/05/2026 15:42'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = '2026-05-20T15:42:10Z'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = '2026-05-20 24:00:00'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = '2026-02-30 10:00:00'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.time = 1_780_000_000_000; },
      (shipment: Shipment) => { delete shipment.trackInfos[0]!.time; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.trackStage = 'Delivered'; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.trackStage = -1; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.content = ['Delivered']; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.content = ''; shipment.trackInfos[0]!.trackStageTx = null; },
      (shipment: Shipment) => { shipment.trackInfos[0]!.operateStationName = 7; },
    ]) {
      expect(() => parseImile(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A scan whose own sentence is empty takes its code's label.
    expect(parseImile(changed('delivered', (shipment) => { shipment.trackInfos[0]!.content = null; }), DELIVERED).events![0])
      .toMatchObject({ description: 'Delivered', stage: 'delivered' });
  });

  it('asks a public sample once an hour, signed the same way, before calling an empty reply not found', async () => {
    vi.useFakeTimers();
    const fetcher = site(FIRST, {});
    const tracker = new ImileTracker({ fetcher, signing: FIRST.signing });
    const unknown = async () => {
      const answer = expect(tracker.fetch(UNKNOWN, { budgetMs: 10_000 })).rejects.toMatchObject({ kind: 'not_found' });
      await vi.advanceTimersByTimeAsync(1_100);
      await answer;
    };
    await unknown();
    expect(imileCalls(fetcher).map(([url]) => new URL(String(url)).searchParams.get('waybillNo'))).toEqual([UNKNOWN, SAMPLES[0]]);
    expect(imileCalls(fetcher).every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
    await vi.advanceTimersByTimeAsync(58 * 60_000);
    await unknown();
    expect(imileCalls(fetcher)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await unknown();
    expect(imileCalls(fetcher)).toHaveLength(5);
  });

  it('asks the second sample when the first goes unanswered, and calls values neither is answered under refused', async () => {
    vi.useFakeTimers();
    const lookup = async (fetcher: ReturnType<typeof site>) => {
      const answer = new ImileTracker({ fetcher, signing: FIRST.signing }).fetch(UNKNOWN, { budgetMs: 10_000 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(2_200);
      return answer;
    };
    const second = site(FIRST, {}, { samples: SAMPLES.slice(1) });
    await expect(lookup(second)).resolves.toMatchObject({ kind: 'not_found' });
    expect(imileCalls(second).filter(([url]) => isSample(url))).toHaveLength(2);
    // iMile changed its key: neither sample is answered under the values shipped.
    const changedKey = site(SECOND, { [DELIVERED]: fixture('delivered') });
    await expect(lookup(changedKey)).resolves.toMatchObject({ kind: 'schema' });
    expect(imileCalls(changedKey)).toHaveLength(3);
  });

  it('keeps a throttled or blocked sample apart from an unknown number', async () => {
    vi.useFakeTimers();
    const lookup = async (sample: () => Response) => {
      const answer = new ImileTracker({ fetcher: site(FIRST, {}, { sample }), signing: FIRST.signing }).fetch(UNKNOWN, { budgetMs: 10_000 })
        .catch((error: unknown) => error);
      // A throttled sample sends the read again once iMile's wait is over.
      await vi.advanceTimersByTimeAsync(10_000);
      return answer;
    };
    await expect(lookup(throttled)).resolves.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => new Response('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', { headers: { 'Content-Type': 'text/html' } })))
      .resolves.toMatchObject({ kind: 'challenge' });
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (body: unknown, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    // The page answers its own lookup with HTTP 200: a 404 or a redirect is a moved route.
    await expect(lookup(fixture('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.imile.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>', { headers: { 'Content-Type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>iMile</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ ...fixture('not-found'), status: 'fail', message: 'System busy' })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      // Too short a budget to sit out a throttle.
      await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 3_000 })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers iMile does not answer and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['6000000', 'SAMPLETRACKING', `6${'0'.repeat(40)}`, '6000000000001!']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeImileNumber('cnbr 0000-0000-001')).toBe('CNBR00000000001');
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('in-transit')))
      .mockResolvedValueOnce(reply(cainiaoUnknown(IN_TRANSIT)));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(imileCalls(fetcher)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['HTTP 429', throttled],
    ['a reply that says so', () => reply({ ...fixture('not-found'), status: 'failure', message: 'Too many requests' })],
  ])('sends a read iMile throttled with %s once more after a second and a half', async (_name, refusal) => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(reply(fixture('in-transit')))
      .mockResolvedValueOnce(reply(cainiaoUnknown(IN_TRANSIT)));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const answer = new ImileTracker({ fetcher, recorder }).fetch(IN_TRANSIT, { budgetMs: 20_000 });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(imileCalls(fetcher)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toMatchObject({ current_stage: 'customs' });
    expect(imileCalls(fetcher)).toHaveLength(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'rate_limited' }));
  });

  it('sends the lookups of trackers on one transport at least 1.1 seconds apart', async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      sent.push(Date.now());
      return reply(fixture('in-transit'));
    });
    const lookups = Promise.all([0, 1, 2].map(() => new ImileTracker({ fetcher }).fetch(IN_TRANSIT, {}, { cainiao: false })));
    await vi.advanceTimersByTimeAsync(2_200);
    await expect(lookups).resolves.toHaveLength(3);
    expect(sent.map((at) => at - sent[0]!)).toEqual([0, 1_100, 2_200]);
  });

  it('fails a lookup whose turn leaves no time for its request as its own pacing, and sends nothing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('in-transit')));
    await new ImileTracker({ fetcher }).fetch(IN_TRANSIT, {}, { cainiao: false });
    await expect(new ImileTracker({ fetcher }).fetch(IN_TRANSIT, { budgetMs: 2_500 }, { cainiao: false }))
      .rejects.toMatchObject({ kind: 'rate_limited', reason: 'self_paced', retryAfterMs: expect.any(Number) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the throttle when the read sent again is throttled too, or when the wait does not fit the budget', async () => {
    vi.useFakeTimers();
    const twice = vi.fn<typeof fetch>().mockResolvedValueOnce(throttled()).mockResolvedValueOnce(throttled()).mockResolvedValue(reply(fixture('in-transit')));
    const failure = expect(carrier(twice).track({ number: IN_TRANSIT }, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'rate_limited' });
    await vi.advanceTimersByTimeAsync(5_000);
    await failure;
    expect(imileCalls(twice)).toHaveLength(2);
    // The wait and the request after it need three and a half seconds.
    const short = vi.fn<typeof fetch>().mockResolvedValueOnce(throttled()).mockResolvedValue(reply(fixture('in-transit')));
    await expect(carrier(short).track({ number: IN_TRANSIT }, { budgetMs: 3_000 })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(short).toHaveBeenCalledOnce();
  });

  it('stops waiting out the throttle when the caller cancels', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(throttled()).mockResolvedValue(reply(fixture('in-transit')));
    const failure = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: controller.signal, budgetMs: 20_000 }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new Error('cancelled'));
    await failure;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('recognizes a waybill with scans and the empty reply, keeps a refusal an error and asks nothing for another number', async () => {
    const known = vi.fn<typeof fetch>().mockImplementation(async () => reply(changed('in-transit', (shipment) => { shipment.waybillNo = DATED; })));
    await expect(carrier(known).recognize!(DATED)).resolves.toMatchObject({ known: true });
    // A sample is still answered under the values the adapter holds, so the empty reply is an unknown number.
    const empty = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const number = new URL(String(input)).searchParams.get('waybillNo')!;
      return reply(SAMPLES.includes(number) ? changed('delivered', (shipment) => { shipment.waybillNo = number; }) : fixture('not-found'));
    });
    await expect(carrier(empty).recognize!(DATED)).resolves.toEqual({ known: false });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }))).recognize!(DATED, { budgetMs: 3_000 }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    const unasked = vi.fn<typeof fetch>();
    await expect(carrier(unasked).recognize!('SAMPLETRACKING')).resolves.toEqual({ known: false });
    expect(unasked).not.toHaveBeenCalled();
    // Recognition asks iMile alone.
    expect(known.mock.calls.some(toCainiao)).toBe(false);
  });

  it('routes a number filed under iMile to the adapter, and suggests iMile for a dated waybill only', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'imile' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'imile', source: 'imile', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(`${IMILE_API}?`))).toBe(true);
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('imile');
    expect(detectCarrierMatch(DATED)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['imile']) });
    // Month 13 is no date.
    expect(detectCarrierMatch('6130124000001').candidates).not.toContain('imile');
  });

  it('lists iMile first for a dated waybill, beside the other thirteen-digit carriers, whatever the country hint', () => {
    expect(detectCarrierMatch(DATED)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['imile'],
      candidates: expect.arrayContaining(['correos-chile', 'delhivery', 'yunda', 'korea-post', 'imile']) });
    expect(detectCarrierMatch(DATED).candidates?.[0]).toBe('imile');
    // A parcel bought abroad keeps its buyer's country hint, so iMile is asked first without its own countries too.
    for (const countryHint of [undefined, 'CO', 'DE', 'ES', 'HU', 'KR', 'IN']) {
      const asked = recognitionAskedCarriers(DATED, { countryHint });
      expect(asked[0], countryHint ?? 'no hint').toBe('imile');
      expect(asked, countryHint ?? 'no hint').not.toContain('la-poste');
    }
    // A waybill dated before 2024 or a bare counter is not preferred.
    for (const number of ['6010123000001', '3010124000001']) expect(detectCarrierMatch(number).preferred ?? [], number).not.toContain('imile');
  });

  it('suggests iMile among the other thirteen-digit carriers for 3 and twelve digits, without preferring it, so recognition asks it', () => {
    const undated = '3000000000001';
    expect(detectCarrierMatch(undated)).toMatchObject({ carrier: 'unknown', confidence: 'low',
      candidates: expect.arrayContaining(['imile', 'fan-courier', 'yunda', 'correos-chile']) });
    expect(detectCarrierMatch(undated).preferred ?? []).not.toContain('imile');
    expect(recognitionAskedCarriers(undated)).toEqual(expect.arrayContaining(['imile', 'fan-courier']));
    for (const number of ['300000000001', '30000000000001', '4000000000001']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('imile');
    }
  });

  it('lists iMile first for 49 and twelve digits, which its tracker answered for Italian parcels, beside the other fourteen-digit carriers', () => {
    for (const number of ['49999999999987', '49 0000 0000 0017']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['imile'],
        candidates: expect.arrayContaining(['imile', 'brt', 'dpd']) });
      expect(detectCarrierMatch(number).candidates?.[0], number).toBe('imile');
    }
    // Every parcel the app tracked in the layout was iMile's, so it is asked before the hinted country's carriers.
    for (const [countryHint, next] of [[undefined, 'dpd-be'], ['IT', 'brt'], ['DE', 'dpd-de']] as const) {
      expect(recognitionAskedCarriers('49999999999987', { countryHint }).slice(0, 2), countryHint ?? 'no hint').toEqual(['imile', next]);
    }
    for (const number of ['48000000000017', '4900000000017', '490000000000017']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('imile');
    }
  });
});

describe('Cainiao’s leg in front of iMile’s history', () => {
  type Step = { step: string; attempt: number; outcome: string; errorType: string | null; durationMs: number };
  const lookup = (cainiao: (number: string, init?: RequestInit) => Response | Promise<Response>, budgetMs?: number, shipment: Reply = fixture('delivered')) => {
    const recorder = { ...NOOP_RECORDER, step: vi.fn<(step: Step) => void>(), lookup: vi.fn() };
    const fetcher = site(FIRST, { [DELIVERED]: shipment }, { cainiao });
    const result = new ImileTracker({ fetcher, recorder, signing: FIRST.signing }).fetch(DELIVERED, budgetMs ? { budgetMs } : {});
    const step = () => recorder.step.mock.calls.map(([recorded]) => recorded).find((recorded) => recorded.step === 'cainiao');
    return { fetcher, result, step };
  };
  const codes = (result: { events?: readonly { provider_code?: unknown }[] }) => result.events!.map((event) => event.provider_code ?? null);
  const CAINIAO_CODE = /^[A-Z_]+$/;
  /** Cainiao's record with its scans from `from` on, newest first. */
  const cainiaoFrom = (from: string) => {
    const record = cainiaoFixture();
    const scans = record.module[0]!.detailList;
    record.module[0]!.detailList = scans.slice(scans.findIndex((scan) => scan.actionCode === from));
    return record;
  };

  it('puts Cainiao’s China leg in front of iMile’s scans and keeps iMile’s scans and status', async () => {
    const own = parseImile(fixture('delivered'), DELIVERED);
    const { result, step } = lookup(() => reply(cainiaoFixture()));
    const merged = await result;
    expect({ ...merged, events: own.events }).toEqual(own);
    expect(merged.events!.filter((event) => !CAINIAO_CODE.test(String(event.provider_code ?? '')))).toEqual(own.events);
    // Cainiao's scans count up to iMile's flight; its relays of iMile's own scans, and of iMile's order, stay out.
    expect(codes(merged).slice(13)).toEqual(['1002', 'LH_DEPART', 'LH_HO_AIRLINE', 'CC_EX_SUCCESS', 'CC_EX_START', 'LH_HO_IN_SUCCESS',
      '1001', 'SC_OUTBOUND_SUCCESS', 'SC_INBOUND_SUCCESS', 'PU_PICKUP_SUCCESS']);
    expect(merged.events).toHaveLength(own.events!.length + 8);
    const scan = (code: string) => merged.events!.find((event) => event.provider_code === code);
    expect(scan('SC_OUTBOUND_SUCCESS')).toEqual({ time: '2026-05-14T23:50:00+08:00', location: 'Sampletown',
      description: 'Departed from sorting center', original_description: '[Sampletown] Departed from sorting center',
      provider_code: 'SC_OUTBOUND_SUCCESS', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(scan('PU_PICKUP_SUCCESS')).toMatchObject({ time: '2026-05-14T15:30:00+08:00', stage: 'accepted' });
    // Cainiao's handover to the airline has a day and no clock.
    expect(scan('LH_HO_AIRLINE')).toMatchObject({ local_time: '2026-05-17', stage: 'in_transit' });
    expect(scan('LH_HO_AIRLINE')).not.toHaveProperty('time');
    expect(step()).toMatchObject({ attempt: 2, outcome: 'ok', errorType: null });
  });

  it('keeps iMile’s answer when Cainiao does not name iMile as the parcel’s carrier', async () => {
    const stranger = cainiaoFixture();
    const module = stranger.module[0]!;
    module.destCpInfo = { cpName: 'Sample Express' };
    for (const trace of [module.globalCombinedLogisticsTraceDTO, module.latestTrace]) delete (trace as Row).currentStatusCpInfo;
    const { result, step } = lookup(() => reply(stranger));
    await expect(result).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
    expect(step()).toMatchObject({ outcome: 'indeterminate' });
    expect(() => cainiaoScans(stranger, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'carrier_unconfirmed' }));
  });

  it('takes Cainiao’s record that names no carrier for a number only iMile issues', () => {
    const unnamed = (number: string, carrier?: string) => {
      const reply = cainiaoFixture();
      const module = reply.module[0]!;
      module.mailNo = number;
      if (carrier) module.destCpInfo = { cpName: carrier };
      else delete module.destCpInfo;
      for (const trace of [module.globalCombinedLogisticsTraceDTO, module.latestTrace, ...module.detailList]) delete (trace as Row).currentStatusCpInfo;
      return reply;
    };
    const own = `IM0601${'0'.repeat(9)}1`;
    expect(cainiaoScans(unnamed(own), own)).toEqual(cainiaoScans(cainiaoFixture(), DELIVERED));
    // A number other networks may also print still needs Cainiao to name iMile, and a record naming another carrier never counts.
    expect(() => cainiaoScans(unnamed(DELIVERED), DELIVERED)).toThrow(expect.objectContaining({ reason: 'carrier_unconfirmed' }));
    expect(() => cainiaoScans(unnamed(own, 'Sample Express'), own)).toThrow(expect.objectContaining({ reason: 'carrier_unconfirmed' }));
  });

  it.each([
    ['its slider', () => new Response('<!DOCTYPE html><html><body><punish-component />\n<!--rgv587_flag:sm-->\n</body></html>',
      { headers: { 'Content-Type': 'text/html' } }), 'challenge'],
    ['HTTP 429', () => new Response('', { status: 429 }), 'rate_limited'],
    ['a changed reply', () => reply({ success: true, module: 'none' }), 'schema'],
    // Cainiao's reader reports a reply that is not JSON as an error of its own.
    ['a page in place of its reply', () => reply('<html><title>Cainiao</title></html>'), 'error'],
    ['no record of the number', () => reply(cainiaoUnknown(DELIVERED)), 'not_found'],
  ] as const)('keeps iMile’s answer as it is when Cainiao answers with %s, and records %s', async (_name, answer, kind) => {
    const { result, step } = lookup(answer);
    await expect(result).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
    expect(step()).toMatchObject({ step: 'cainiao', outcome: kind });
  });

  it('leaves a number Cainiao had no record of unasked there for a day', async () => {
    let now = Date.now();
    const cainiao = vi.fn((number: string) => reply(cainiaoUnknown(number)));
    const recorder = { ...NOOP_RECORDER, step: vi.fn<(step: Step) => void>(), lookup: vi.fn() };
    const fetcher = site(FIRST, { [DELIVERED]: fixture('delivered') }, { cainiao });
    const tracker = () => new ImileTracker({ fetcher, recorder, signing: FIRST.signing, now: () => now });
    const cainiaoSteps = () => recorder.step.mock.calls.filter(([recorded]) => recorded.step === 'cainiao').length;
    await expect(tracker().fetch(DELIVERED)).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
    expect(cainiao).toHaveBeenCalledTimes(1);
    // The next check reads iMile alone, and records no Cainiao step.
    await expect(tracker().fetch(DELIVERED)).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
    expect(cainiao).toHaveBeenCalledTimes(1);
    expect(cainiaoSteps()).toBe(1);
    // A day later Cainiao is asked again.
    now += CAINIAO_UNKNOWN_MS + 1;
    await tracker().fetch(DELIVERED);
    expect(cainiao).toHaveBeenCalledTimes(2);
    // Another failure, such as its slider, leaves the number to ask on the next check.
    const sliders = vi.fn(() => new Response('', { status: 429 }));
    const other = site(FIRST, { [DELIVERED]: fixture('delivered') }, { cainiao: sliders });
    for (let check = 0; check < 2; check += 1) await new ImileTracker({ fetcher: other, signing: FIRST.signing }).fetch(DELIVERED);
    expect(sliders).toHaveBeenCalledTimes(2);
  });

  it('saves the numbers Cainiao had no record of to the host\'s holds by tag, and takes them up after a restart', async () => {
    const saved: AdapterHold[] = [];
    await keepAdapterHolds({ load: async () => [], save: async (hold) => { saved.push(hold); } });
    try {
      let now = Date.now();
      const cainiao = vi.fn((number: string) => reply(cainiaoUnknown(number)));
      const transport = () => site(FIRST, { [DELIVERED]: fixture('delivered') }, { cainiao });
      await new ImileTracker({ fetcher: transport(), signing: FIRST.signing, now: () => now }).fetch(DELIVERED);
      // The host's store gets the number's tag, never the number.
      expect(saved).toEqual([{ key: `imile-cainiao-unknown/${serviceTag(DELIVERED)}`, until: now + CAINIAO_UNKNOWN_MS }]);
      expect(JSON.stringify(saved)).not.toContain(DELIVERED);
      // A process that starts within the day leaves the number unasked on any transport, until the day is over.
      await keepAdapterHolds({ load: async () => saved, save: async () => undefined });
      await new ImileTracker({ fetcher: transport(), signing: FIRST.signing, now: () => now }).fetch(DELIVERED);
      expect(cainiao).toHaveBeenCalledTimes(1);
      now += CAINIAO_UNKNOWN_MS + 1;
      await new ImileTracker({ fetcher: transport(), signing: FIRST.signing, now: () => now }).fetch(DELIVERED);
      expect(cainiao).toHaveBeenCalledTimes(2);
    } finally {
      resetAdapterHolds();
    }
  });

  it('gives Cainiao half of the time iMile left, and nothing when that is too short to ask', async () => {
    // Advance the controlled clock once signing has finished and the mock
    // request is ready.
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    let requestStarted!: () => void;
    const ready = new Promise<void>(resolve => { requestStarted = resolve; });
    const hanging = vi.fn((_number: string, init?: RequestInit) => {
      requestStarted();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    });
    try {
      const started = performance.now();
      const slow = lookup(hanging, 600);
      await ready;
      await vi.advanceTimersByTimeAsync(300);
      await expect(slow.result).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
      expect(performance.now() - started).toBe(300);
      expect(hanging).toHaveBeenCalledTimes(1);
      expect(slow.step()).toMatchObject({ outcome: 'transport' });
      expect(slow.step()!.durationMs).toBe(300);

      const unasked = vi.fn((number: string) => reply(cainiaoUnknown(number)));
      const short = lookup(unasked, 300);
      await expect(short.result).resolves.toEqual(parseImile(fixture('delivered'), DELIVERED));
      expect(unasked).not.toHaveBeenCalled();
      expect(short.step()).toMatchObject({ outcome: 'budget' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks Cainiao only once iMile answered with scans', async () => {
    const unasked = vi.fn((number: string) => reply(cainiaoUnknown(number)));
    const fetcher = site(FIRST, { [DELIVERED]: changed('delivered', (shipment) => { shipment.trackInfos = []; }) }, { cainiao: unasked });
    const tracker = new ImileTracker({ fetcher, signing: FIRST.signing });
    await expect(tracker.fetch(DELIVERED)).rejects.toMatchObject({ name: 'NoHistoryError' });
    await expect(tracker.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(unasked).not.toHaveBeenCalled();
  });

  it('lets Cainiao’s leg give the status while iMile holds only its order record', async () => {
    const ordered = changed('delivered', (shipment) => { shipment.trackInfos = shipment.trackInfos.slice(-1); });
    expect(parseImile(ordered, DELIVERED)).toMatchObject({ status: 'pending', current_stage: 'registered' });
    const { result } = lookup(() => reply(cainiaoFrom('LH_DEPART')), undefined, ordered);
    const merged = await result;
    expect(codes(merged)).toEqual(['LH_DEPART', 'LH_HO_AIRLINE', 'CC_EX_SUCCESS', 'CC_EX_START', 'LH_HO_IN_SUCCESS', '1001',
      'SC_OUTBOUND_SUCCESS', 'SC_INBOUND_SUCCESS', 'PU_PICKUP_SUCCESS']);
    expect(merged).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Departed from departure country/region', last_update: '2026-05-17T09:20:00+08:00', destination_country: 'SA' });
    expect(merged).not.toHaveProperty('last_update_local');
    // A notice of Cainiao's has no stage of its own and moves nothing: the scan before it gives the stage.
    expect(cainiaoScans(cainiaoFrom('LAST_MILE_ASN_NOTIFY'), DELIVERED)[0]).toMatchObject({ provider_code: 'LAST_MILE_ASN_NOTIFY', stage: 'pending', stage_source: 'none' });
    expect(imileSummary([
      { time: '2026-05-15T00:30:00+08:00', description: 'Carrier update', provider_code: 'LAST_MILE_ASN_NOTIFY', stage: 'pending', stage_source: 'none' },
      { time: '2026-05-14T23:50:00+08:00', description: 'Departed from sorting center', provider_code: 'SC_OUTBOUND_SUCCESS', stage: 'in_transit', stage_source: 'carrier_map' },
    ])).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Carrier update' });
  });

  it('keeps only the Cainiao scans older than iMile’s at any offset when iMile’s clocks have no zone', () => {
    const own = parseImile(changed('delivered', (shipment) => { shipment.country = 'BRA'; }), DELIVERED);
    expect(own.events![0]).not.toHaveProperty('time');
    const merged = withCainiaoLeg(own, cainiaoScans(cainiaoFixture(), DELIVERED));
    expect({ ...merged, events: own.events }).toEqual(own);
    // iMile's flight may have left up to 14 hours before its wall clock: Cainiao's departure and handover may be later.
    expect(codes(merged).filter((code) => CAINIAO_CODE.test(String(code))).slice(0, 3)).toEqual(['CC_EX_SUCCESS', 'CC_EX_START', 'LH_HO_IN_SUCCESS']);
    expect(codes(merged).slice(0, 14)).toEqual(codes(own).slice(0, 14));
  });

  it('reads iMile’s receipt at a centre as the acceptance when only the order record comes before it', () => {
    const row = (time: string, trackStage: number, content: string) => ({ content, trackStage, trackStageTx: null, time, operateStationName: 'Sample Center', proofs: null });
    const order = row('2026-05-14 19:22:48', 1001, 'Order submitted, pending to receive.');
    const receipt = row('2026-05-18 10:00:00', 2004, 'Your order has been received.');
    const received = parseImile(changed('delivered', (shipment) => {
      shipment.trackInfos = [row('2026-05-19 08:00:00', 1002, 'Your order has arrived at Sample DS'), receipt, order];
    }), DELIVERED);
    expect(received.events!.map((event) => event.stage)).toEqual(['in_transit', 'accepted', 'registered']);
    // A store sending the parcel out, without a code, moves nothing before the receipt.
    const stored = parseImile(changed('delivered', (shipment) => {
      shipment.trackInfos = [receipt, { ...row('2026-05-17 23:01:00', 0, 'Out of stores'), trackStage: null }, order];
    }), DELIVERED);
    expect(stored.events!.map((event) => event.stage)).toEqual(['accepted', undefined, 'registered']);
    const stocks = parseImile(changed('delivered', (shipment) => {
      shipment.trackInfos = [receipt, { ...row('2026-05-17 23:01:00', 0, 'Out of stocks'), trackStage: null }, order];
    }), DELIVERED);
    expect(stocks.events!.map((event) => event.stage)).toEqual(['accepted', undefined, 'registered']);
    // After a flight it is the first centre in the destination country.
    const flown = parseImile(changed('delivered', (shipment) => {
      shipment.trackInfos = [receipt, row('2026-05-17 06:40:00', 1002, '【HKG】The flight has taken off.'), order];
    }), DELIVERED);
    expect(flown).toMatchObject({ current_stage: 'in_transit' });
    // Cainiao's leg shows the parcel moving before it: transit again.
    const alone = parseImile(changed('delivered', (shipment) => { shipment.trackInfos = [receipt, order]; }), DELIVERED);
    expect(alone).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map' });
    const merged = withCainiaoLeg(alone, cainiaoScans(cainiaoFixture(), DELIVERED));
    expect(merged).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Your order has been received.' });
    expect(merged.events![0]).toMatchObject({ provider_code: '2004', stage: 'in_transit' });
    expect(merged.events!.some((event) => CAINIAO_CODE.test(String(event.provider_code)))).toBe(true);
    expect(alone.events![0]).toMatchObject({ stage: 'accepted' });
  });

  it('adds nothing to a history iMile cut short or to none', () => {
    const scans = cainiaoScans(cainiaoFixture(), DELIVERED);
    const truncated = { ...parseImile(fixture('delivered'), DELIVERED), history_truncated: true };
    expect(withCainiaoLeg(truncated, scans)).toBe(truncated);
    const empty = { status: 'unknown' as const, events: [] };
    expect(withCainiaoLeg(empty, scans)).toBe(empty);
  });
});

describe('iMile status vocabulary', () => {
  it('records every code and wording seen with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean }[]) {
      const code = entry.code ?? '';
      if (entry.unmapped) {
        expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBeUndefined();
        expect(imileStage(code, entry.wording), entry.wording).toBeNull();
        continue;
      }
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(imileStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'Lost order' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'Scheduled Delivery' }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage of the scan before it/) });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'Change of delivery time' }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage of the scan before it/) });
    // A relay that drops the code reads a centre receiving the returning parcel as iMile's return code does; a code
    // iMile gives keeps deciding.
    expect(imileRelayedStage('【Sample RDC】Shipment received.')).toBe('exception');
    expect(statusMap.stage(null, '【sample rdc】shipment received.')).toBe('exception');
    expect(statusMap.stage('2004', '【sample rdc】shipment received.')).toBe('in_transit');
    expect(imileRelayedStage('Shipment received.')).toBeUndefined();
    // The booked day moves nothing; the review learns why.
    for (const providerCode of ['1003', '1002', null]) {
      expect(statusMapAnswer({ carrier: 'imile', providerCode, description: 'Shipment is scheduled to [2026-05-20].' }))
        .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage it had/) });
    }
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1004', description: 'Shipment is scheduled to [2026-05-20].' })).toEqual({ kind: 'unknown' });
    // The rows statuses.json leaves unmapped on purpose answer why, whatever station or flight they name.
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: '【DS(XYZ)】Inventory count scan' }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/moves nothing/) });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1002', description: 'Flight Schedule ETD【<AAA>】<2026-01-01 01:00:00>, ETA【<BBB>】<2026-01-01 05:00:00>.' }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/still to come/) });
    for (const entry of (statuses.entries as { code?: string; wording: string; unmapped?: boolean }[]).filter((candidate) => candidate.unmapped)) {
      expect(statusMapAnswer({ carrier: 'imile', providerCode: entry.code ?? null, description: entry.wording }).kind, entry.wording).toBe('intentional_gap');
    }
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'User not at home' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'Wrong Address(Insufficient address details)' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'Failed to schedule due to [noanswer]。' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'The delivery method has been confirmed with the recipient as Self-Pickup.' }))
      .toMatchObject({ kind: 'intentional_gap' });
    // The pickup point and its address vary; the parcel waits there for the recipient.
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003',
      description: 'The parcel has been delivered to Sample Shop. Please collect your parcel promptly at Sample Street 1 using your pickup code.' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '9999', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
    // A delivery-stage sentence the map does not know is read by the shared rules, else stays in transit.
    expect(imileStage('1003', 'Synthetic note')).toEqual({ stage: 'in_transit', source: expect.any(String) });
    expect(imileStage('9999', 'Synthetic note')).toBeNull();
    // The return codes decide whatever the sentence says, but a return is under way until the sender has the parcel.
    expect(imileStage('1008', '【Sample Hub】Received.')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(imileStage('1008', '【Sample Hub】Return signature')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(imileStage('2065', '【Sample Hub】Received.')).toEqual({ stage: 'returned', source: 'carrier_map' });
    // A stored wording shows the name iMile put in 【】 before the sentence.
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1002', description: 'SMP: Clearance start.' })).toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'imile', providerCode: '1003', description: 'Contact Error: need to return.' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
  });
});
