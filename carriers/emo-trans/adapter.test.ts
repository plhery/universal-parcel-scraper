import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, EMO_TRANS_QUICK_TRACK, emoTransSearchBody } from './adapter.js';
import { emoTransSearchRow, normalizeEmoTransNumber, parseEmoTransShipment, type EmoTransRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample by its S-number and by its house bill; the tests derive invented shipments from its replies.
const SAMPLE = 'S2601A00324070', HOUSE_BILL = 'DUS15034325', GID = 27147297;
const OTHER = 'S2601A99999990';

const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SEARCH = JSON.parse(read(`search-${SAMPLE}.json`)) as { data: Record<string, unknown>[] };
const PAGE = read(`shipment-${SAMPLE}.html`);
const SAMPLE_ROW: EmoTransRow = { gid: GID, shipmentNumber: `15112600391 / ${SAMPLE}`, houseBill: HOUSE_BILL, mode: 'AIR' };
const searchOf = (...rows: Record<string, unknown>[]) => ({ draw: '1', recordsFiltered: rows.length, recordsTotal: rows.length, data: rows });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A portal answering the search with `search` and every shipment page with `page`. */
const portal = (search: () => Response, page: () => Response = () => html(PAGE)) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url) === EMO_TRANS_QUICK_TRACK ? search() : page()));
/** The sample's events table with its rows replaced. */
const withEvents = (...rows: string[]) => PAGE.replace(/(Location<\/td>\s*<\/tr>\s*<\/thead>\s*<tbody>).*?(<\/tbody>)/s, `$1${rows.join('')}$2`);
const event = (description: string, day: string, time?: string, location = '') =>
  `<tr><td>${description}</td><td>${day}${time ? `<span class="time">${time}</span>` : ''}</td><td>${location}</td></tr>`;
const withLastStatus = (status: string) => PAGE.replace(/(<td>Last Status<\/td>\s*<td>)\s*Delivered/, `$1${status}`);

describe('EMO Trans numbers', () => {
  it('takes a shipment number or a house bill in letters and digits', () => {
    expect(normalizeEmoTransNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeEmoTransNumber('DUS 1503 4325')).toBe(HOUSE_BILL);
    for (const other of ['', 'S2601', 'SHIPMENT', 'S2601A0032407!', `S${'1'.repeat(30)}`]) {
      expect(() => normalizeEmoTransNumber(other), other).toThrow('EMO Trans shipment or house bill number');
    }
  });
});

