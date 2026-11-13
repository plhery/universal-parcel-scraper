import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PENINSULA_API, peninsulaLookupUrl, PeninsulaTracker } from './adapter.js';
import { normalizePeninsulaNumber, parsePeninsula, withoutSigner } from './parser.js';
import { peninsulaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '70012345';
const IN_TRANSIT = '700123456';
const UNKNOWN = '79999999';

type Row = Record<string, unknown>;
type Reply = Row & { shipmentLog: Row[]; shipments: unknown[] };

const fixture = <T = Reply>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const shipment = (name: string, change: (body: Reply) => void = () => {}) => {
  const body = fixture(name);
  change(body);
  return body;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const answering = (body: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => body());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Cloudflare's managed challenge, as it could stand in place of a reply.
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:"managed"};</script></body></html>';
// A firewall's block page, as the carrier's website gives some countries.
const BLOCKED = '<html><head><title>Request Rejected</title></head><body><h1>You have been blocked</h1></body></html>';
const events = (result: ReturnType<typeof parsePeninsula>) => result.events!.map((event) => [event.local_time, event.description,
  event.stage ?? null, event.location ?? null]);

describe('Peninsula Truck Lines HTTP adapter', () => {
  it('asks the tracking page’s guest lookup for the whole PRO, through the supplied transport', async () => {
    const fetcher = answering(() => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PeninsulaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 7001-23456 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${PENINSULA_API}/${IN_TRANSIT}`);
    expect(peninsulaLookupUrl('7001 23456')).toBe('https://ptlprodapi.azurewebsites.net/api/track/public/700123456');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(Object.keys(init!.headers as Record<string, string>)).not.toContain('Authorization');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'peninsula-truck-lines', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivered log newest first as wall clocks at towns, dated by its status line, without the parties or the receiver', () => {
    const result = parsePeninsula(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED ON 2026-03-03', last_update: null, last_update_local: '2026-03-03',
    });
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('expected_delivery');
    expect(events(result)).toEqual([
      // The log has no delivery row: the status line dates it, by its day.
      ['2026-03-03', 'DELIVERED ON 2026-03-03', 'delivered', null],
      ['2026-03-03T07:58:00', 'DEL MFST', 'out_for_delivery', 'EXAMPLE FALLS, OR'],
      // The repeated row is kept once.
      ['2026-03-03T05:12:00', 'DOCK', 'in_transit', 'EXAMPLE FALLS, OR'],
      ['2026-03-02T18:40:00', 'DOCK', 'in_transit', 'SAMPLE CITY, WA'],
      ['2026-03-02T15:05:00', 'PICKUP', 'accepted', 'SAMPLE CITY, WA'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.time_zone === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/JANE|EXAMPLE PARTS|SAMPLE SUPPLY|00000|BOL-SAMPLE|PO-SAMPLE|Example Falls|Sample City/);
  });

  it('reads an in-transit log by its newest staged row, in either order', () => {
    const result = parsePeninsula(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'DOCK', last_update: null, last_update_local: '2026-05-06T11:47:00' });
    expect(events(result)).toEqual([
      ['2026-05-06T11:47:00', 'DOCK', 'in_transit', 'SAMPLEVILLE, WA'],
      ['2026-05-06T00:05:00', 'DOCK', 'in_transit', 'SAMPLE HARBOR, WA'],
      ['2026-05-05T12:20:00', 'PICKUP', 'accepted', 'SAMPLE HARBOR, WA'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/OUTFITTERS|SAMPLE MILLS/);
    const reversed = parsePeninsula(shipment('in-transit', (body) => body.shipmentLog.reverse()), IN_TRANSIT);
    expect(events(reversed)).toEqual(events(result));
  });

  it('settles a delivery, a return, a problem and a hand-off from the status line, and other lines only without a staged row', () => {
    const headed = (proStatus: unknown, change: (body: Reply) => void = () => {}) => parsePeninsula(shipment('in-transit', (body) => {
      body.proStatus = proStatus;
      change(body);
    }), IN_TRANSIT);
    // A partner carrier delivers: the line keeps the partner and its PRO.
    const tendered = 'TENDERED TO SAMPLE FREIGHT ON 2026-05-07 ON THEIR PRO 000111222';
    expect(headed(tendered)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: tendered, last_update_local: '2026-05-06T11:47:00' });
    expect(headed(tendered).events).toHaveLength(3);
    expect(headed('RETURNED TO SHIPPER')).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'RETURNED TO SHIPPER' });
    // A line the rows are ahead of, or one no rule knows, leaves the newest staged row in charge.
    expect(headed('IN TRANSIT')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'DOCK' });
    expect(headed('SAMPLE NOTE')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'DOCK' });
    // A delivered line without its day settles the delivery without an event of its own.
    const undated = headed('DELIVERED');
    expect(undated).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'DELIVERED',
      last_update_local: '2026-05-06T11:47:00' });
    expect(undated.events).toHaveLength(3);
    // A delivery the log records is not added again, and a delivery placed by its day falls among older rows.
    const logged = headed('DELIVERED ON 2026-05-06', (body) => body.shipmentLog.push(
      { date: '2026-05-06', time: '2:15pm', activity: 'DELIVERED SIGNED BY PAT EXAMPLE', location: 'SAMPLEVILLE, WA' }));
    expect(events(logged)[0]).toEqual(['2026-05-06T14:15:00', 'DELIVERED', 'delivered', 'SAMPLEVILLE, WA']);
    expect(logged.events).toHaveLength(4);
    expect(JSON.stringify(logged)).not.toMatch(/PAT/);
    expect(events(headed('DELIVERED ON 2026-05-05')).map(([time]) => time))
      .toEqual(['2026-05-06T11:47:00', '2026-05-06T00:05:00', '2026-05-05', '2026-05-05T12:20:00']);
  });

  it('reads a status line without a log as a summary, and nothing at all as no history', () => {
    const empty = (proStatus: string) => shipment('delivered', (body) => {
      body.proStatus = proStatus;
      body.shipmentLog = [];
    });
    expect(parsePeninsula(empty('DELIVERED TO SAMPLE RECEIVING ON 2026-03-03'), DELIVERED)).toMatchObject({ status: 'delivered',
      last_status_text: 'DELIVERED ON 2026-03-03', last_update_local: '2026-03-03', summary_only: true,
      events: [{ local_time: '2026-03-03', description: 'DELIVERED ON 2026-03-03', stage: 'delivered' }] });
    const other = parsePeninsula(empty('SAMPLE NOTE'), DELIVERED);
    expect(other).toMatchObject({ status: 'unknown', last_status_text: 'SAMPLE NOTE', summary_only: true, events: [] });
    expect(other).not.toHaveProperty('current_stage');
    expect(other).not.toHaveProperty('last_update_local');
    expect(() => parsePeninsula(empty(''), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('drops the person a delivery or a scan names', () => {
    expect(withoutSigner('DELIVERED TO JANE EXAMPLE ON 2026-03-03')).toBe('DELIVERED ON 2026-03-03');
    expect(withoutSigner('DELIVERED ON 2026-03-03 SIGNED BY J EXAMPLE')).toBe('DELIVERED ON 2026-03-03');
    expect(withoutSigner('Delivered to J. Example')).toBe('DELIVERED');
    expect(withoutSigner('DELIVERED ON 2026-02-30')).toBe('DELIVERED');
    expect(withoutSigner('POD RECEIVED BY J EXAMPLE')).toBe('POD');
    expect(withoutSigner('DOCK')).toBe('DOCK');
  });

  it('places a row at its town and state, without the parts that hold digits', () => {
    const at = (location: unknown) => parsePeninsula(shipment('in-transit', (body) => {
      body.shipmentLog[0]!.location = location;
    }), IN_TRANSIT).events!.at(-1)!.location ?? null;
    expect(at('SAMPLE HARBOR, WA 00000')).toBe('SAMPLE HARBOR, WA');
    expect(at('AUBURN')).toBe('AUBURN');
    expect(at('12 SAMPLE ST')).toBe('SAMPLE ST');
    expect(at('00000')).toBeNull();
    expect(at('')).toBeNull();
    expect(at(null)).toBeNull();
  });

  it('reads the unknown PRO’s answer as not found, and a shipment only when it is the PRO asked', () => {
    expect(() => parsePeninsula(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const proNumber of [DELIVERED, null, '', `${IN_TRANSIT}0`, `${IN_TRANSIT} / FM`]) {
      expect(() => parsePeninsula(shipment('in-transit', (body) => { body.proNumber = proNumber; }), IN_TRANSIT), String(proNumber))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Peninsula answered for another shipment' }));
    }
    expect(parsePeninsula(shipment('in-transit', (body) => { body.proNumber = Number(IN_TRANSIT); }), IN_TRANSIT).current_stage).toBe('in_transit');
    // A reference that matched several shipments names none of them as the PRO asked.
    expect(() => parsePeninsula(shipment('in-transit', (body) => {
      Object.assign(body, { proNumber: '', proStatus: '', shipmentLog: [], shipments: [{ proNumber: IN_TRANSIT }, { proNumber: DELIVERED }] });
    }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Peninsula matched several shipments' }));
    // Another error, or the unknown status with other words, is no answer either way.
    for (const change of [{ statusNbr: 30002 }, { statusMsg: 'Sample failure' }, { status: 'error  RETRIEVE_SAMPLE', statusNbr: 50000 }]) {
      expect(() => parsePeninsula({ ...fixture<Row>('not-found'), ...change }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (body: Reply) => { body.shipmentLog = null as never; },
      (body: Reply) => { delete (body as Row).shipmentLog; },
      (body: Reply) => { body.shipments = {} as never; },
      (body: Reply) => { body.proStatus = 7; },
      (body: Reply) => { body.proNumber = { value: IN_TRANSIT }; },
      (body: Reply) => { body.shipmentLog[0] = 'row' as never; },
      (body: Reply) => { body.shipmentLog[0]!.date = null; },
      (body: Reply) => { body.shipmentLog[0]!.date = '05/05/2026'; },
      (body: Reply) => { body.shipmentLog[0]!.date = '2026-02-30'; },
      (body: Reply) => { body.shipmentLog[0]!.date = '2026-05-05T12:20:00Z'; },
      (body: Reply) => { body.shipmentLog[0]!.time = '13:20'; },
      (body: Reply) => { body.shipmentLog[0]!.time = '13:20pm'; },
      (body: Reply) => { body.shipmentLog[0]!.time = '0:20am'; },
      (body: Reply) => { body.shipmentLog[0]!.activity = ''; },
      (body: Reply) => { body.shipmentLog[0]!.activity = ['PICKUP']; },
      (body: Reply) => { body.shipmentLog[0]!.location = { city: 'SAMPLE' }; },
      (body: Reply) => { body.shipmentLog.push(...Array.from({ length: 500 }, () => body.shipmentLog[0]!)); },
    ]) {
      expect(() => parsePeninsula(shipment('in-transit', change), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const body of [null, [], 'ok', {}, { status: 7 }, { status: 'pending' }, { statusNbr: 30001 }]) {
      expect(() => parsePeninsula(body, IN_TRANSIT), JSON.stringify(body)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a row’s day without a time, and the same day written as its midnight', () => {
    const result = parsePeninsula(shipment('in-transit', (body) => {
      body.shipmentLog[0]!.time = '';
      body.shipmentLog[1]!.date = '2026-05-06T00:00:00.000Z';
      body.shipmentLog[2]!.time = '12:30AM';
    }), IN_TRANSIT);
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-05-06T00:30:00', '2026-05-06T00:05:00', '2026-05-05']);
  });

  it('keeps an unknown PRO, a moved route, a browser check, a block page and a broken reply apart', async () => {
    const lookup = (body: () => Response) => carrier(answering(body)).track({ number: UNKNOWN });
    await expect(lookup(() => reply(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    const html = { headers: { 'Content-Type': 'text/html' } };
    await expect(lookup(() => reply('<!DOCTYPE html><title>Error</title><pre>Cannot GET /api/track/public</pre>', { status: 404, ...html })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(fixture('not-found'), { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 302, headers: { Location: 'https://www.peninsulatruck.com/login' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(BLOCKED, { status: 404, ...html }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(BLOCKED, html))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, { status: 403, ...html }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, html))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('<html><title>Peninsula Truck Lines</title></html>', html))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply('{"status":"ok"'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply(''))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = answering(() => reply({ error: 'Sample failure' }, { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers that are not a PRO and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1234567', '1234567890123', 'ABCDEFGH', '7001234X', 'PRO70012345', `70012345${'9'.repeat(60)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const [raw, number] of [['00123456', '00123456'], ['7001 2345', DELIVERED], ['7001-23456', IN_TRANSIT], ['700123456789', '700123456789']]) {
      expect(normalizePeninsulaNumber(raw!), raw).toBe(number);
    }
  });

  it('tries a read that hangs once more, and ends inside the budget', async () => {
    fakeBudgetClock();
    const recovered = delayedFetcher([{ afterMs: Infinity }, { afterMs: 50, reply: () => reply(fixture('in-transit')) }]);
    const answered = carrier(recovered.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 400 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(answered).resolves.toMatchObject({ current_stage: 'in_transit' });
    // Half of the budget, then the retry within the rest.
    expect(recovered.ended).toEqual([200, 250]);
    const started = performance.now();
    const hanging = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(hanging.fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(hanging.fetcher).toHaveBeenCalledTimes(2);
    expect(hanging.ended.map((at) => at - started)).toEqual([60, 120]);
  });

  it('routes a PRO the caller names Peninsula’s to the adapter', async () => {
    const fetcher = answering(() => reply(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'peninsula-truck-lines' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'peninsula-truck-lines', source: 'peninsula-truck-lines', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === peninsulaLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Peninsula Truck Lines numbers', () => {
  it('leaves PROs to the caller’s choice, and reads tracking page links', () => {
    // A PRO is a bare run of digits many carriers issue, so neither detection nor recognition offers Peninsula.
    for (const number of [DELIVERED, IN_TRANSIT, '7001234567']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('peninsula-truck-lines');
      expect(recognitionAskedCarriers(number), number).not.toContain('peninsula-truck-lines');
    }
    for (const link of [`https://www.peninsulatruck.com/track/?pro_number=${DELIVERED}`, `https://peninsulatruck.com/track?pro_number=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'peninsula-truck-lines', source: 'link' });
    }
  });
});

describe('Peninsula Truck Lines status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(peninsulaStage(entry.wording), entry.wording).toEqual(entry.stage ? { stage: entry.stage, source: 'carrier_map' } : null);
    }
    expect(statusMap.gaps).toEqual([]);
    expect(statusMap.stage('X', 'dock')).toBeUndefined();
    expect(statusMap.stage(null, 'delivered on 2026-03-03')).toBe('delivered');
    // Wording the map does not know falls to the shared rules, else stays without a stage.
    expect(peninsulaStage('OUT FOR DELIVERY')).toMatchObject({ stage: 'out_for_delivery' });
    expect(peninsulaStage('SAMPLE NOTE')).toBeNull();
  });
});
