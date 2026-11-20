import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { containerCheckDigit, matsonQuery, parseMatsonReply } from './parser.js';
import { matsonStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples' bills of lading, the first one's booking and container; the synthetic numbers lie far beyond the ranges in use.
const BILL = 'MATS2736295000';
const BOOKING = '2736295';
const CONTAINER = 'MATU2593580';
const RETURNED = 'MATS5850828000';
const SYNTHETIC_CONTAINER = 'ZZZU9999992';
const SYNTHETIC_BOOKING = '9999999';
const TOKEN = '0123456789';
const PAGE = 'https://www.matson.com/shipment-tracking.html';
const LOOKUP = 'https://www.matson.com/wp-content/plugins/matson-plugin/Api_calls/tracking_booking_proxy.php';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Row = Record<string, unknown> & { events: Record<string, unknown>[] };
const records = (name: string): Row[] => JSON.parse(fixture(name)) as Row[];
const bill = fixture('bill-2736295');
// The tracking page's form, cut to the token the lookup sends back.
const page = (token = TOKEN) => new Response(`<html><body><form id="shipment-tracking"><input type="hidden" id="ttr" name="ttr" value="${token}" /></form></body></html>`,
  { status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const html = (body: string, status: number) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=iso-8859-1' } });
const serve = (...replies: (() => Response)[]) => vi.fn<typeof fetch>(async () => replies.shift()!());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const forbidden = '<html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>';

describe('Matson HTTP adapter', () => {
  it("reads the page's token, then posts the number with it as the page's script does, through the supplied transport", async () => {
    const fetcher = serve(page, () => json(bill));
    await expect(carrier(fetcher).track({ number: BILL })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([PAGE, LOOKUP]);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'manual' && init.signal instanceof AbortSignal)).toBe(true);
    const [, init] = fetcher.mock.calls[1]!;
    expect(init?.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ container_trackingnumber: BILL, trackingVal: 'tckbil', ttr: TOKEN });
    expect(init?.headers).toMatchObject({ 'X-Requested-With': 'XMLHttpRequest', Origin: 'https://www.matson.com', Referer: PAGE });
  });

  it('asks a booking and a container by their own kinds', async () => {
    for (const [number, kind, reply] of [[BOOKING, 'tckbok', bill], [CONTAINER, 'tckconta', fixture('container-2593580')]] as const) {
      const fetcher = serve(page, () => json(reply));
      await expect(carrier(fetcher).track({ number })).resolves.toMatchObject({ current_stage: 'in_transit' });
      expect(new URLSearchParams(String(fetcher.mock.calls[1]![1]?.body)).get('trackingVal'), number).toBe(kind);
    }
  });

  it("reads a bill's events newest first as the wall clocks the page shows, with the shipper and consignee", () => {
    const result = normalizeCarrierResult(parseMatsonReply(bill, matsonQuery(BILL)));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'OUTGATE to HIGHLINK INC', last_update: null, last_update_local: '2026-11-18T21:00:00', expected_delivery: null,
      sender_name: 'FAN CHENG INTL TRANSPORTATION SERVICES CO LTD.', receiver_name: 'EURASIA FREIGHT.' });
    expect(result.events?.map(event => [event.local_time, event.provider_code, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-11-18T21:00:00', 'OUTGATE', 'OUTGATE to HIGHLINK INC', 'SHIPPERS TRANSPORT ALAMEDA (CA)', 'in_transit'],
      ['2026-11-18T06:37:01', 'AVAILABLE', 'AVAILABLE', 'SHIPPERS TRANSPORT ALAMEDA - 2149 E Sepulveda Blvd, Carson, CA 90810', 'ready_for_pickup'],
      ['2026-11-18T06:37:00', 'HOLD RELEASED', 'HOLD RELEASED - Customs Clearance', null, 'in_transit'],
      ['2026-11-17T01:03:00', 'INGATE', 'INGATE Full by SHIPPERS TRANSPORT EXPRESS', 'SHIPPERS TRANSPORT ALAMEDA (CA)', 'in_transit'],
      ['2026-11-17T00:47:00', 'OUTGATE', 'OUTGATE to SHIPPERS TRANSPORT EXPRESS', 'LONG BEACH (CA)', 'in_transit'],
      ['2026-11-17T00:01:00', 'DISCHARGE FROM VESSEL', 'DISCHARGE FROM VESSEL MATSON WAIKIKI 029', 'LONG BEACH (CA)', 'in_transit'],
      ['2026-11-04T21:30:00', 'LOAD TO VESSEL', 'LOAD TO VESSEL MATSON WAIKIKI 029', 'SHANGHAI', 'in_transit'],
      ['2026-11-04T06:57:00', 'CONTAINER ON HOLD', 'CONTAINER ON HOLD - Customs Clearance', null, 'customs'],
      ['2026-11-03T10:33:00', 'INGATE', 'INGATE Full by SHANGHAI', 'SHANGHAI', 'in_transit'],
    ]);
    expect(result.events?.every(event => !('time' in event))).toBe(true);
  });

  it('reads the empty container back from the consignee as the delivery, and a hold without a reason as no stage', () => {
    const result = normalizeCarrierResult(parseMatsonReply(fixture('bill-5850828'), matsonQuery(RETURNED)));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'RETURNED FROM CONSIGNEE',
      last_update_local: '2026-10-13T08:50:00', sender_name: 'DHX-DEPENDABLE HAWAIIAN EXPRESS', receiver_name: 'DHX-DEPENDABLE HAWAIIAN EXPRESS' });
    expect(result.events).toHaveLength(18);
    expect(result.events?.slice(-3).map(event => [event.local_time, event.description, event.stage ?? null])).toEqual([
      ['2026-08-04T11:05:00', 'HOLD RELEASED', null],
      ['2026-07-21T14:01:00', 'CONTAINER ON HOLD', null],
      ['2026-07-21T14:00:00', 'INGATE Full by MATSON GUAM TRUCKING', 'in_transit'],
    ]);
  });

  it("reads a container's lookup, which leaves out the details and parties, for the whole number with its check digit", () => {
    const container = fixture('container-2593580');
    const result = parseMatsonReply(container, matsonQuery(CONTAINER));
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'OUTGATE', last_update_local: '2026-11-18T21:00:00' });
    expect(result).not.toHaveProperty('sender_name');
    expect(result).not.toHaveProperty('receiver_name');
    expect(result.events).toHaveLength(9);
    // Matson finds a container by its first ten characters, whatever check digit follows.
    const other = JSON.stringify({ ...JSON.parse(container), containerNumber: 'ZZZU999999', checkDigit: '2' });
    expect(() => parseMatsonReply(other, matsonQuery(CONTAINER))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseMatsonReply(other, matsonQuery(SYNTHETIC_CONTAINER)).events).toHaveLength(9);
    expect(() => parseMatsonReply(JSON.stringify({ ...JSON.parse(container), checkDigit: '7' }), matsonQuery(CONTAINER))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it("merges a booking's containers, keeping their shared moves once, and calls it delivered only once every container is", () => {
    const [first] = records('bill-5850828');
    const second = { ...first!, containerNumber: 'ZZZU999999', checkDigit: '2', events: first!.events.slice(1) };
    const both = JSON.stringify([first, second]);
    const result = parseMatsonReply(both, matsonQuery(RETURNED));
    expect(result.events).toHaveLength(18);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'RETURNED FROM CONSIGNEE' });
    const returned = { ...second, events: first!.events };
    expect(parseMatsonReply(JSON.stringify([first, returned]), matsonQuery(RETURNED))).toMatchObject({ current_stage: 'delivered' });
    const parties = { ...returned, shipperName: 'SYNTHETIC SHIPPER' };
    expect(parseMatsonReply(JSON.stringify([first, parties]), matsonQuery(RETURNED))).not.toHaveProperty('sender_name');
  });

  it('reads an empty reply, or a container record without a booking, as not found', async () => {
    for (const number of [BILL, BOOKING, CONTAINER]) {
      await expect(carrier(serve(page, () => json('[]'))).track({ number }), number).rejects.toMatchObject({ kind: 'not_found' });
    }
    const empty = JSON.stringify({ ...JSON.parse(fixture('container-2593580')), bookingNumber: null, events: [] });
    expect(() => parseMatsonReply(empty, matsonQuery(CONTAINER))).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it("keeps another booking, a changed reply, a refusal, a bot check and a rate limit apart from a missing shipment", async () => {
    const ask = (...replies: (() => Response)[]) => carrier(serve(...replies)).track({ number: BILL });
    await expect(ask(page, () => json(fixture('bill-5850828')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(serve(page, () => json(bill))).track({ number: SYNTHETIC_BOOKING })).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(page, () => json(JSON.stringify([{ ...records('bill-2736295')[0], events: [{ date: 'yesterday', status: 'INGATE' }] }])))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(page, () => json(JSON.stringify([{ ...records('bill-2736295')[0], events: [] }])))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(ask(page, () => json('{}'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(page, () => json('<html><body>Matson</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => json('<html><body><form></form></body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => html(forbidden, 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(ask(page, () => html(forbidden, 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(ask(page, () => json('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(ask(page, () => html('Too many requests', 429))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(ask(() => html('', 404))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(ask(() => html('', 503))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(page()).mockResolvedValueOnce(json(bill));
    await expect(carrier(flaky).track({ number: BILL })).resolves.toMatchObject({ status: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(3);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: BILL }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('takes a container with its check digit, a seven-digit booking or a MATS bill, and nothing else, without a request', async () => {
    expect([containerCheckDigit('MATU259358'), containerCheckDigit('MATU209531'), containerCheckDigit('CSQU305438')]).toEqual([0, 4, 3]);
    expect(matsonQuery(' matu 259358-0 ')).toEqual({ kind: 'container', number: CONTAINER, trackingVal: 'tckconta' });
    expect(matsonQuery(BILL)).toEqual({ kind: 'bill', number: BILL, booking: BOOKING, trackingVal: 'tckbil' });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['MATU2593581', 'MATU259358', '273629', '27362950', 'MATS273629500', 'MAEU2736295000', 'SAMPLETRACKING', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is asked when the number is filed under Matson', async () => {
    const fetcher = serve(page, () => json(fixture('bill-5850828')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: RETURNED, carrier: 'matson' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'matson', source: 'matson', result: { current_stage: 'delivered' } });
  });
});

describe('Matson status vocabulary', () => {
  it('stages each name whatever follows it, the holds by their reason, and leaves a hold without one open on purpose', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(matsonStage(entry.code, entry.wording), entry.wording).toBe(stage);
      const answer = statusMapAnswer({ carrier: 'matson', providerCode: entry.code, description: entry.wording });
      expect(answer.kind, entry.wording).toBe(stage ? 'mapped' : 'intentional_gap');
    }
    expect(statusMap.stage('LOAD TO VESSEL', 'load to vessel synthetic vessel 001')).toBe('in_transit');
    expect(statusMap.stage('CONTAINER ON HOLD', 'container on hold - synthetic reason')).toBeUndefined();
    expect(statusMap.stage(null, 'returned from consignee')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'matson', providerCode: 'SYNTHETIC', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
