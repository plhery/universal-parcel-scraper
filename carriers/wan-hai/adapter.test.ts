import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, WAN_HAI_HEADERS } from './adapter.js';
import { containerCheckDigit, MAX_DETAILS, wanHaiContainerRef, wanHaiJson, wanHaiMoves, wanHaiQuery, wanHaiResult, wanHaiShipment, wanHaiUrl } from './parser.js';
import { statusMap, wanHaiStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples and their containers. Other numbers are synthetic.
const OAKLAND = '025G831033';
const OAKLAND_CONTAINER = 'TIIU5581540';
const NORFOLK = '035GX71907';
const NORFOLK_CONTAINER = 'WHSU2069337';
const ISTANBUL = '029G513767';
const ISTANBUL_CONTAINERS = ['WHSU8464489', 'WHSU8766278', 'WHSU8766529'];

type Row = Record<string, unknown>;
type Reply = { status: string; result: Row & { title: string; basic_list: Row[]; container_list: Row[]; movement_list: Row[]; information_list: Row[]; ref_no: string | null } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const edited = (name: string, edit?: (reply: Reply) => void) => {
  const reply = fixture(name);
  edit?.(reply);
  return reply;
};
/** A bill's result from its B/L screen and its containers' moves, each optionally edited. */
const read = (bill: string, containers: Record<string, ((reply: Reply) => void) | undefined>, edit?: (reply: Reply) => void) => {
  const shipment = wanHaiShipment(edited(`bl-${bill}`, edit), bill);
  const details = new Map(Object.entries(containers).map(([number, change]) =>
    [number, wanHaiMoves(edited(`movement-${bill}-${number}`, change), number, shipment?.zones ?? new Map())]));
  const result = wanHaiResult(shipment, details);
  return { ...result, events: result.events ?? [] };
};
const rows = (result: { events: { time?: string; local_time?: string; description?: string; location?: string; stage?: string }[] }) =>
  result.events.map(event => [event.time ?? null, event.local_time, event.description, event.location ?? null, event.stage ?? null]);
const moves = (reply: Reply) => reply.result.movement_list;
// Wan Hai's answers for a number it does not hold, from the shapes its screens give.
const empty = (title: string, extra: Row = {}) => ({ status: '0000', message: '操作成功', result: { title, basic_list: [], container_list: [], ...extra } });
const noContainer = (title: string) => ({ status: '0000', message: '操作成功', result: { title, ref_no: null, information_list: [] } });

const OICT = 'Oakland International Container Terminal; Oict (Berth 57-59) ; Ssa Marine';
const LAEM_CHABANG = 'Thai Laemchabang Terminal Co., Ltd. (A2)';

describe('Wan Hai replies', () => {
  it('reads a container\'s moves newest first, at the zone of the route town its facility names', () => {
    const result = read(OAKLAND, { [OAKLAND_CONTAINER]: undefined });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty Container Discharged From Vessel Or Gate In To Pier/Terminal/Off-Dock Depot (Empty Available)',
      last_update: '2026-11-17T16:55:00-08:00', expected_delivery: null });
    expect(result).not.toHaveProperty('history_truncated');
    expect(rows(result)).toEqual([
      ['2026-11-17T16:55:00-08:00', '2026-11-17T16:55:00', 'Empty Container Discharged From Vessel Or Gate In To Pier/Terminal/Off-Dock Depot (Empty Available)', OICT, 'delivered'],
      ['2026-11-16T08:34:00-08:00', '2026-11-16T08:34:00', 'Full Container Withdrawn By Consignee From Pier/Terminal', OICT, 'out_for_delivery'],
      ['2026-11-11T14:08:00-08:00', '2026-11-11T14:08:00', 'Full Container(Fcl) Discharged From Vessel Or Gate In To Pier/Terminal', OICT, 'in_transit'],
      [null, '2026-10-17T01:07:00', 'Laden Ctnr Loaded On Board Vessel.(Mother Vessel,Fixed Slot Charter/Joint Venture Vessel)', 'Sku01', 'in_transit'],
      [null, '2026-10-11T03:13:00', 'Outbound Full Container Gate In To Peir/Terminal(Fcl)', 'Sku01', 'accepted'],
      [null, '2026-10-09T21:23:00', 'Empty Container Released To Shipper From Pier/Terminal/Off-Dock Depot', 'Shenzhen Since-Star Container Co. Ltd', 'registered'],
    ]);
    expect(result.events[0]).toEqual({ time: '2026-11-17T16:55:00-08:00', local_time: '2026-11-17T16:55:00', time_zone: 'America/Los_Angeles',
      time_zone_basis: 'place', location: OICT, description: result.last_status_text, stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads a container at sea, transshipped at a route town', () => {
    const result = read(NORFOLK, { [NORFOLK_CONTAINER]: undefined });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-10-30T10:48:00+08:00' });
    expect(rows(result).slice(1, 4)).toEqual([
      ['2026-10-28T13:22:00+08:00', '2026-10-28T13:22:00', 'Laden Or Empty Transit Container Discharged From Own Or Feeder Vessel At Pier/Terminal Awaiting For', 'Taipei Port', 'in_transit'],
      [null, '2026-10-17T12:21:00', 'Laden Ctnr Loaded On Board Vessel.(Mother Vessel,Fixed Slot Charter/Joint Venture Vessel)', LAEM_CHABANG, 'in_transit'],
      [null, '2026-10-14T01:03:00', 'Outbound Full Container Gate In To Peir/Terminal(Fcl)', LAEM_CHABANG, 'accepted'],
    ]);
  });

  it('reads a gate in after the container moved as transit, and an empty container returned unused as no delivery', () => {
    const moved = read(NORFOLK, { [NORFOLK_CONTAINER]: reply => {
      moves(reply).unshift({ ...moves(reply)[3]!, ctnr_date: '2026/10/31 08:00' });
    } });
    expect(moved.events[0]).toMatchObject({ description: 'Outbound Full Container Gate In To Peir/Terminal(Fcl)', stage: 'in_transit' });
    const unused = read(NORFOLK, { [NORFOLK_CONTAINER]: reply => {
      reply.result.movement_list = [{ ...edited(`movement-${OAKLAND}-${OAKLAND_CONTAINER}`).result.movement_list[0]!, ctnr_date: '2026/10/13 09:00' }, moves(reply).at(-1)!];
    } });
    expect(unused).toMatchObject({ status: 'pending', current_stage: 'registered' });
    expect(unused.events[0]).not.toHaveProperty('stage');
  });

  it('keeps the latest status of containers whose moves were not asked, and delivers a bill once every container is back', () => {
    const result = read(ISTANBUL, Object.fromEntries(ISTANBUL_CONTAINERS.map(number => [number, undefined])));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', history_truncated: true, last_update: null, last_update_local: '2026-07-21T23:14:00' });
    expect(result.events).toHaveLength(23);
    expect(result.events.filter(event => !event.location)).toEqual([expect.objectContaining({ local_time: '2026-07-21T22:27:00', stage: 'delivered' })]);
    expect(result.events.find(event => event.location?.startsWith('Shenghu'))).toMatchObject({ time_zone: 'Asia/Shanghai' });
    const waiting = read(ISTANBUL, { [ISTANBUL_CONTAINERS[0]!]: undefined }, reply => {
      reply.result.container_list[3]!.current_status = 'Full Container Withdrawn By Consignee From Pier/Terminal';
    });
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', history_truncated: true });
    const unseen = read(ISTANBUL, { [ISTANBUL_CONTAINERS[0]!]: undefined }, reply => {
      for (const row of reply.result.container_list.slice(1)) row.current_status = '';
    });
    expect(unseen).toMatchObject({ status: 'unknown' });
    expect(unseen).not.toHaveProperty('current_stage');
    expect(unseen).not.toHaveProperty('history_truncated');
  });

  it('reads a booking\'s containers before its bill is issued, and a booking without containers as listed', () => {
    const booking = wanHaiShipment(fixture(`booking-${NORFOLK}`), NORFOLK)!;
    expect(booking.containers).toEqual([{ number: NORFOLK_CONTAINER, latest: null }]);
    expect(booking.zones.get('taipei')).toBe('Asia/Taipei');
    expect(() => wanHaiShipment(edited(`booking-${NORFOLK}`, reply => { reply.result.container_list = []; }), NORFOLK))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => wanHaiResult({ refNo: NORFOLK, zones: new Map(), containers: [{ number: NORFOLK_CONTAINER, latest: null }] }, new Map([[NORFOLK_CONTAINER, []]])))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('reads a container\'s screen for the booking of its latest cycle', () => {
    expect(wanHaiContainerRef(fixture(`container-${OAKLAND_CONTAINER}`), OAKLAND_CONTAINER)).toBe(OAKLAND);
    expect(wanHaiContainerRef(noContainer('ZZZU9999992'), 'ZZZU9999992')).toBeNull();
    expect(() => wanHaiContainerRef(edited(`container-${OAKLAND_CONTAINER}`, reply => { reply.result.ref_no = null; }), OAKLAND_CONTAINER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => wanHaiContainerRef(edited(`container-${OAKLAND_CONTAINER}`, reply => { reply.result.ref_no = '<b>'; }), OAKLAND_CONTAINER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads no containers as missing, and a reply for another number or a refusal as changed', () => {
    expect(wanHaiShipment(empty('999Z999990'), '999Z999990')).toBeNull();
    expect(() => wanHaiResult(null)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const fails = (reply: unknown, number = OAKLAND) => expect(() => wanHaiShipment(reply, number)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(fixture(`bl-${OAKLAND}`), NORFOLK);
    fails(edited(`bl-${OAKLAND}`, reply => { reply.status = '0001'; }));
    fails({ status: '0000' });
    fails([]);
    fails(edited(`bl-${OAKLAND}`, reply => { reply.result.container_list[0]!.ctnr_no = 'TIIU558154'; }));
    fails(edited(`bl-${OAKLAND}`, reply => { reply.result.container_list.push(reply.result.container_list[0]!); }));
    fails(edited(`bl-${OAKLAND}`, reply => { reply.result.container_list[0]!.status_date = '2026/11/31 16:55'; }));
    fails(edited(`bl-${OAKLAND}`, reply => { reply.result.container_list = {} as never; }));
    const detail = (edit: (reply: Reply) => void, number = OAKLAND_CONTAINER) =>
      expect(() => wanHaiMoves(edited(`movement-${OAKLAND}-${OAKLAND_CONTAINER}`, edit), number, new Map())).toThrowError(expect.objectContaining({ kind: 'schema' }));
    detail(() => {}, NORFOLK_CONTAINER);
    detail(reply => { moves(reply)[0]!.ctnr_date = '2026-11-17 16:55'; });
    detail(reply => { moves(reply)[0]!.ctnr_date = '1999/11/17 16:55'; });
    detail(reply => { moves(reply)[0]!.status_name = ' '; });
    detail(reply => { moves(reply)[0]!.depot_name = 7; });
  });

  it('reads Imperva\'s page as a challenge, and other pages as a changed reply', () => {
    expect(() => wanHaiJson('<html><head><script src="/_Incapsula_Resource?SWJIYLWA=0"></script></head></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const body of ['', '<html><body>Maintenance</body></html>', '{"status":"0000"']) {
      expect(() => wanHaiJson(body), body).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(wanHaiJson('\uFEFF{"status":"0000"}')).toEqual({ status: '0000' });
  });
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const carrier = (fetcher: typeof fetch, recorder?: StepRecorder) =>
  adapter({ fetcher, ...(recorder ? { recorder } : {}), env: {}, trawl: null, browserExecutablePath: null } as Parameters<typeof adapter>[0]);
/** Answers the app's screens from the fixtures, or as Wan Hai answers a number it does not hold. */
const site = (replies: Record<string, unknown> = {}) => vi.fn<typeof fetch>(async input => {
  const url = new URL(String(input));
  const screen = url.pathname.split('/').at(-1)!;
  const ref = url.searchParams.get('ref_no') ?? '';
  const container = url.searchParams.get('ctnr_no') ?? '';
  const name = { 'bl-detail': `bl-${ref}`, 'booking-detail': `booking-${ref}`, 'ctnr-no': `container-${container}`, movement: `movement-${ref}-${container}` }[screen]!;
  if (replies[name]) return json(replies[name]);
  try {
    return json(fixture(name));
  } catch {
    return json(screen === 'ctnr-no' ? noContainer(container) : empty(ref));
  }
});

describe('Wan Hai adapter', () => {
  it('takes a booking or bill with or without WHLC, or a container with its check digit, and nothing else', async () => {
    expect([containerCheckDigit('TIIU558154'), containerCheckDigit('ZZZU999999')]).toEqual([0, 2]);
    expect(wanHaiQuery(' whlc 025g 831033 ')).toEqual({ kind: 'bill', number: OAKLAND });
    expect(wanHaiQuery(NORFOLK)).toEqual({ kind: 'bill', number: NORFOLK });
    expect(wanHaiQuery('tiiu 558154-0')).toEqual({ kind: 'container', number: OAKLAND_CONTAINER });
    expect(wanHaiUrl('movement', { ref_no: OAKLAND, ctnr_no: OAKLAND_CONTAINER }))
      .toBe(`https://whlapiv2.wanhai.com/shipping/rest/eshipping/skd/cargo-tracking/movement?ref_no=${OAKLAND}&ctnr_no=${OAKLAND_CONTAINER}`);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TIIU5581541', 'WHLC25G831033', 'YMLU025G831033', 'G025831033', '025G8310330', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: OAKLAND }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks for the bill and its container\'s moves as the app does, with the app\'s headers', async () => {
    const fetcher = site();
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, recorder).track({ number: `WHLC${OAKLAND}` })).resolves.toMatchObject({ current_stage: 'delivered', events: expect.any(Array) });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      wanHaiUrl('bl-detail', { ref_no: OAKLAND }), wanHaiUrl('movement', { ref_no: OAKLAND, ctnr_no: OAKLAND_CONTAINER }),
    ]);
    const headers = new Headers(fetcher.mock.calls[0]![1]!.headers);
    expect(Object.fromEntries(Object.keys(WAN_HAI_HEADERS).map(name => [name, headers.get(name)]))).toEqual(WAN_HAI_HEADERS);
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
  });

  it('asks for the booking when no bill is issued, and the moves of a bill\'s first containers only', async () => {
    const booking = site({ [`bl-${NORFOLK}`]: empty(NORFOLK) });
    await expect(carrier(booking).track({ number: NORFOLK })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(booking.mock.calls.map(([url]) => new URL(String(url)).pathname.split('/').at(-1))).toEqual(['bl-detail', 'booking-detail', 'movement']);
    const many = site();
    await expect(carrier(many).track({ number: ISTANBUL })).resolves.toMatchObject({ current_stage: 'delivered', history_truncated: true });
    expect(many).toHaveBeenCalledTimes(1 + MAX_DETAILS);
  });

  it('asks for a container\'s booking, then its moves under it', async () => {
    const fetcher = site();
    await expect(carrier(fetcher).track({ number: NORFOLK_CONTAINER })).resolves.toMatchObject({ current_stage: 'in_transit', last_update: null });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      wanHaiUrl('ctnr-no', { ctnr_no: NORFOLK_CONTAINER }), wanHaiUrl('movement', { ref_no: NORFOLK, ctnr_no: NORFOLK_CONTAINER }),
    ]);
  });

  it('reads a number Wan Hai does not hold as not found, and refusals by their kind', async () => {
    await expect(carrier(site()).track({ number: '999Z999990' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site()).track({ number: 'ZZZU9999992' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(async () => new Response('<html><script src="/_Incapsula_Resource?x=1"></script></html>')).track({ number: OAKLAND }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => new Response('', { status: 429 })).track({ number: OAKLAND })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('asks once more when a request does not reach Wan Hai', async () => {
    const fixtures = site();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(fixtures);
    await expect(carrier(fetcher).track({ number: OAKLAND_CONTAINER })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('is asked when the number is filed under Wan Hai', async () => {
    await expect(createTracker({ providers: [], env: {}, fetcher: site() }).track({ number: NORFOLK, carrier: 'wan-hai' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'wan-hai', source: 'wan-hai', result: { current_stage: 'in_transit' } });
    expect(carrierDefinition('wan-hai').tracking).toMatchObject({ adapter: 'wan-hai', localClocks: true });
  });
});

describe('Wan Hai status vocabulary', () => {
  it('stages each wording the replies give, by the container\'s load and move', () => {
    for (const entry of statuses.entries) {
      expect(wanHaiStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'wan-hai', providerCode: null, description: entry.wording }).kind, entry.wording).toBe('mapped');
    }
    expect(wanHaiStage('Laden Or Empty Transit Container Discharged From Own Or Feeder Vessel At Pier/Terminal Awaiting  For')).toBe('in_transit');
    expect(wanHaiStage('Empty Container Loaded On Board Vessel')).toBeUndefined();
    expect(statusMap.stage(null, 'Container Stuffed')).toBeUndefined();
  });
});
