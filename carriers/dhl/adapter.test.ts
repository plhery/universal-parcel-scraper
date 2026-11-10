import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import type { CarrierResult } from '../../core/result/index.js';
import { countryCode } from '../../core/time/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { adapter, DHLSessionError, DHLTracker, dhlTrackingUrl, normalizeDHLTrackingNumber, parseDHLTrackingResponse } from './adapter.js';

const NUMBER = 'LF999999987DE';
const CONFIG = 'https://www.dhl.de/int-verfolgen/data/config?domain=de&language=en';
const SEARCH = `https://www.dhl.de/int-verfolgen/data/search?piececode=${NUMBER}&noRedirect=true&language=en`;

interface Timeline { status?: string; datumAktuellerStatus?: string; fortschritt?: number; events: Record<string, unknown>[] }
interface Payload {
  sendungen: { id: string; sendungsinfo: Record<string, unknown>; sendungsdetails: { sendungsverlauf: Timeline } & Record<string, unknown> }[];
  rateLimited: boolean;
}

function json<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T;
}

function shipment(overrides: Record<string, unknown> = {}): Payload {
  const payload = json<Payload>('./fixtures/in-transit.json');
  Object.assign(payload.sendungen[0]!.sendungsdetails, overrides);
  return payload;
}

function config(token = 'test-csrf') {
  const response = Response.json({ verfolgenCsrfToken: token, initialWG: 0 }, {
    headers: { 'Set-Cookie': `verfolgenCsrfToken=${token}; Path=/; Secure` },
  });
  Object.defineProperty(response, 'url', { value: CONFIG });
  return response;
}

/** A solved browser answer from the private browser service. */
function solved(cookies: Record<string, unknown>[], userAgent?: string) {
  return Response.json({ tier: 3, statusCode: 200, html: '<html>solved</html>', cookies, ...(userAgent ? { userAgent } : {}) });
}

afterEach(() => vi.restoreAllMocks());