describe('EMO Trans tracking adapter', () => {
  it('searches as the quick track’s table does, then reads the shipment’s page', async () => {
    const fetcher = portal(() => json(SEARCH));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[searchUrl, search], [pageUrl, page]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(searchUrl).toBe('https://portal.emotrans-global.com/track/quicktrack');
    expect(search).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'X-Requested-With': 'XMLHttpRequest', Cookie: 'trackLocale=en' }) });
    const body = new URLSearchParams(String(search.body));
    expect(body.get('shipmentIdentifier')).toBe(SAMPLE);
    expect([0, 1, 2, 3].map((index) => body.get(`columns[${index}][name]`))).toEqual(['mode', 'shipmentNo', 'houseBillNumber', 'masterBillNumber']);
    expect([...body.keys()]).toHaveLength(32);
    expect(Object.fromEntries([...body].filter(([key]) => /^(?:draw|start|length|order|search)/.test(key)))).toEqual({
      draw: '1', start: '0', length: '10', 'order[0][column]': '2', 'order[0][dir]': 'desc', 'search[value]': '', 'search[regex]': 'false',
    });
    expect(String(emoTransSearchBody(SAMPLE))).toBe(String(search.body));
    expect(pageUrl).toBe(`https://portal.emotrans-global.com/track/quicktrack/shipment/${GID}?search=${SAMPLE}`);
    expect(page).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'emo-trans', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('opens the shipment by its house bill too', async () => {
    const fetcher = portal(() => json(SEARCH));
    await expect(carrier(fetcher).track({ number: HOUSE_BILL })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`https://portal.emotrans-global.com/track/quicktrack/shipment/${GID}?search=${HOUSE_BILL}`);
  });

  it('reads an empty search as not found, without opening a page', async () => {
    const fetcher = portal(() => json(JSON.parse(read('not-found.json'))));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps refusals, error pages and redirects apart from a missing shipment', async () => {
    const answer = async (search: () => Response, page?: () => Response) => carrier(portal(search, page))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    // The portal answers a search it cannot read with its error page and HTTP 500.
    const errorPage = '<title>Error - Emo Trans: Track &amp; Trace</title><div class="errorMessage">An unknown error has occurred.</div>';
    expect(await answer(() => html(errorPage, { status: 500 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html(errorPage))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/track/login' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('<html></html>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json(SEARCH), () => html('<html></html>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json(SEARCH), () => html(errorPage))).toMatchObject({ kind: 'schema' });
    const challenge = '<html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>';
    expect(await answer(() => json(SEARCH), () => html(challenge))).toMatchObject({ kind: 'challenge' });
  });
});

describe('EMO Trans replies', () => {
  it('reads the public sample: its events on their station’s wall clock, its last status and where it went', () => {
    const result = parseEmoTransShipment(PAGE, SAMPLE_ROW);
    const timed = (local_time: string, description: string, stage: string | null, location?: string) => ({ local_time, description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-02-02T09:41:43', expected_delivery: null, destination_country: 'US',
      events: [
        timed('2026-02-02T09:41:43', 'Customs Cleared', 'in_transit'),
        timed('2026-02-02T09:41:06', 'Customs Commenced', 'customs'),
        timed('2026-02-01T20:34:00', 'Arrival', 'in_transit', 'Boston'),
        timed('2026-02-01T19:54:00', 'Arrival', 'in_transit', 'Boston'),
        timed('2026-02-01T18:03:00', 'Departure', 'in_transit', 'Zurich'),
        timed('2026-01-31T10:49:00', 'Arrival', 'in_transit', 'Zurich'),
        timed('2026-01-31T09:46:00', 'Departure', 'in_transit', 'Düsseldorf'),
        timed('2026-01-31T09:45:00', 'Freight Loaded', 'in_transit', 'Düsseldorf'),
        timed('2026-01-30T17:10:00', 'Delivery Cartage Advised', null),
        timed('2026-01-30T13:50:00', 'Booking Confirmed', 'registered', 'Zurich'),
      ],
    });
  });

  it('takes the shipment the search names by its own numbers, and no shipment that only shares a reference', () => {
    expect(emoTransSearchRow(SEARCH, SAMPLE)).toEqual(SAMPLE_ROW);
    expect(emoTransSearchRow(SEARCH, '15112600391')).toEqual(SAMPLE_ROW);
    expect(emoTransSearchRow(SEARCH, HOUSE_BILL)).toEqual(SAMPLE_ROW);
    expect(emoTransSearchRow(JSON.parse(read('not-found.json')), OTHER)).toBeNull();
    // A master bill finds its consolidation and each house in it; none goes by the master bill alone.
    const master = { ...SEARCH.data[0], shipmentGid: 27145830, shipmentNumber: '15112600391M', houseBillNumber: null };
    expect(() => emoTransSearchRow(searchOf(master, SEARCH.data[0]!), '72479128976')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => emoTransSearchRow(SEARCH, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const again = { ...SEARCH.data[0], shipmentGid: GID + 1, shipmentNumber: '15112600392 / S2601A00324071' };
    expect(() => emoTransSearchRow(searchOf(SEARCH.data[0]!, again), HOUSE_BILL)).toThrow('several shipments');
    expect(emoTransSearchRow(searchOf(SEARCH.data[0]!, again), SAMPLE)).toEqual(SAMPLE_ROW);
  });

  it('refuses the page of another shipment', () => {
    expect(() => parseEmoTransShipment(PAGE, { ...SAMPLE_ROW, shipmentNumber: `15112600392 / ${OTHER}` }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEmoTransShipment(PAGE, { ...SAMPLE_ROW, houseBill: 'DUS15034326' })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('follows the newest event when the last status is unknown, and gives the door estimate until delivery', () => {
    const moving = withLastStatus('In Transit').replace(/(<td>Door ETA<\/td>\s*<td>)02-FEB-2026/, '$105-FEB-2026');
    expect(parseEmoTransShipment(moving, SAMPLE_ROW)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'In Transit', expected_delivery: '2026-02-05' });
    const booked = withEvents(event('Delivery Cartage Advised', '30-JAN-2026', '05:10:00 PM'), event('Booking Confirmed', '30-JAN-2026', '01:50:00 PM', 'Zurich'));
    expect(parseEmoTransShipment(booked.replace(/(<td>Last Status<\/td>\s*<td>)\s*Delivered/, '$1'), SAMPLE_ROW))
      .toMatchObject({ current_stage: 'registered', last_status_text: 'Delivery Cartage Advised', last_update_local: '2026-01-30T17:10:00' });
  });

  it('keeps a day without a clock and passes over a milestone not yet dated', () => {
    const page = withEvents(event('Arrival', 'N/A', undefined, 'Boston'), event('Departure', '01-FEB-2026', undefined, 'Zurich'),
      event('Freight Loaded', '31-JAN-2026', '12:05 AM', 'Düsseldorf'));
    expect(parseEmoTransShipment(page, SAMPLE_ROW).events).toEqual([
      { local_time: '2026-02-01', description: 'Departure', location: 'Zurich', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-31T00:05:00', description: 'Freight Loaded', location: 'Düsseldorf', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
  });

  it('refuses a changed reply', () => {
    for (const payload of [null, {}, { data: {} }, { data: [], recordsTotal: 0 }, searchOf({ shipmentGid: '1', shipmentNumber: SAMPLE }),
      searchOf({ shipmentGid: GID }), searchOf({ ...SEARCH.data[0], houseBillNumber: 7 }), { ...searchOf(), recordsFiltered: 3 }]) {
      expect(() => emoTransSearchRow(payload, SAMPLE), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const page of ['<html></html>', PAGE.replace('Event Description', 'Description'), PAGE.replace('Shipment Summary', 'Summary'),
      withEvents(event('Arrival', '2026-02-01', '08:34:00 PM', 'Boston')), withEvents(event('Arrival', '31-FEB-2026', '08:34:00 PM')),
      withEvents(event('Arrival', '01-FEB-2026', '20:34', 'Boston')), withEvents(event('', '01-FEB-2026', '08:34:00 PM')),
      withEvents('<tr><td>Arrival</td><td>01-FEB-2026</td></tr>'), withEvents().replace(/(<td>Last Status<\/td>\s*<td>)\s*Delivered/, '$1')]) {
      expect(() => parseEmoTransShipment(page, SAMPLE_ROW), page.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('EMO Trans statuses', () => {
  it('maps each milestone it has seen, and leaves the cartage notice to the event before', () => {
    for (const entry of statuses.entries) {
      const answer = statusMapAnswer({ carrier: 'emo-trans', providerCode: null, description: entry.wording });
      expect(answer, entry.wording).toMatchObject(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap' });
    }
    expect(statusMap.stage(null, 'shipment lost')).toBeUndefined();
    expect(statusMap.stage('X', 'arrival')).toBeUndefined();
  });
});
