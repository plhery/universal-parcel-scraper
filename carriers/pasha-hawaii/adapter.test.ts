import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { CarrierResult } from '../../core/result/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import {
  containerCheckDigit, MAX_DETAILS, PASHA_TRACKER, pashaContainer, pashaContainerResult, pashaQuery, pashaSearchForm, pashaShipment, pashaShipmentResult,
  type PashaMove, type PashaQuery,
} from './parser.js';
import { pashaSide, pashaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples: two Pasha containers and the bills and bookings their moves name. The
// unknown numbers are invented, the container with a matching check digit.
const LONG_BEACH = 'PGHU4014372';
const OAKLAND = 'PGHU4016122';
const BILL = '552811120012';
const EARLIER_BILL = '573810910196';
const OAKLAND_BILL = '557811110017';
const BOOKING = '2811120394';
const OAKLAND_BOOKING = '7811110178';
const UNKNOWN = { container: 'CRSU1234566', booking: '3400000000', bill: '573400000000' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const container = (number: string) => fixture(`container-${number}.html`);
const bill = (number: string) => fixture(`bill-${number}.html`);
const booking = (number: string) => fixture(`booking-${number}.html`);

/** A container's reply with only the moves `keep` takes, by their date as the table writes it and their row from the newest. */
const keepMoves = (body: string, keep: (date: string, index: number) => boolean) => {
  let index = 0;
  return body.replace(/\s*<tr class="MoveDetailsRow">\s*<td style="white-space: nowrap">([^<]*)<\/td>[\s\S]*?<\/tr>/g, (row, date: string) => keep(date, index++) ? row : '');
};
const moves = (body: string, number: string) => pashaContainer(body, number)!;
const latest = (body: string, number = LONG_BEACH) => pashaContainerResult(moves(body, number));
const rows = (result: CarrierResult) => (result.events ?? []).map(event => [event.time ?? event.local_time, event.description, event.location ?? null, event.stage ?? null]);
/** A shipment's result with each container's reply in `replies`. */
const shipment = (body: string, query: PashaQuery, replies: Record<string, string>) => {
  const read = pashaShipment(body, query)!;
  return pashaShipmentResult(read, new Map(read.containers.slice(0, MAX_DETAILS).map(({ number }) => [number, replies[number] ? pashaContainer(replies[number], number) : null])));
};
/** A booking's or bill's reply with another container listed after the first, as `number`. */
const withContainer = (body: string, first: string, number: string) =>
  body.replace(/(<tr class="ItemContainerDetailsRow">[\s\S]*?<\/tr>)/, (row: string) => `${row}\n${row.replaceAll(first, number)}`);

const HONOLULU = 'HONOLULU, HI';
const LB_TERMINAL = 'LONG BEACH SSAPIER A';

describe('Pasha Hawaii replies', () => {
  it('reads a container\'s latest cycle newest first, each move at the place it took place and in that place\'s zone', () => {
    const result = latest(container(LONG_BEACH));
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Import Outgate', last_update: '2026-11-21T01:51:00-08:00', expected_delivery: null });
    expect(result).not.toHaveProperty('history_truncated');
    expect(rows(result)).toEqual([
      ['2026-11-21T01:51:00-08:00', 'Import Outgate', LB_TERMINAL, 'out_for_delivery'],
      ['2026-11-18T10:17:00-08:00', 'Discharge Full from Vessel', LB_TERMINAL, 'in_transit'],
      ['2026-11-13T01:21:00-10:00', 'Loaded Full on Vessel', HONOLULU, 'in_transit'],
      ['2026-11-10T09:01:00-10:00', 'Export Ingate', HONOLULU, 'accepted'],
      ['2026-11-06T06:22:00-10:00', 'Dispatch empty', HONOLULU, 'registered'],
    ]);
    expect(result.events![0]).toEqual({ time: '2026-11-21T01:51:00-08:00', local_time: '2026-11-21T01:51:00', time_zone: 'America/Los_Angeles',
      time_zone_basis: 'place', location: LB_TERMINAL, description: 'Import Outgate', stage: 'out_for_delivery', stage_source: 'carrier_map' });
  });

  it('ends a cycle at the empty container\'s return, without its repositioning after', () => {
    const result = latest(container(OAKLAND), OAKLAND);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Empty Ingate', last_update: '2026-11-17T08:53:00-10:00' });
    expect(rows(result)).toEqual([
      ['2026-11-17T08:53:00-10:00', 'Empty Ingate', HONOLULU, 'delivered'],
      ['2026-11-13T10:14:00-10:00', 'Import Outgate', HONOLULU, 'out_for_delivery'],
      ['2026-11-12T05:03:00-10:00', 'Discharge Full from Vessel', HONOLULU, 'in_transit'],
      ['2026-11-04T13:08:00-08:00', 'Loaded Full on Vessel', 'OAKLAND,CA', 'in_transit'],
      ['2026-10-30T08:04:00-07:00', 'Export Ingate', 'OAKLAND,CA', 'accepted'],
      ['2026-07-31T12:31:00-07:00', 'Empty Gate-out', 'OAKLAND,CA', 'registered'],
    ]);
    expect(moves(container(OAKLAND), OAKLAND)[0]).toMatchObject({ description: 'Loaded Empty on Vessel', booking: null, bill: null });
  });

  it('cuts the table into cycles by the empty container\'s release and return and the references the moves carry', () => {
    const body = container(LONG_BEACH);
    // Back from the previous shipment: its cycle starts at the empty dispatched under a pool reference.
    const earlier = latest(keepMoves(body, (_, index) => index >= 5));
    expect(earlier).toMatchObject({ current_stage: 'delivered', last_update: '2026-11-06T06:02:00-10:00' });
    expect(rows(earlier).map(([, description]) => description)).toEqual([
      'Empty Ingate', 'Import Outgate', 'Discharge Full from Vessel', 'Loaded Full on Vessel', 'Export Ingate', 'Dispatch empty']);
    // Repositioned empty after its return: the latest shipment stands.
    const repositioned = latest(keepMoves(body, date => !/^(?:Nov|Oct)/.test(date)));
    expect(repositioned).toMatchObject({ current_stage: 'delivered', last_status_text: 'Empty Ingate', last_update: '2026-09-24T10:31:00-10:00' });
    expect(rows(repositioned)).toHaveLength(6);
    // A container unloaded and loaded again without its return: the new booking starts a cycle.
    const turned = latest(keepMoves(body, date => date !== 'Nov 6, 2026 06:22' && date !== 'Nov 6, 2026 06:02'));
    expect(rows(turned).map(([, description]) => description)).toEqual(['Import Outgate', 'Discharge Full from Vessel', 'Loaded Full on Vessel', 'Export Ingate']);
    // The empty container brought back from Hilo by barge, then returned under its bill.
    const barge = latest(keepMoves(body, (_, index) => index >= 29));
    expect(barge).toMatchObject({ current_stage: 'delivered', last_update: '2026-07-29T09:55:00-10:00' });
    expect(rows(barge)).toEqual([
      ['2026-07-29T09:55:00-10:00', 'Empty Ingate', HONOLULU, 'delivered'],
      ['2026-07-29T09:43:00-10:00', 'Empty Positioning by Barge', 'YOUNG BROTHERS HNL', null],
      ['2026-07-29T06:55:00-10:00', 'Discharged Empty from Barge', 'YOUNG BROTHERS HNL', null],
      ['2026-07-29T06:00:00-10:00', 'Barge Arrival', 'YOUNG BROTHERS HNL', null],
      ['2026-07-27T22:30:00-10:00', 'Barge Departure', 'YOUNG BROTHERS HIL', null],
      ['2026-07-27T19:45:00-10:00', 'Loaded Empty to Barge', 'YOUNG BROTHERS HIL', null],
    ]);
  });

  it('gives no stage to an empty container returned without a bill before it left full, nor to a wording it has not shown', () => {
    const unused = latest(keepMoves(container(LONG_BEACH), date => date === 'Nov 6, 2026 06:02').replace(/<a href="[^"]*">573810910196<\/a>/, ''));
    expect(unused).toMatchObject({ status: 'unknown', last_status_text: 'Empty Ingate', last_update: '2026-11-06T06:02:00-10:00' });
    expect(unused).not.toHaveProperty('current_stage');
    // A wording without its side is placed only where both ends agree.
    const unknown = latest(container(LONG_BEACH).replace('Discharge Full from Vessel', 'Stuffed'));
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(unknown.events![1]).toEqual({ local_time: '2026-11-18T10:17:00', description: 'Stuffed' });
    const here = latest(container(LONG_BEACH).replace(/HONOLULU STREET<\/td>(\s*<td[^>]*>)HONOLULU, HI<\/td>(\s*<td[^>]*>)Export Ingate/, `${HONOLULU}</td>$1${HONOLULU}</td>$2Stuffed`));
    expect(here.events![3]).toMatchObject({ time: '2026-11-10T09:01:00-10:00', location: HONOLULU, description: 'Stuffed' });
    expect(here.events![3]).not.toHaveProperty('stage');
  });

  it('dates a place it does not know by its wall clock alone', () => {
    const elsewhere = latest(container(LONG_BEACH).replace(/LONG BEACH SSAPIER A<\/td>(\s*<td[^>]*>LONG BEACH CA STREET<\/td>\s*<td[^>]*>Import Outgate)/, 'PORTLAND,OR</td>$1'));
    expect(elsewhere).toMatchObject({ last_update: null, last_update_local: '2026-11-21T01:51:00' });
    expect(elsewhere.events![0]).toEqual({ local_time: '2026-11-21T01:51:00', location: 'PORTLAND,OR', description: 'Import Outgate', stage: 'out_for_delivery', stage_source: 'carrier_map' });
  });

  it('reads a bill\'s or booking\'s cycle on its container, even once the container moved on', () => {
    const replies = { [LONG_BEACH]: container(LONG_BEACH), [OAKLAND]: container(OAKLAND) };
    expect(shipment(bill(BILL), { kind: 'bill', number: BILL }, replies)).toEqual(latest(container(LONG_BEACH)));
    expect(shipment(booking(BOOKING), { kind: 'booking', number: BOOKING }, replies)).toEqual(latest(container(LONG_BEACH)));
    expect(shipment(booking(OAKLAND_BOOKING), { kind: 'booking', number: OAKLAND_BOOKING }, replies)).toEqual(latest(container(OAKLAND), OAKLAND));
    expect(shipment(bill(OAKLAND_BILL), { kind: 'bill', number: OAKLAND_BILL }, replies)).toEqual(latest(container(OAKLAND), OAKLAND));
    const earlier = shipment(bill(EARLIER_BILL), { kind: 'bill', number: EARLIER_BILL }, replies);
    expect(earlier).toEqual(latest(keepMoves(container(LONG_BEACH), (_, index) => index >= 5)));
    expect(pashaShipment(bill(EARLIER_BILL), { kind: 'bill', number: EARLIER_BILL })).toEqual({ query: { kind: 'bill', number: EARLIER_BILL }, booking: '3810910799',
      containers: [{ number: LONG_BEACH, latest: { local_time: '2026-11-06', location: 'HNL PIER 51A', description: 'Empty Ingate', booking: null, bill: EARLIER_BILL } }] });
    // The booking's row shows the container's repositioning after the return: it is not read.
    expect(pashaShipment(booking(OAKLAND_BOOKING), { kind: 'booking', number: OAKLAND_BOOKING })!.containers).toEqual([{ number: OAKLAND, latest: null }]);
  });

  it('keeps a bill\'s row, dated by its day, where its container\'s moves no longer hold the bill', () => {
    const recent = { [LONG_BEACH]: keepMoves(container(LONG_BEACH), (_, index) => index < 5) };
    const result = shipment(bill(EARLIER_BILL), { kind: 'bill', number: EARLIER_BILL }, recent);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Empty Ingate',
      last_update: null, last_update_local: '2026-11-06', expected_delivery: null,
      events: [{ local_time: '2026-11-06', location: 'HNL PIER 51A', description: 'Empty Ingate', stage: 'delivered', stage_source: 'carrier_map' }] });
    // A container the tracker no longer holds keeps the row too; a booking has none to keep.
    expect(shipment(bill(EARLIER_BILL), { kind: 'bill', number: EARLIER_BILL }, {})).toEqual(result);
    expect(() => shipment(booking(BOOKING), { kind: 'booking', number: BOOKING }, {})).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    // A container listed on several items is asked once.
    const items = withContainer(bill(EARLIER_BILL), LONG_BEACH, LONG_BEACH);
    expect(pashaShipment(items, { kind: 'bill', number: EARLIER_BILL })!.containers).toHaveLength(1);
  });

  it('delivers a shipment once every container is back, and marks the containers past the first three as unread', () => {
    // The Oakland container's moves, as if it travelled under the same booking and bill.
    const twin = container(OAKLAND).replaceAll(OAKLAND_BOOKING, BOOKING).replaceAll(OAKLAND_BILL, BILL);
    const replies = { [LONG_BEACH]: container(LONG_BEACH), [OAKLAND]: twin };
    const both = shipment(withContainer(booking(BOOKING), LONG_BEACH, OAKLAND), { kind: 'booking', number: BOOKING }, replies);
    expect(both).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Import Outgate', last_update: '2026-11-21T01:51:00-08:00' });
    expect(both.events!.map(event => event.local_time)).toEqual([...both.events!.map(event => event.local_time!)].sort().reverse());
    expect(both.events).toHaveLength(11);
    const back = shipment(withContainer(booking(BOOKING), LONG_BEACH, OAKLAND), { kind: 'booking', number: BOOKING },
      { ...replies, [LONG_BEACH]: keepMoves(container(LONG_BEACH), (_, index) => index >= 5).replaceAll('3810910799', BOOKING) });
    expect(back).toMatchObject({ current_stage: 'delivered', last_update: '2026-11-17T08:53:00-10:00' });
    // A container without a move under the booking leaves the stage open.
    const open = shipment(withContainer(booking(BOOKING), LONG_BEACH, OAKLAND), { kind: 'booking', number: BOOKING }, { [OAKLAND]: twin });
    expect(open).toMatchObject({ status: 'unknown', last_status_text: 'Empty Ingate' });
    expect(open).not.toHaveProperty('current_stage');
    let many = bill(BILL);
    for (const number of ['PGHU1234563', 'PGHU6543210', OAKLAND]) many = withContainer(many, LONG_BEACH, number);
    const read = pashaShipment(many, { kind: 'bill', number: BILL })!;
    expect(read.containers.map(entry => entry.number)).toEqual([LONG_BEACH, OAKLAND, 'PGHU6543210', 'PGHU1234563']);
    const truncated = pashaShipmentResult(read, new Map<string, PashaMove[] | null>([[LONG_BEACH, moves(container(LONG_BEACH), LONG_BEACH)], [OAKLAND, null], ['PGHU6543210', null]]));
    expect(truncated).toMatchObject({ history_truncated: true, current_stage: 'out_for_delivery' });
    expect(truncated.events!.filter(event => event.local_time === '2026-11-21')).toHaveLength(3);
  });

  it('reads the tracker\'s answer that a number is not on file as missing, and an inquiry without moves or containers as listed', () => {
    expect(pashaContainer(fixture(`notfound-${UNKNOWN.container}.html`), UNKNOWN.container)).toBeNull();
    expect(pashaShipment(fixture(`notfound-${UNKNOWN.booking}.html`), { kind: 'booking', number: UNKNOWN.booking })).toBeNull();
    expect(pashaShipment(fixture(`notfound-${UNKNOWN.bill}.html`), { kind: 'bill', number: UNKNOWN.bill })).toBeNull();
    expect(() => latest(keepMoves(container(LONG_BEACH), () => false))).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    const empty = booking(BOOKING).replace(/<table id="ItemContainerDetails"[\s\S]*?<\/table>/, '<p>There are no containers associated with this booking</p>');
    const none = pashaShipment(empty, { kind: 'booking', number: BOOKING })!;
    expect(none.containers).toEqual([]);
    expect(() => pashaShipmentResult(none, new Map())).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('reads another search, another number or a changed table as a changed reply, never as missing', () => {
    const body = container(LONG_BEACH);
    const fails = (read: () => unknown, label: string) => expect(read, label).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const [label, changed] of [
      ['another term', body.replace(`value="${LONG_BEACH}"`, `value="${OAKLAND}"`)],
      ['another type', body.replace('<option selected="selected" value="2">', '<option value="2">').replace('<option value="0">', '<option selected="selected" value="0">')],
      ['another header', body.replace(/(Container Number\s*<\/dt>\s*<dd>\s*)PGHU4014372/, `$1${OAKLAND}`)],
      ['another inquiry', body.replace('<h4>Container Inquiry</h4>', '<h4>B/L Inquiry</h4>')],
      ['another column', body.replace('Moved From', 'From')],
      ['an invalid day', body.replace('Nov 21, 2026 01:51', 'Nov 31, 2026 01:51')],
      ['a day without its time', body.replace('Nov 21, 2026 01:51', 'Nov 21, 2026')],
      ['another date layout', body.replace('Nov 21, 2026 01:51', '2026-11-21 01:51')],
      ['a move without its wording', body.replace('>Import Outgate<', '><')],
      ['a short row', body.replace('<td>GEORGE III 111E</td>', '')],
      ['no form', body.replace(/<form[\s\S]*?<\/form>/, '')],
      ['an inquiry not on file', body.replace('<h4>Container Inquiry</h4>', `<h4>Container Inquiry</h4><h5>${LONG_BEACH} is not on file, please try again.</h5>`)],
      ['an error page', '<html><body><h1>Server Error in \'/PHLiner\' Application.</h1></body></html>'],
      ['nothing', ''],
    ] as const) fails(() => pashaContainer(changed, LONG_BEACH), label);
    fails(() => pashaContainer(fixture(`notfound-${UNKNOWN.container}.html`), LONG_BEACH), 'another number not on file');
    const query = { kind: 'bill', number: BILL } as const;
    fails(() => pashaShipment(bill(BILL).replace(/<a href="[^"]*">PGHU4014372<\/a>/, 'PGHU401437'), query), 'an invalid container');
    fails(() => pashaShipment(bill(BILL).replace(/(Booking Number\s*<\/dt>\s*<dd>\s*)2811120394/, '$1ZZZ000310'), query), 'an invalid booking');
    fails(() => pashaShipment(bill(BILL).replace('>Size/Type<', '>Size<'), query), 'another container column');
    fails(() => pashaShipment(bill(BILL).replace(/<table id="ItemContainerDetails"[\s\S]*?<\/table>/, ''), query), 'no containers');
    fails(() => pashaShipment(bill(BILL).replace('>Nov 21, 2026</td>', '>Nov 21, 2026 01:51</td>'), query), 'a bill\'s row with a time');
    fails(() => pashaShipment(booking(BOOKING), query), 'a booking for a bill');
  });

  it('reads a bot check in place of the tracker\'s page as a challenge', () => {
    for (const body of ['<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><head><title>Access Denied</title></head><body>Reference #18.1</body></html>']) {
      expect(() => pashaContainer(body, LONG_BEACH)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
      expect(() => pashaShipment(body, { kind: 'booking', number: BOOKING })).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
  });
});

type Reply = { status?: number; body: string };
type Call = { method: string; url: string; body: string | null; headers: Headers };
/** A tracker that answers each request with the next reply, recording what it was sent. */
function tracker(replies: (Reply | Error)[]) {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : null, headers: new Headers(init?.headers) });
    const reply = replies.shift();
    if (!reply) throw new Error('The test tracker has no reply left');
    if (reply instanceof Error) throw reply;
    const headers = { 'content-type': 'text/html; charset=utf-8', ...(reply.status === 302 ? { location: '/PHLiner/Tracking' } : {}) };
    return Object.defineProperty(new Response(reply.body, { status: reply.status ?? 200, headers }), 'url', { value: url });
  });
  return { fetcher, calls };
}
const searched = (calls: readonly Call[]) => calls.map(call => Object.fromEntries(new URLSearchParams(call.body ?? '')));
const carrier = (fetcher: typeof fetch, recorder?: StepRecorder) =>
  adapter({ fetcher, ...(recorder ? { recorder } : {}), env: {}, trawl: null, browserExecutablePath: null } as Parameters<typeof adapter>[0]);

describe('Pasha Hawaii adapter', () => {
  it('takes a container with its check digit, a booking of ten digits or a bill of twelve, and nothing else', async () => {
    expect([containerCheckDigit('PGHU401437'), containerCheckDigit('CRSU123456')]).toEqual([2, 6]);
    expect(pashaQuery(' pghu 401437-2 ')).toEqual({ kind: 'container', number: LONG_BEACH });
    expect(pashaQuery('28111 20394')).toEqual({ kind: 'booking', number: BOOKING });
    expect(pashaQuery(BILL)).toEqual({ kind: 'bill', number: BILL });
    expect(pashaSearchForm({ kind: 'bill', number: BILL }).toString()).toBe(`SearchType=1&SearchTerm=${BILL}`);
    const { fetcher } = tracker([]);
    for (const number of ['PGHU4014373', 'PGHU401437', '281112039', '28111203941', '5528111200123', 'PASHA', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: LONG_BEACH }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('posts the tracker\'s form for a container', async () => {
    const { fetcher, calls } = tracker([{ body: container(LONG_BEACH) }]);
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, recorder).track({ number: LONG_BEACH.toLowerCase() })).resolves.toEqual(latest(container(LONG_BEACH)));
    expect(calls.map(call => [call.method, call.url])).toEqual([['POST', PASHA_TRACKER]]);
    expect(searched(calls)).toEqual([{ SearchType: '2', SearchTerm: LONG_BEACH }]);
    expect(calls[0]!.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
  });

  it('asks a bill\'s or booking\'s first three containers after its inquiry', async () => {
    const bills = tracker([{ body: bill(EARLIER_BILL) }, { body: container(LONG_BEACH) }]);
    await expect(carrier(bills.fetcher).track({ number: EARLIER_BILL })).resolves.toMatchObject({ current_stage: 'delivered', last_update: '2026-11-06T06:02:00-10:00' });
    expect(searched(bills.calls)).toEqual([{ SearchType: '1', SearchTerm: EARLIER_BILL }, { SearchType: '2', SearchTerm: LONG_BEACH }]);
    const bookings = tracker([{ body: booking(OAKLAND_BOOKING) }, { body: container(OAKLAND) }]);
    await expect(carrier(bookings.fetcher).track({ number: OAKLAND_BOOKING })).resolves.toEqual(latest(container(OAKLAND), OAKLAND));
    expect(searched(bookings.calls)[0]).toEqual({ SearchType: '0', SearchTerm: OAKLAND_BOOKING });
    let many = bill(BILL);
    for (const number of ['PGHU1234563', 'PGHU6543210', OAKLAND]) many = withContainer(many, LONG_BEACH, number);
    const notOnFile = (number: string) => ({ body: fixture(`notfound-${UNKNOWN.container}.html`).replaceAll(UNKNOWN.container, number) });
    const capped = tracker([{ body: many }, { body: container(LONG_BEACH) }, { body: container(OAKLAND) }, notOnFile('PGHU6543210')]);
    await expect(carrier(capped.fetcher).track({ number: BILL })).resolves.toMatchObject({ history_truncated: true, current_stage: 'out_for_delivery' });
    expect(searched(capped.calls).map(form => form.SearchTerm)).toEqual([BILL, LONG_BEACH, OAKLAND, 'PGHU6543210']);
  });

  it('reads a number not on file as not found, and refusals and failures by their kind', async () => {
    for (const number of Object.values(UNKNOWN)) {
      await expect(carrier(tracker([{ body: fixture(`notfound-${number}.html`) }]).fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    await expect(carrier(tracker([{ body: challenge }]).fetcher).track({ number: LONG_BEACH })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(tracker([{ body: bill(BILL) }, { body: challenge }]).fetcher).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(tracker([{ body: '<html><body>Error</body></html>' }]).fetcher).track({ number: LONG_BEACH })).rejects.toMatchObject({ kind: 'schema' });
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance'], [500, 'indeterminate'], [404, 'transport'], [302, 'transport']] as const) {
      await expect(carrier(tracker([{ status, body: '' }]).fetcher).track({ number: LONG_BEACH }), String(status)).rejects.toMatchObject({ kind });
      await expect(carrier(tracker([{ body: bill(BILL) }, { status, body: '' }]).fetcher).track({ number: BILL }), String(status)).rejects.toMatchObject({ kind });
    }
  });

  it('asks once more when a request does not reach the tracker', async () => {
    const { fetcher } = tracker([new TypeError('fetch failed'), { body: container(LONG_BEACH) }]);
    await expect(carrier(fetcher).track({ number: LONG_BEACH })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is asked when the number is filed under Pasha Hawaii', async () => {
    const { fetcher } = tracker([{ body: container(LONG_BEACH) }]);
    await expect(createTracker({ providers: [], env: {}, fetcher }).track({ number: LONG_BEACH, carrier: 'pasha-hawaii' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'pasha-hawaii', source: 'pasha-hawaii', result: { current_stage: 'out_for_delivery' } });
    expect(carrierDefinition('pasha-hawaii').tracking).toMatchObject({ adapter: 'pasha-hawaii', localClocks: true });
  });
});

describe('Pasha Hawaii status vocabulary', () => {
  it('stages each wording the tracker gives by its usual place in the cycle, and leaves the empty container\'s repositioning unstaged on purpose', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(pashaStage(entry.wording), entry.wording).toBe(stage);
      expect(pashaSide(entry.wording), entry.wording).toBeDefined();
      expect(statusMapAnswer({ carrier: 'pasha-hawaii', providerCode: null, description: entry.wording }).kind, entry.wording).toBe(stage ? 'mapped' : 'intentional_gap');
    }
    expect(pashaStage('  import   OUTGATE ')).toBe('out_for_delivery');
    expect(statusMap.stage(null, 'stuffed')).toBeUndefined();
  });

  it('gives each fixture move a known wording', () => {
    const all = [LONG_BEACH, OAKLAND].flatMap(number => moves(container(number), number));
    expect(all.filter(entry => !pashaSide(entry.description))).toEqual([]);
    expect(new Set(all.map(entry => entry.description)).size).toBe(statuses.entries.length);
  });
});