describe('DHL public tracking normalization', () => {
  it.each([
    ['http://www.post.ch', 'swiss-post'],
    ['https://service.post.ch/ekp-web/ui/entry/search/' + NUMBER, 'swiss-post'],
    ['https://www.posti.fi/en/tracking', 'posti'],
    ['https://tools.usps.com/go/TrackConfirmAction', 'usps'],
    ['https://www.logistics.dhl/it-it/home/tracking/tracking-express.html?submit=1&tracking-id=' + NUMBER, 'dhl-express'],
    ['https://www.dhlexpress.pl', 'dhl-express'],
    ['http://www.bpost.be', 'bpost'],
    ['https://track.bpost.cloud/etr/light/performSearch.do?searchByItemCode=true&itemCodes=' + NUMBER, 'bpost'],
    ['https://www.sda.it', 'poste-italiane'],
    ['https://www.logistics.dhl/it-it/home.html', undefined],
    // Landmark Global's portal on bpost's tracker serves every postal partner.
    ['https://track.bpost.cloud/btr/web/#/lmg/search?lang=en&itemCodes=' + NUMBER, undefined],
    ['https://www.post.ch.evil.example', undefined],
    ['https://www.post.ch@evil.example', undefined],
    ['https://example.test/?next=https://www.post.ch', undefined],
    ['https://other-carrier.example', undefined],
  ])('recognizes a catalog delivery-partner link: %s', (url, expected) => {
    const payload = shipment();
    payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push({
      datum: '2026-08-11T10:00:00+02:00',
      status: `The shipment has arrived in the destination country/destination area. (Homepage / online shipment tracking: ${url})`,
    });
    expect(parseDHLTrackingResponse(payload, NUMBER).delivery_carrier).toBe(expected);
  });

  it('reads the partner from the arrival notice, then shows the notice without its link', () => {
    const arrival = 'The shipment has arrived in the destination country/destination area.';
    for (const link of [`http://www.post.ch/?id=${NUMBER}`, '']) {
      const payload = shipment();
      payload.sendungen[0]!.sendungsdetails.sendungsverlauf.status = `${arrival} (Homepage / online shipment tracking: ${link})`;
      payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push({
        datum: '2026-08-11T10:00:00+02:00', status: `${arrival} (Homepage / online shipment tracking: ${link})` });
      const result = parseDHLTrackingResponse(payload, NUMBER);
      expect(result.delivery_carrier, link).toBe(link ? 'swiss-post' : undefined);
      expect(result.events?.[0]).toMatchObject({ description: arrival, stage: 'in_transit' });
      expect(result.last_status_text).toBe(arrival);
      expect(JSON.stringify(result)).not.toMatch(/Homepage|post\.ch/);
    }
  });

  it('leaves out a receiving option the recipient booked, a wish rather than a movement', () => {
    const payload = shipment();
    payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push({
      datum: '2026-08-11T10:00:00+02:00', status: 'Für diese Sendung wurde ein Liefertag als Empfangsoption vorgemerkt.' });
    const result = parseDHLTrackingResponse(payload, NUMBER);
    expect(result.events?.map((event) => event.time)).toEqual(['2026-08-10T18:30:00+02:00', '2026-08-09T20:00:00+02:00']);
    expect(result.current_stage).toBe('in_transit');
  });

  it('leaves out a pre-advice dated after a scan that moved the parcel, and keeps one dated first', () => {
    const late = 'Die Sendung wurde elektronisch angekündigt. Sobald die Sendung von uns bearbeitet wurde, erhalten Sie weitere Informationen.';
    const read = (datum: string, status?: string) => {
      const payload = shipment(status ? { sendungsverlauf: { ...shipment().sendungen[0]!.sendungsdetails.sendungsverlauf, status } } : {});
      payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push({ datum, status: late });
      return parseDHLTrackingResponse(payload, NUMBER);
    };
    const after = read('2026-08-10T18:45:00+02:00');
    expect(after.events?.map((event) => event.time)).toEqual(['2026-08-10T18:30:00+02:00', '2026-08-09T20:00:00+02:00']);
    expect(after.current_stage).toBe('in_transit');
    // As the summary, it gives way to the newest scan.
    const summary = read('2026-08-10T18:45:00+02:00', late);
    expect(summary).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Die Sendung wurde im Briefzentrum bearbeitet.' });
    // One dated before the first move, or with it, stays registered.
    for (const datum of ['2026-08-10T18:00:00+02:00', '2026-08-10T18:30:00+02:00']) {
      expect(read(datum).events?.find((event) => event.description === late)?.stage, datum).toBe('registered');
    }
  });

  it('reads a redirect DHL refused as a notice that keeps the stage before it, not a delivery attempt', () => {
    const refused = 'Die Paketumleitung wurde aufgrund Produkt/Service- Kombination nicht erlaubt storniert. Die Sendung wird an die Hausadresse zugestellt.';
    const timeline = shipment().sendungen[0]!.sendungsdetails.sendungsverlauf;
    const payload = shipment({ sendungsverlauf: { ...timeline, status: refused } });
    payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push({ datum: '2026-08-10T19:00:00+02:00', status: refused });
    const result = parseDHLTrackingResponse(payload, NUMBER);
    expect(result.events?.[0]).toMatchObject({ description: refused, stage: 'in_transit', stage_source: 'none' });
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: refused });
  });

  it('reads a Packstation as the address as a notice that keeps the stage before it', () => {
    const packstation = 'Sendung auf dem Weg zur Packstation.';
    const read = (before: string) => {
      const timeline = shipment().sendungen[0]!.sendungsdetails.sendungsverlauf;
      const payload = shipment({ sendungsverlauf: { ...timeline, status: packstation } });
      payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push({ datum: '2026-08-11T06:29:59+02:00', status: before },
        { datum: '2026-08-11T06:30:00+02:00', status: packstation });
      return parseDHLTrackingResponse(payload, NUMBER);
    };
    // Written beside the loading onto the delivery vehicle, it does not undo it.
    const loaded = read('Die Sendung wurde in das Zustellfahrzeug geladen. Die Zustellung erfolgt voraussichtlich heute.');
    expect(loaded.events?.[0]).toMatchObject({ description: packstation, stage: 'out_for_delivery', stage_source: 'none' });
    expect(loaded).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: packstation });
    // Written on a redirect before the delivery run, it is no delivery run either.
    const redirected = read('Die Sendung ist in der Region des Empfängers angekommen und wird im nächsten Schritt zur Zustellbasis transportiert.');
    expect(redirected.events?.[0]).toMatchObject({ stage: 'in_transit', stage_source: 'none' });
    expect(redirected.current_stage).toBe('in_transit');
  });

  it("reads the recipient's collection from a Packstation as the delivery", () => {
    const timeline = shipment().sendungen[0]!.sendungsdetails.sendungsverlauf;
    const payload = shipment({ istZugestellt: true, sendungsverlauf: { ...timeline, status: 'Abholung aus Packstation' } });
    payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push(
      { datum: '2026-08-11T12:02:24+02:00', status: 'Die Sendung liegt in der Packstation zur Abholung bereit.' },
      { datum: '2026-08-11T14:50:54+02:00', status: 'Abholung aus Packstation' });
    const result = parseDHLTrackingResponse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(result.events?.slice(0, 2).map((event) => event.stage)).toEqual(['delivered', 'ready_for_pickup']);
  });

  it('reads a failed round that starts the return as the return, under the headline "Delivery not possible"', () => {
    const timeline = shipment().sendungen[0]!.sendungsdetails.sendungsverlauf;
    const payload = shipment({ sendungsverlauf: { ...timeline, status: 'Delivery not possible' } });
    payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push(
      { datum: '2026-08-11T15:04:25+02:00', status: 'The recipient could not be found at the address on the shipment.' },
      { datum: '2026-08-11T15:04:26+02:00', status: 'Unfortunately delivery of the shipment was not possible. The shipment is returned to the sender.' });
    const result = parseDHLTrackingResponse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Delivery not possible', expected_delivery: null });
    expect(result.events?.slice(0, 2).map((event) => event.stage)).toEqual(['returned', 'failed_attempt']);
  });

  it('reads the moves after the latest return start as the way back, until a round or a failed attempt ends it', () => {
    const returnStart = 'Unfortunately delivery of the shipment was not possible. The shipment is returned to the sender.';
    const rounds = [
      { datum: '2026-08-11T08:04:31+02:00', status: 'The shipment has been loaded onto the delivery vehicle. Delivery is expected to take place today.' },
      { datum: '2026-08-11T15:04:25+02:00', status: 'The recipient could not be found at the address on the shipment.' },
      { datum: '2026-08-11T15:04:26+02:00', status: returnStart },
      { datum: '2026-08-11T18:39:57+02:00', status: 'The shipment arrived in the region of recipient and will be transported to the delivery base in the next step.' },
      { datum: '2026-08-12T08:58:33+02:00', status: 'The shipment has been loaded onto the delivery vehicle. Delivery is expected to take place today.' },
      { datum: '2026-08-12T12:37:35+02:00', status: returnStart },
    ];
    const read = (...after: { datum: string; status: string }[]) => {
      const timeline = shipment().sendungen[0]!.sendungsdetails.sendungsverlauf;
      const last = after.at(-1) ?? rounds.at(-1)!;
      const payload = shipment({ sendungsverlauf: { ...timeline, status: last.status, datumAktuellerStatus: last.datum },
        zustellung: { zustellzeitfensterVon: '2026-08-14T10:45:00+02:00', zustellzeitfensterBis: '2026-08-14T13:45:00+02:00' } });
      payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push(...rounds, ...after);
      return parseDHLTrackingResponse(payload, NUMBER);
    };
    const origin = { datum: '2026-08-13T15:37:44+02:00', status: 'The shipment has been processed in the parcel center of origin' };
    const back = read(origin);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null,
      last_status_text: 'The shipment has been processed in the parcel center of origin' });
    expect(back).not.toHaveProperty('expected_delivery_from');
    // The return started the day before went to the recipient again: its move keeps its stage.
    expect(back.events?.slice(0, 5).map((event) => event.stage)).toEqual(['returned', 'returned', 'out_for_delivery', 'in_transit', 'returned']);
    // A round after the return ends it, and so does a failed attempt.
    const round = read(origin, { datum: '2026-08-14T08:10:00+02:00', status: 'The shipment has been loaded onto the delivery vehicle. Delivery is expected to take place today.' });
    expect(round).toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: '2026-08-14T13:45:00+02:00' });
    expect(round.events?.slice(0, 2).map((event) => event.stage)).toEqual(['out_for_delivery', 'in_transit']);
    const attempt = read(origin, { datum: '2026-08-14T15:00:00+02:00', status: 'The recipient could not be found at the address on the shipment.' });
    expect(attempt.events?.slice(0, 2).map((event) => event.stage)).toEqual(['failed_attempt', 'in_transit']);
  });

  it('keeps the correct event order, stages and dates without private recipient data', () => {
    const result = parseDHLTrackingResponse(shipment(), NUMBER);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', timezone: 'Europe/Berlin',
      last_update: '2026-08-10T18:30:00+02:00', expected_delivery: '2026-08-12',
      events: [
        { stage: 'in_transit', location: 'Germany', time: '2026-08-10T18:30:00+02:00' },
        { stage: 'registered', time: '2026-08-09T20:00:00+02:00' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(JSON.stringify(result)).not.toContain(NUMBER);
  });

  it('reads a scan abroad on its country’s clock, where DHL puts Germany’s offset on it', () => {
    const payload = shipment();
    const timeline = payload.sendungen[0]!.sendungsdetails.sendungsverlauf;
    timeline.datumAktuellerStatus = '2026-10-21T11:38:00+02:00';
    timeline.events.push(
      { datum: '2026-10-21T01:17:00+02:00', ort: 'Romania', status: 'The shipment has arrived in the destination country/destination area.' },
      { datum: '2026-10-21T03:00:00-04:00', ort: 'Canada', status: 'The shipment has arrived at the parcel center' },
      { datum: '2026-10-21T11:38:00+02:00', ort: 'Bulgaria', status: 'The shipment has been loaded onto the delivery vehicle' },
    );
    const parsed = parseDHLTrackingResponse(payload, NUMBER);
    expect(parsed).toMatchObject({ last_update: null, last_update_local: '2026-10-21T11:38:00' });
    expect(parsed.events?.slice(0, 3)).toEqual([
      expect.objectContaining({ location: 'Bulgaria', local_time: '2026-10-21T11:38:00' }),
      // An offset that is not Germany's is DHL's own.
      expect.objectContaining({ location: 'Canada', time: '2026-10-21T03:00:00-04:00' }),
      expect.objectContaining({ location: 'Romania', local_time: '2026-10-21T01:17:00' }),
    ]);
    expect(parsed.events?.[0]).not.toHaveProperty('time');
    const dated = dateLocalClocks('dhl', parsed);
    expect(dated.last_update).toBe('2026-10-21T11:38:00+03:00');
    expect(dated.events?.slice(0, 4)).toEqual([
      expect.objectContaining({ time: '2026-10-21T11:38:00+03:00', time_zone: 'Europe/Sofia' }),
      expect.objectContaining({ time: '2026-10-21T03:00:00-04:00' }),
      expect.objectContaining({ time: '2026-10-21T01:17:00+03:00', time_zone: 'Europe/Bucharest' }),
      expect.objectContaining({ location: 'Germany', time: '2026-08-10T18:30:00+02:00' }),
    ]);
  });

  it('reads DHL’s German wording and country names as it reads its English', () => {
    const payload = shipment({ zielland: 'Vereinigtes Königreich' });
    const timeline = payload.sendungen[0]!.sendungsdetails.sendungsverlauf;
    timeline.status = 'Die Sendung liegt zur Abholung in einem ParcelShop/in der Postfiliale bereit.';
    timeline.datumAktuellerStatus = '2026-10-22T09:05:00+02:00';
    timeline.events = [
      { datum: '2026-10-19T11:29:06+02:00', ort: 'Deutschland', status: 'Die Sendung wurde abgeholt.' },
      { datum: '2026-10-19T12:00:00+02:00', status: 'Die Sendung wurde von DHL abgeholt.' },
      { datum: '2026-10-20T06:10:04+02:00', status: 'Die Sendung wird für die Verladung ins Zustellfahrzeug vorbereitet.' },
      { datum: '2026-10-21T11:48:00+02:00', ort: 'Großbritannien',
        status: "Die Sendung ist im Zielland/Zielgebiet  eingetroffen. (Homepage / online shipment tracking: <a href='https://parcels.example/'>parcels.example</a>)" },
      { datum: '2026-10-22T09:05:00+02:00', ort: 'Großbritannien',
        status: 'Die Sendung liegt zur Abholung in einem ParcelShop/in der Postfiliale bereit. Näheres zum Sendungsstatus finden Sie <a href="https://www.dhl.de/de/">hier</a>.' },
    ];
    const parsed = parseDHLTrackingResponse(payload, NUMBER);
    expect(parsed).toMatchObject({ current_stage: 'ready_for_pickup', destination_country: 'GB', last_update: null, last_update_local: '2026-10-22T09:05:00' });
    expect(parsed.events?.map(({ stage, time, local_time }) => [stage, time ?? local_time])).toEqual([
      ['ready_for_pickup', '2026-10-22T09:05:00'],
      ['in_transit', '2026-10-21T11:48:00'],
      // Still at the delivery base: "processed in the delivery base" in English.
      ['in_transit', '2026-10-20T06:10:04+02:00'],
      ['accepted', '2026-10-19T12:00:00+02:00'],
      ['accepted', '2026-10-19T11:29:06+02:00'],
    ]);
    expect(parsed.events?.[1]?.description).toBe('Die Sendung ist im Zielland/Zielgebiet eingetroffen.');
  });

  it('produces every capability declared in carrier.json', () => {
    const checks: Record<string, (result: CarrierResult) => unknown> = {
      history: (result) => result.events?.length,
      location: (result) => result.events?.some((event) => event.location),
      eta: (result) => result.expected_delivery,
      destination_country: (result) => result.destination_country,
    };
    const declared = json<{ capabilities: string[] }>('./carrier.json').capabilities;
    const result = parseDHLTrackingResponse(shipment(), NUMBER);
    expect(declared.length).toBeGreaterThan(0);
    for (const capability of declared) {
      expect(checks[capability], `no check for capability ${capability}`).toBeDefined();
      expect(checks[capability]!(result), capability).toBeTruthy();
    }
  });

  it.each([
    ['The shipment has been loaded into the delivery vehicle', 'out_for_delivery', 'out_for_delivery'],
    ['Die Sendung wurde in das Zustellfahrzeug geladen.', 'out_for_delivery', 'out_for_delivery'],
    ['The shipment could not be delivered', 'failed_attempt', 'exception'],
    ['Die Sendung konnte nicht zugestellt werden.', 'failed_attempt', 'exception'],
    ['Die Sendung wurde nicht erfolgreich zugestellt.', 'failed_attempt', 'exception'],
    // A "nicht" in one sentence and "zugestellt" in the next are no failed delivery.
    ['Eine Umleitung ist nicht mehr möglich. Die Sendung wird heute zugestellt.', 'in_transit', 'in_transit'],
    ['Delivery not possible. Pickup information will follow by mail', 'failed_attempt', 'exception'],
    ['Delivery not possible. Forwarding in postal retail outlet', 'failed_attempt', 'exception'],
    // On the way to the outlet after "Forwarding to outlet"; not waiting there yet.
    ['Available for pickup shortly', 'in_transit', 'in_transit'],
    ['The shipment is ready for collection', 'ready_for_pickup', 'out_for_delivery'],
    ['Die Sendung liegt zur Abholung bereit.', 'ready_for_pickup', 'out_for_delivery'],
    ['The shipment is being processed by customs', 'customs', 'in_transit'],
    ['The customs clearance process for import into the destination country/region has been completed. Please find more information here.', 'in_transit', 'in_transit'],
    ['The customs clearance process for import into the destination country/region has started. Please find more information here.', 'customs', 'in_transit'],
    ['The shipment will be transported to the destination country/destination area and, from there, handed over to the delivery organization.', 'in_transit', 'in_transit'],
    ['The shipment was handed over to DHL.', 'accepted', 'in_transit'],
    ['The shipment has been posted by the sender at the retail outlet', 'accepted', 'in_transit'],
    ['The shipment is being prepared for delivery in the delivery depot', 'in_transit', 'in_transit'],
    ['The shipment is returning to sender', 'returned', 'exception'],
    ['The recipient has not picked up the shipment from the retail outlet within the seven-day storage period', 'exception', 'exception'],
    ['Der Empfänger hat die Sendung innerhalb der siebentägigen Lagerfrist nicht in der Filiale abgeholt.', 'exception', 'exception'],
    ['Die Sendung wurde nicht abgeholt und wird zurückgesandt.', 'returned', 'exception'],
    ['Die Sendung befindet sich auf dem Weg zurück zum Absender.', 'returned', 'exception'],
    ['The shipment will be returned.', 'exception', 'exception'],
    ['The shipment has been returned to the sender', 'returned', 'exception'],
    // The English of "wird an den Absender zurückgesandt", after a failed round: the return starts.
    ['Unfortunately delivery of the shipment was not possible. The shipment is returned to the sender.', 'returned', 'exception'],
    ['Die Zustellung war nicht möglich. Die Sendung wird an den Absender zurückgesandt.', 'returned', 'exception'],
    ['The recipient could not be found at the address on the shipment.', 'failed_attempt', 'exception'],
    ['The shipment has been delivered', 'delivered', 'delivered'],
    ['Die Sendung wurde erfolgreich zugestellt.', 'delivered', 'delivered'],
  ])('maps %s without confusing future or failed delivery with delivery', (text, stage, status) => {
    const result = parseDHLTrackingResponse(shipment({
      sendungsverlauf: { status: text, fortschritt: 4, events: [{ status: text, datum: '2026-08-10T10:00:00Z' }] },
    }), NUMBER);
    expect(result.current_stage).toBe(stage);
    expect(result.status).toBe(status);
    expect(result.events?.[0]?.stage).toBe(stage);
  });

  it.each([
    ['Germany', { destination_country: 'DE' }],
    ['United Kingdom', { destination_country: 'GB' }],
    ['Greece', { destination_country: 'GR' }],
    ['Example Federation', { destination_country_name: 'Example Federation' }],
  ])('reads the destination country %s and no more of the address', (zielland, expected) => {
    const result = parseDHLTrackingResponse(shipment({ zielland }), NUMBER);
    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toContain('Private');
  });

  // ARCHITECTURE: an S10 item that names no partner is proposed to its
  // destination's national post, which then has to confirm it.
  it.each([
    ['France', { carrier: 'la-poste', number: NUMBER, basis: 'destination' }],
    ['Italy', { carrier: 'poste-italiane', number: NUMBER, basis: 'destination' }],
    ['India', null],
  ])('proposes an S10 item bound for %s to that country’s post only when it has one', (zielland, expected) => {
    const result = parseDHLTrackingResponse(shipment({ zielland }), NUMBER);
    expect(deliveryHandoff('dhl', NUMBER, result)).toEqual(expected);
  });

  // DHL Paket's international parcels go to the partner DHL names for their
  // destination; Deutsche Post's letter-post items to that country's post.
  const PARCEL = 'CX123456785DE';
  function parcel(zielland: string, arrival?: string) {
    const payload = shipment({ zielland });
    payload.sendungen[0]!.id = PARCEL;
    if (arrival) payload.sendungen[0]!.sendungsdetails.sendungsverlauf.events.push({ datum: '2026-08-11T10:00:00+02:00',
      status: `The shipment has arrived in the destination country/destination area. (Homepage / online shipment tracking: ${arrival})` });
    return parseDHLTrackingResponse(payload, PARCEL);
  }
  it.each([
    ['Finland', 'postnord'], ['Ukraine', 'meest'], ['Poland', null], ['Switzerland', null],
    ['Lithuania', null], ['Latvia', null], ['Spain', null], ['Italy', null], ['Slovakia', null],
  ])('proposes a parcel bound for %s to the partner DHL names there, when it looks up DHL’s number', (zielland, partner) => {
    expect(deliveryHandoff('dhl', PARCEL, parcel(zielland))).toEqual(partner && { carrier: partner, number: PARCEL, basis: 'destination' });
    expect(deliveryHandoff('dhl', PARCEL, { status: 'in_transit' }, countryCode(zielland))?.carrier ?? null).toBe(partner);
  });

  it.each([['Poland', 'poczta-polska'], ['Switzerland', 'swiss-post']])('proposes a letter-post item bound for %s to its post', (zielland, post) => {
    expect(deliveryHandoff('dhl', NUMBER, parseDHLTrackingResponse(shipment({ zielland }), NUMBER))?.carrier).toBe(post);
  });

  it('follows the partner the arrival scan links, and names DHL Express without asking it about DHL’s number', () => {
    expect(deliveryHandoff('dhl', PARCEL, parcel('Switzerland', 'http://www.post.ch')))
      .toEqual({ carrier: 'swiss-post', number: PARCEL, basis: 'partner' });
    expect(deliveryHandoff('dhl', PARCEL, parcel('Lithuania', `https://www.itella.lt/en/private-customer/track-shipment/?trackingCode=${PARCEL}`)))
      .toEqual({ carrier: 'posti', number: PARCEL, basis: 'partner' });
    expect(deliveryHandoff('dhl', PARCEL, parcel('Spain', `https://clientesparcel.dhl.es/LiveTracking/ModifyMyShipment/en?codigo=${PARCEL}&app=TRACKING`)))
      .toEqual({ carrier: 'dhl-ecommerce-es', number: PARCEL, basis: 'partner' });
    const express = parcel('Italy', `https://www.logistics.dhl/it-it/home/tracking/tracking-express.html?submit=1&tracking-id=${PARCEL}`);
    expect(express.delivery_carrier).toBe('dhl-express');
    expect(deliveryHandoff('dhl', PARCEL, express)).toBeNull();
    // SPS's track-and-trace host names SPS, which is not asked about DHL's number, nor is Slovakia's post.
    const sps = parcel('Slovakia', 'https://t-t.sps-sro.sk');
    expect(sps.delivery_carrier).toBe('slovak-parcel-service');
    expect(deliveryHandoff('dhl', PARCEL, sps)).toBeNull();
  });

  it('leaves the destination out when DHL names none', () => {
    const result = parseDHLTrackingResponse(shipment({ zielland: undefined }), NUMBER);
    expect(result).not.toHaveProperty('destination_country');
    expect(result).not.toHaveProperty('destination_country_name');
  });

  it('uses the explicit delivered flag and removes stale estimates', () => {
    expect(parseDHLTrackingResponse(shipment({ istZugestellt: true }), NUMBER)).toMatchObject({
      status: 'delivered', current_stage: 'delivered', expected_delivery: null,
    });
    expect(parseDHLTrackingResponse(shipment({ istZugestellt: true, ruecksendung: true }), NUMBER))
      .toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
    expect(parseDHLTrackingResponse(shipment({ zustellung: { zustellzeitfensterVon: '2026-02-30' } }), NUMBER).expected_delivery).toBeNull();
  });

  it('keeps both ends of the delivery window', () => {
    const window = (von: unknown, bis: unknown) => {
      const result = parseDHLTrackingResponse(shipment({ zustellung: { zustellzeitfensterVon: von, zustellzeitfensterBis: bis } }), NUMBER);
      return { from: result.expected_delivery_from, to: result.expected_delivery };
    };
    expect(window('2026-08-12T10:45:00.000+02:00', '2026-08-12T13:45:00.000+02:00'))
      .toEqual({ from: '2026-08-12T10:45:00.000+02:00', to: '2026-08-12T13:45:00.000+02:00' });
    // Days apart, the window is the days; reversed or with one end alone, the day DHL names first.
    expect(window('2026-08-12T09:00:00+02:00', '2026-08-13T18:00:00+02:00')).toEqual({ from: '2026-08-12', to: '2026-08-13' });
    expect(window('2026-08-12', '2026-08-13')).toEqual({ from: '2026-08-12', to: '2026-08-13' });
    expect(window('2026-08-12T13:45:00+02:00', '2026-08-12T10:45:00+02:00')).toEqual({ from: undefined, to: '2026-08-12' });
    expect(window(undefined, '2026-08-12T13:45:00+02:00')).toEqual({ from: undefined, to: '2026-08-12' });
    expect(window('2026-08-12T10:45:00', '2026-08-12T13:45:00')).toEqual({ from: undefined, to: '2026-08-12' });
    expect(parseDHLTrackingResponse(shipment({ istZugestellt: true,
      zustellung: { zustellzeitfensterVon: '2026-08-12T10:45:00+02:00', zustellzeitfensterBis: '2026-08-12T13:45:00+02:00' } }), NUMBER))
      .not.toHaveProperty('expected_delivery_from');
  });

  it('does not treat a planned delivery as completed', () => {
    const result = parseDHLTrackingResponse(shipment({
      sendungsverlauf: { status: 'The shipment will be delivered tomorrow', fortschritt: 3, events: [] },
    }), NUMBER);
    expect(result.current_stage).toBe('in_transit');
  });

  it('reads a booked collection as announced, so the pick-up that follows is progress', () => {
    const result = parseDHLTrackingResponse(shipment({ sendungsverlauf: { status: 'Pick-up was successful.', fortschritt: 1, events: [
      { datum: '2026-08-09T20:00:00+02:00', status: 'Pick-up has been scheduled for the next working day and the information has been sent to the delivery person' },
      { datum: '2026-08-10T09:58:52+02:00', status: 'Pick-up was successful.' },
    ] } }), NUMBER);
    expect(result.events?.map((event) => event.stage)).toEqual(['accepted', 'registered']);
    expect(result.current_stage).toBe('accepted');
  });

  it('keeps scans of one instant in the carrier\'s order', () => {
    const result = parseDHLTrackingResponse(shipment({ sendungsverlauf: { status: 'Pick-up was successful.', fortschritt: 2, events: [
      { datum: '2026-08-09T20:00:00+02:00', status: 'The instruction data for this shipment have been provided by the sender to DHL electronically' },
      { datum: '2026-08-10T09:58:52+02:00', status: 'Pick-up was successful.' },
      { datum: '2026-08-10T09:58:52+02:00', status: 'The shipment has been posted by the sender at the retail outlet' },
    ] } }), NUMBER);
    expect(result.events?.map((event) => event.description)).toEqual(['The shipment has been posted by the sender at the retail outlet',
      'Pick-up was successful.', 'The instruction data for this shipment have been provided by the sender to DHL electronically']);
  });

  it('accepts only an explicit no-data result for the requested number', () => {
    const payload = { sendungen: [{ id: NUMBER, sendungNichtGefunden: { keineDatenVerfuegbar: true } }] };
    expect(parseDHLTrackingResponse(payload, NUMBER)).toMatchObject({ status: 'unknown', events: [] });
    expect(() => parseDHLTrackingResponse(payload, 'LF000000005DE')).toThrow('matching shipment');
    expect(() => parseDHLTrackingResponse({ sendungen: [] }, NUMBER)).toThrow('empty tracking response');
    expect(() => parseDHLTrackingResponse({ sendungen: [{ id: NUMBER }] }, NUMBER)).toThrow('no usable tracking status');
    expect(() => parseDHLTrackingResponse({ sendungen: [...payload.sendungen, ...payload.sendungen] }, NUMBER)).toThrow('one matching shipment');
    expect(() => parseDHLTrackingResponse({ rateLimited: true }, NUMBER)).toThrow('rate limiting');
  });

  it('does not silently treat other DHL services or required verification as unannounced', () => {
    expect(() => parseDHLTrackingResponse({ sendungen: [{ id: NUMBER, plzBenoetigt: true }] }, NUMBER)).toThrow('verification');
    // A postcode request is a parcel DHL holds, unless the record also says DHL has none.
    expect(() => parseDHLTrackingResponse({ sendungen: [{ id: NUMBER, plzBenoetigt: true, sendungNichtGefunden: { keineDatenVerfuegbar: false } }] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'input_required', reason: 'parcel_found' }));
    for (const shipment of [{ plzBenoetigt: true, sendungNichtGefunden: { keineDhlPaketSendung: true } }, { versandDatumBenoetigt: true }]) {
      expect(() => parseDHLTrackingResponse({ sendungen: [{ id: NUMBER, ...shipment }] }, NUMBER))
        .toThrow(expect.objectContaining({ kind: 'input_required', reason: undefined }));
    }
    expect(() => parseDHLTrackingResponse({ sendungen: [{ id: NUMBER, sendungNichtGefunden: { keineDhlPaketSendung: true } }] }, NUMBER)).toThrow('own tracking website');
    for (const missing of [{ keineDhlPaketSendung: true, keineDatenVerfuegbar: true }, { sendungsnummerNichtSuchbar: true }]) {
      expect(() => parseDHLTrackingResponse({ sendungen: [{ id: NUMBER, sendungNichtGefunden: missing }] }, NUMBER))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    }
  });

  it('reads a failed search behind the page as no answer, whatever not-found flag it sets', () => {
    for (const missing of [{ keineDatenVerfuegbar: true }, { keineDhlPaketSendung: true }, { sendungsnummerNichtSuchbar: true }]) {
      const payload = { sendungen: [{ id: NUMBER, hasCompleteDetails: true, shipmentSearchBackendError: true, sendungNichtGefunden: missing }] };
      expect(() => parseDHLTrackingResponse(payload, NUMBER))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined, message: 'DHL’s shipment search failed' }));
    }
    // A record that lists scans despite the flag is still DHL's answer.
    const listed = parseDHLTrackingResponse({ sendungen: [{
      id: NUMBER, shipmentSearchBackendError: true,
      sendungsdetails: { sendungsverlauf: { status: 'The shipment has been processed in the parcel center', events: [
        { datum: '2026-03-02T08:00:00.000+01:00', ort: 'Sample Town', status: 'The shipment has been processed in the parcel center' },
      ] } },
    }] }, NUMBER);
    expect(listed).toMatchObject({ current_stage: 'in_transit', events: [{ description: 'The shipment has been processed in the parcel center' }] });
  });

  it('normalizes safe identifiers and builds an official tracking link', () => {
    expect(normalizeDHLTrackingNumber('lf 999.999-987 de')).toBe(NUMBER);
    expect(dhlTrackingUrl(NUMBER)).toBe(`https://www.dhl.de/en/privatkunden/dhl-sendungsverfolgung.html?piececode=${NUMBER}`);
    expect(() => normalizeDHLTrackingNumber('https://evil.example')).toThrow('invalid');
  });

  it('asks DHL for an SSCC typed without its (00) as the whole SSCC, and binds the answer to it', () => {
    const sscc = '00340434509999999994';
    expect(normalizeDHLTrackingNumber('3404 3450 9999 9999 94')).toBe(sscc);
    expect(dhlTrackingUrl('340434509999999994')).toBe(`https://www.dhl.de/en/privatkunden/dhl-sendungsverfolgung.html?piececode=${sscc}`);
    // A failing check digit, or eighteen digits outside DHL Paket's prefixes, is asked as typed.
    expect(normalizeDHLTrackingNumber('340434509999999995')).toBe('340434509999999995');
    expect(normalizeDHLTrackingNumber('340424509999999997')).toBe('340424509999999997');
    const payload = { sendungen: [{ id: sscc, sendungNichtGefunden: { keineDatenVerfuegbar: true } }] };
    expect(parseDHLTrackingResponse(payload, '340434509999999994')).toMatchObject({ status: 'unknown', events: [] });
    expect(() => parseDHLTrackingResponse({ sendungen: [{ id: '00340434509999999987', sendungNichtGefunden: { keineDatenVerfuegbar: true } }] }, '340434509999999994'))
      .toThrow('matching shipment');
  });
});

describe('DHL sessions and browser fallback', () => {
  it('uses the public config, CSRF cookie and WG header, then reuses the session', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(Response.json(shipment(), { headers: { 'verfolgen-CSRF-token': 'rotated-csrf' } }))
      .mockResolvedValueOnce(Response.json(shipment()));
    const tracker = new DHLTracker({ trawl: null });
    expect((await tracker.fetch(NUMBER)).events).toHaveLength(2);
    await tracker.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0]![0])).toBe(CONFIG);
    expect(String(fetcher.mock.calls[1]![0])).toBe(SEARCH);
    const first = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(first.get('verfolgen-CSRF-token')).toBe('test-csrf');
    expect(first.get('verfolgen-wg')).toBe('0');
    expect(first.get('cookie')).toContain('verfolgenCsrfToken=test-csrf');
    expect(new Headers(fetcher.mock.calls[2]![1]?.headers).get('verfolgen-CSRF-token')).toBe('rotated-csrf');
  });

  it('asks for German for a German reader and English for anyone else', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) => (String(url).startsWith(CONFIG) ? config() : Response.json(shipment())));
    const carrier = adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    for (const [language, asked] of [['de', 'de'], ['de-AT', 'de'], ['fr', 'en'], [null, 'en']] as const) {
      await carrier.track({ number: NUMBER, language }, { budgetMs: 10_000 });
      expect(new URL(String(fetcher.mock.calls.at(-1)![0])).searchParams.get('language')).toBe(asked);
    }
    expect(String(fetcher.mock.calls[0]![0])).toBe(CONFIG);
  });

  it('uses the configured private browser for a rejected session', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>Challenge</html>', { headers: { 'Content-Type': 'text/html' } }))
      .mockResolvedValueOnce(solved([
        { name: 'ak_bmsc', value: 'browser-proof', domain: '.dhl.de', path: '/', secure: true },
        { name: 'unrelated', value: 'private-other-site', domain: 'evil-dhl.de', path: '/' },
      ], 'Browser UA'))
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce(Response.json(shipment()));
    const result = await new DHLTracker({ trawl: new TrawlClient('http://trawl:8191/v1') }).fetch(NUMBER);
    expect(result.current_stage).toBe('in_transit');
    expect(String(fetcher.mock.calls[1]![0])).toBe('http://trawl:8191/scrape');
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toMatchObject({ skipHttp: true, maxTier: 3, url: dhlTrackingUrl(NUMBER) });
    const headers = new Headers(fetcher.mock.calls[2]![1]?.headers);
    expect(headers.get('user-agent')).toBe('Browser UA');
    expect(headers.get('cookie')).toContain('browser-proof');
    expect(headers.get('cookie')).not.toContain('private-other-site');
  });

  it('opens a fresh session before the age at which DHL stops answering the old one', async () => {
    let now = Date.parse('2026-09-17T08:10:00Z');
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json(shipment()))
      .mockResolvedValueOnce(Response.json(shipment()))
      .mockResolvedValueOnce(config('renewed')).mockResolvedValueOnce(Response.json(shipment()));
    const tracker = new DHLTracker({ trawl: null, now: () => now });
    await tracker.fetch(NUMBER);
    now += 90 * 60_000;
    await tracker.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(3);
    // The stale session is never asked: that request hung for the whole timeout in production.
    now += 10 * 60_000;
    await tracker.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(String(fetcher.mock.calls[3]![0])).toBe(CONFIG);
    expect(new Headers(fetcher.mock.calls[4]![1]?.headers).get('verfolgen-CSRF-token')).toBe('renewed');
  });

  it('renews an expired session with HTTP before attempting a browser', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json(shipment()))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(config('renewed')).mockResolvedValueOnce(Response.json(shipment()));
    const tracker = new DHLTracker({ trawl: new TrawlClient('http://trawl:8191') });
    await tracker.fetch(NUMBER);
    await tracker.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(String(fetcher.mock.calls[3]![0])).toBe(CONFIG);
  });

  it.each(['config', 'search', 'body', 'cached'])('recovers from an interrupted %s request with one fresh session', async (phase) => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const tracker = new DHLTracker({ trawl: new TrawlClient('http://trawl:8191') });
    if (phase === 'cached') {
      fetcher.mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json(shipment()));
      await tracker.fetch(NUMBER);
      fetcher.mockClear();
    } else if (phase !== 'config') {
      fetcher.mockResolvedValueOnce(config());
    }
    const timeout = new DOMException('Timed out', 'TimeoutError');
    if (phase === 'body') {
      fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(timeout); } }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    } else {
      fetcher.mockRejectedValueOnce(timeout);
    }
    fetcher.mockResolvedValueOnce(config('renewed')).mockResolvedValueOnce(Response.json(shipment()));
    expect((await tracker.fetch(NUMBER)).current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledTimes(['search', 'body'].includes(phase) ? 4 : 3);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('trawl'))).toBe(false);
  });

  it('uses the browser when fresh direct sessions also time out', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(solved([]))
      .mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json(shipment()));
    const tracker = new DHLTracker({ trawl: new TrawlClient('http://trawl:8191') });
    expect((await tracker.fetch(NUMBER)).events).toHaveLength(2);
    expect(String(fetcher.mock.calls[2]![0])).toBe('http://trawl:8191/scrape');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('bounds repeated network failures and allows the next sync to recover', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
    const tracker = new DHLTracker({ trawl: null });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ name: 'UpstreamNetworkError' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockReset().mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json(shipment()));
    expect((await tracker.fetch(NUMBER)).current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('cancels one lookup alone: no renewal, no browser, no session left for the next caller', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error));
      }))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(solved([]))
      .mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json(shipment()));
    const tracker = new DHLTracker({ trawl: new TrawlClient('http://trawl:8191') });
    const [running, waiting] = [new AbortController(), new AbortController()];
    const cancelled = tracker.fetch(NUMBER, { signal: running.signal });
    const left = tracker.fetch(NUMBER, { signal: waiting.signal });
    const next = tracker.fetch(NUMBER);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    // A caller that leaves the queue does not wait for the lookup ahead of it.
    waiting.abort(new Error('left the queue'));
    await expect(left).rejects.toThrow('left the queue');
    running.abort(new Error('caller cancelled'));
    await expect(cancelled).rejects.toMatchObject({ name: 'UpstreamNetworkError' });
    // The next lookup opens its own session: rejected outright, it goes straight to the browser.
    expect((await next).current_stage).toBe('in_transit');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([CONFIG, CONFIG, 'http://trawl:8191/scrape', CONFIG, SEARCH]);
  });

  it('counts the wait for a turn against a budget the caller set', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error));
    }));
    const tracker = new DHLTracker({ trawl: new TrawlClient('http://trawl:8191') });
    const running = new AbortController();
    const hung = tracker.fetch(NUMBER, { signal: running.signal });
    await expect(tracker.fetch(NUMBER, { budgetMs: 20 })).rejects.toMatchObject({ kind: 'budget', message: expect.stringContaining('20 ms') });
    expect(fetcher).toHaveBeenCalledTimes(1);
    running.abort(new Error('caller cancelled'));
    await expect(hung).rejects.toMatchObject({ name: 'UpstreamNetworkError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])('does not bypass HTTP %s using the browser', async (status) => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));
    await expect(new DHLTracker({ trawl: new TrawlClient('http://trawl:8191') }).fetch(NUMBER)).rejects.toMatchObject({ status });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not downgrade malformed data, rejected challenges or missing results to a waiting parcel', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Challenge', { status: 403 }));
    await expect(new DHLTracker({ trawl: null }).fetch(NUMBER)).rejects.toBeInstanceOf(DHLSessionError);
    fetcher.mockReset().mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json({ error: 'Private upstream details' }));
    await expect(new DHLTracker({ trawl: new TrawlClient('http://trawl:8191') }).fetch(NUMBER)).rejects.toThrow('invalid tracking response');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes a parcel DHL has scanned or holds behind a postcode, and not one it has no data for', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json(shipment()))
      .mockResolvedValueOnce(Response.json({ sendungen: [{ id: NUMBER, sendungNichtGefunden: { keineDatenVerfuegbar: true } }] }))
      .mockResolvedValueOnce(Response.json({ sendungen: [{ id: NUMBER, plzBenoetigt: true }] }));
    const tracker = new DHLTracker({ trawl: null });
    expect(await tracker.recognizes(NUMBER)).toEqual({ known: true, lastActivityAt: '2026-08-10T16:30:00.000Z' });
    expect(await tracker.recognizes(NUMBER)).toEqual({ known: false, lastActivityAt: null });
    expect(await tracker.recognizes(NUMBER)).toEqual({ known: true, lastActivityAt: null });
  });

  it('keeps recognition inconclusive without opening the browser', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Challenge', { status: 403 }));
    await expect(new DHLTracker({ trawl: new TrawlClient('http://trawl:8191') }).recognizes(NUMBER)).rejects.toBeInstanceOf(DHLSessionError);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([CONFIG]);
    fetcher.mockReset().mockResolvedValueOnce(config())
      .mockResolvedValueOnce(Response.json({ sendungen: [{ id: NUMBER, sendungNichtGefunden: { keineDhlPaketSendung: true } }] }));
    await expect(new DHLTracker({ trawl: null }).recognizes(NUMBER)).rejects.toThrow('own tracking website');
  });

  it('reports one direct step, then the browser step, through the recorder', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Challenge', { status: 403 }))
      .mockResolvedValueOnce(solved([]))
      .mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json(shipment()));
    const steps: { step: string; outcome: string; fallbackFrom: string | null }[] = [];
    const lookups: { finalStep: string | null; outcome: string }[] = [];
    await new DHLTracker({ trawl: new TrawlClient('http://trawl:8191'), recorder: {
      step: ({ step, outcome, fallbackFrom }) => { steps.push({ step, outcome, fallbackFrom }); },
      lookup: ({ finalStep, outcome }) => { lookups.push({ finalStep, outcome }); },
    } }).fetch(NUMBER);
    expect(steps).toEqual([
      { step: 'direct', outcome: 'challenge', fallbackFrom: null },
      { step: 'trawl', outcome: 'ok', fallbackFrom: 'direct' },
    ]);
    expect(lookups).toEqual([{ finalStep: 'trawl', outcome: 'ok' }]);
  });
});

describe('DHL recipient postcode', () => {
  const SHIPMENT = 'https://www.dhl.de/int-verfolgen/data/shipment?language=en';
  const held = (details: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    Response.json({ sendungen: [{ id: NUMBER, plzBenoetigt: true, sendungsdetails: details, ...extra }] });
  const carrier = () => adapter({ fetcher: fetch, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  it('sends the postcode the way DHL’s page does when several shipments share the number', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(config()).mockResolvedValueOnce(held({ international: true }))
      .mockResolvedValueOnce(Response.json(shipment()));
    const result = await carrier().track({ number: NUMBER, postcode: ' 1010 ' }, { budgetMs: 10_000 });
    expect(result.current_stage).toBe('in_transit');
    expect(String(fetcher.mock.calls[2]![0])).toBe(SHIPMENT);
    const init = fetcher.mock.calls[2]![1]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ piececode: NUMBER, zip: '1010', international: true });
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('verfolgen-CSRF-token')).toBe('test-csrf');
    expect(headers.get('verfolgen-wg')).toBeNull();
  });

  it('sends no postcode DHL does not ask for, nor one for the sender or a missing shipment', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(config()).mockResolvedValueOnce(Response.json(shipment()));
    const tracker = new DHLTracker({ trawl: null });
    expect((await tracker.fetch(NUMBER, {}, '10115')).current_stage).toBe('in_transit');
    for (const answer of [held({ isShipperPlz: true }), held({}, { versandDatumBenoetigt: true }),
      held({}, { sendungNichtGefunden: { keineDhlPaketSendung: true } })]) {
      fetcher.mockResolvedValueOnce(answer);
      await expect(tracker.fetch(NUMBER, {}, '10115')).rejects.toMatchObject({ kind: 'input_required' });
    }
    // Without a postcode, a postcode request stays a parcel DHL holds.
    fetcher.mockResolvedValueOnce(held());
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'input_required', reason: 'parcel_found' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain(SHIPMENT);
  });

  it('tells a postcode DHL refuses from a failed request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(config());
    const tracker = new DHLTracker({ trawl: null });
    const refused = async (answer: Response) => {
      fetcher.mockResolvedValueOnce(held()).mockResolvedValueOnce(answer);
      return tracker.fetch(NUMBER, {}, '10115').catch((error: unknown) => error);
    };
    expect(await refused(Response.json({ error: 'Your input was incorrect.' }, { status: 400 })))
      .toMatchObject({ kind: 'input_required', reason: 'postcode_mismatch' });
    // An answer still asking for the postcode did not take it either.
    expect(await refused(held())).toMatchObject({ kind: 'input_required', reason: 'postcode_mismatch' });
    // After repeated refusals DHL names the time it takes another.
    const blocked = await refused(Response.json({ blockTime: Date.now() + 600_000 }, { status: 400 }));
    expect(blocked).toMatchObject({ kind: 'input_required', reason: 'postcode_mismatch' });
    expect((blocked as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(500_000);
    expect(await refused(Response.json({ error: 'An error occurred processing the request. Please try again later.' }, { status: 406 })))
      .toMatchObject({ name: 'UpstreamHttpError', status: 406 });
    expect(await refused(Response.json({ error: 'Your input was incorrect.' }, { status: 500 })))
      .toMatchObject({ name: 'UpstreamHttpError', status: 500 });
  });

  it('rejects a postcode no country writes before asking DHL', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(new DHLTracker({ trawl: null }).fetch(NUMBER, {}, '<1>')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
