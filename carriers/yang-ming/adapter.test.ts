import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, YANG_MING_USER_AGENT } from './adapter.js';
import { containerCheckDigit, MAX_DETAILS, yangMingDetail, yangMingJson, yangMingLookup, yangMingLookupUrl, yangMingQuery, yangMingResult } from './parser.js';
import { statusMap, yangMingStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples: two bills and the first bill's container. Other numbers are synthetic.
const BILL = 'W501000129';
const CONTAINER = 'YMMU7065510';
const SAVANNAH_BILL = 'E232257945';
const SAVANNAH_CONTAINER = 'BMOU6146904';

type Row = Record<string, unknown>;
type Item = Row & { queryTrackNo: string; dcsaStatusInfo: Row[]; dcsaContainerInfo: Row[]; basicInfo: Row };
type Reply = Row & { blList: Item[]; containerList: Item[]; bookingList: Row[]; emptyList: Row[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const edited = (name: string, edit?: (reply: Reply) => void) => {
  const reply = fixture(name);
  edit?.(reply);
  return reply;
};
/** A bill's result from its fixture and its containers' details, each optionally edited. */
const read = (bill: string, containers: Record<string, ((reply: Reply) => void) | undefined>, edit?: (reply: Reply) => void) => {
  const lookup = yangMingLookup(edited(`tracking-${bill}`, edit), yangMingQuery(bill));
  if (lookup.kind !== 'bill') throw new Error('not a bill');
  const details = new Map(Object.entries(containers).map(([number, change]) =>
    [number, yangMingDetail(edited(`detail-${number}`, change), number, lookup.zones)]));
  const result = yangMingResult(lookup, details);
  return { ...result, events: result.events ?? [] };
};
const rows = (result: { events: { time?: string; local_time?: string; time_zone?: string; description?: string; location?: string; stage?: string }[] }) =>
  result.events.map(event => [event.time ?? null, event.local_time, event.description, event.location, event.stage ?? null]);
const moves = (reply: Reply) => reply.containerList[0]!.dcsaStatusInfo;
// Yang Ming's answer for a number it does not hold.
const missing = (number: string) => ({ successCnt: 0, containerList: [], blList: [], bookingList: [],
  emptyList: [{ queryTrackNo: number, returnTrackNo: number, responeMessage: 'Dear Sir/Madam,\n\n Sorry, we can\'t identify your input.' }] });

const LA = 'America/Los_Angeles';
const TRAPAC = 'LOS ANGELES - TRAPAC CONTAINER TERMINAL';
const PIPAVAV = 'PIPAVAV (VICTOR) PORT - APM TERMINALS PIPAVAV';

describe('Yang Ming tracking replies', () => {
  it('reads a bill\'s container moves newest first, at the zone of each town on the bill\'s route', () => {
    const result = read(BILL, { [CONTAINER]: undefined });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Gate in of Empty Equipment by Truck at Port terminal', last_update: '2026-11-16T19:06:00-08:00', expected_delivery: null });
    expect(result).not.toHaveProperty('history_truncated');
    expect(rows(result)).toEqual([
      ['2026-11-16T19:06:00-08:00', '2026-11-16T19:06:00', 'Gate in of Empty Equipment by Truck at Port terminal', 'LOS ANGELES - YUSEN CONTAINER TERMINAL (YTI)', 'delivered'],
      ['2026-11-12T18:13:00-08:00', '2026-11-12T18:13:00', 'Gate out of Laden Equipment by Truck at Port terminal', TRAPAC, 'out_for_delivery'],
      ['2026-11-09T11:13:00-08:00', '2026-11-09T11:13:00', 'Discharge of Laden Equipment from Vessel at Port terminal', TRAPAC, 'in_transit'],
      ['2026-11-07T03:30:00-08:00', '2026-11-07T03:30:00', 'Arrival by Vessel at Port terminal', TRAPAC, 'in_transit'],
      [null, '2026-10-11T07:45:00', 'Departure by Vessel at Port terminal', 'SINGAPORE', 'in_transit'],
      [null, '2026-10-10T15:03:00', 'Load of Laden Equipment onto Vessel at Port terminal', 'SINGAPORE', 'in_transit'],
      [null, '2026-09-24T06:06:00', 'Discharge of Laden Equipment from Vessel at Port terminal', 'SINGAPORE', 'in_transit'],
      [null, '2026-09-23T12:25:00', 'Arrival by Vessel at Port terminal', 'SINGAPORE', 'in_transit'],
      ['2026-09-10T15:20:00+05:30', '2026-09-10T15:20:00', 'Departure by Vessel at Port terminal', PIPAVAV, 'in_transit'],
      ['2026-09-10T15:04:00+05:30', '2026-09-10T15:04:00', 'Load of Laden Equipment onto Vessel at Port terminal', PIPAVAV, 'in_transit'],
      ['2026-08-24T23:47:00+05:30', '2026-08-24T23:47:00', 'Gate in of Laden Equipment by Truck at Port terminal', PIPAVAV, 'accepted'],
      [null, '2026-08-17T23:55:00', 'Gate out of Empty Equipment by Truck at Depot', 'AHMEDABAD - ICD Khodiyar (Container Corporation of Indian Ltd)', 'registered'],
    ]);
    expect(result.events[0]).toEqual({ time: '2026-11-16T19:06:00-08:00', local_time: '2026-11-16T19:06:00', time_zone: LA, time_zone_basis: 'place',
      location: 'LOS ANGELES - YUSEN CONTAINER TERMINAL (YTI)', description: 'Gate in of Empty Equipment by Truck at Port terminal',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events[4]).not.toHaveProperty('time_zone');
    const routed = read(BILL, { [CONTAINER]: undefined }, reply => { reply.blList[0]!.basicInfo.receipt = 'SINGAPORE (SGSIN)'; });
    expect(routed.events[4]).toMatchObject({ time: '2026-10-11T07:45:00+08:00', time_zone: 'Asia/Singapore' });
  });

  it('keeps the order the reply gives moves at one time', () => {
    const result = read(SAVANNAH_BILL, { [SAVANNAH_CONTAINER]: undefined });
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-09-17T05:36:00-04:00' });
    expect(rows(result).slice(4, 6)).toEqual([
      ['2026-06-30T22:30:00+08:00', '2026-06-30T22:30:00', 'Departure by Vessel at Port terminal', 'NINGBO - NINGBO BEILUN SECOND CONTAINER TERMINAL', 'in_transit'],
      ['2026-06-30T22:30:00+08:00', '2026-06-30T22:30:00', 'Load of Laden Equipment onto Vessel at Port terminal', 'NINGBO - NINGBO BEILUN SECOND CONTAINER TERMINAL', 'in_transit'],
    ]);
  });

  it('reads a container\'s own lookup as wall clocks, its route unknown', () => {
    const lookup = yangMingLookup(fixture(`tracking-${CONTAINER}`), yangMingQuery(CONTAINER));
    const result = yangMingResult(lookup);
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-11-16T19:06:00' });
    const bill = read(BILL, { [CONTAINER]: undefined });
    expect(result.events!.map(event => [event.local_time, event.description, event.location]))
      .toEqual(bill.events.map(event => [event.local_time, event.description, event.location]));
    expect(result.events!.every(event => !('time' in event))).toBe(true);
  });

  it('reads moves not yet made as none, and an empty container returned before it moved as no delivery', () => {
    const sailing = read(BILL, { [CONTAINER]: reply => {
      reply.containerList[0]!.dcsaStatusInfo = [{ ...moves(reply)[3]!, eventClassifie: 'Estimated', moveDate: '2026/11/07 00:00' }, ...moves(reply).slice(4)];
    } });
    expect(sailing).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departure by Vessel at Port terminal' });
    expect(sailing.events).toHaveLength(8);
    const unused = read(BILL, { [CONTAINER]: reply => {
      reply.containerList[0]!.dcsaStatusInfo = [{ ...moves(reply)[0]!, moveDate: '2026/08/18 10:00' }, moves(reply).at(-1)!];
    } });
    expect(unused).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Gate in of Empty Equipment by Truck at Port terminal' });
    expect(unused.events[0]).not.toHaveProperty('stage');
  });

  it('keeps the latest event of containers whose moves were not asked, and delivers a bill only once every container is back', () => {
    const latest = read(SAVANNAH_BILL, {});
    expect(latest).toMatchObject({ status: 'delivered', current_stage: 'delivered', history_truncated: true, last_update: '2026-09-17T05:36:00-04:00' });
    expect(latest.events).toHaveLength(1);
    const second = (lastEvent: string, moveDate = '2026/09/10 08:00') => (reply: Reply) => {
      reply.blList[0]!.dcsaContainerInfo.push({ ...reply.blList[0]!.dcsaContainerInfo[0]!, ctnrNo: 'ZZZU9999992', lastEvent, moveDate });
    };
    const waiting = read(SAVANNAH_BILL, { [SAVANNAH_CONTAINER]: undefined }, second('Gate out of Laden Equipment by Truck at Port terminal'));
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', history_truncated: true,
      last_status_text: 'Gate in of Empty Equipment by Truck at Port terminal' });
    expect(waiting.events).toHaveLength(9);
    const unseen = read(SAVANNAH_BILL, { [SAVANNAH_CONTAINER]: undefined }, reply => {
      second('')(reply);
      delete reply.blList[0]!.dcsaContainerInfo[1]!.lastEvent;
    });
    expect(unseen).toMatchObject({ status: 'unknown' });
    expect(unseen).not.toHaveProperty('current_stage');
    expect(unseen).not.toHaveProperty('history_truncated');
    const shared = read(SAVANNAH_BILL, { [SAVANNAH_CONTAINER]: undefined }, second('Gate in of Empty Equipment by Truck at Port terminal', '2026/09/17 05:36'));
    expect(shared.events).toHaveLength(8);
    expect(() => read(SAVANNAH_BILL, {}, reply => { reply.blList[0]!.dcsaContainerInfo = []; }))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('reads Yang Ming\'s answer for a number it does not hold as missing, and a reply for another number or kind as changed', () => {
    expect(yangMingLookup(missing(BILL), yangMingQuery(BILL))).toEqual({ kind: 'missing' });
    expect(() => yangMingResult({ kind: 'missing' })).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const fails = (reply: unknown, number = BILL) => expect(() => yangMingLookup(reply, yangMingQuery(number))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(missing('Z999999999'));
    fails({ ...missing(BILL), emptyList: [{ queryTrackNo: BILL, responeMessage: 'Service unavailable' }] });
    fails(fixture(`tracking-${BILL}`), CONTAINER);
    fails(fixture(`tracking-${CONTAINER}`), BILL);
    fails(edited(`tracking-${BILL}`, reply => { reply.bookingList = reply.blList; reply.blList = []; }));
    fails(edited(`tracking-${BILL}`, reply => { reply.containerList = fixture(`tracking-${CONTAINER}`).containerList; }));
    fails(edited(`tracking-${BILL}`, reply => { reply.blList[0]!.queryTrackNo = 'Z999999999'; }));
    fails(edited(`tracking-${BILL}`, reply => { reply.blList[0]!.trackTypeCode = 'BKNO'; }));
    fails(edited(`tracking-${BILL}`, reply => { reply.blList[0]!.returnTrackNo = 'Z999999999'; }));
    fails(edited(`tracking-${BILL}`, reply => { reply.blList[0]!.dcsaContainerInfo[0]!.ctnrNo = 'YMMU706551'; }));
    fails(edited(`tracking-${BILL}`, reply => { reply.blList[0]!.dcsaContainerInfo.push(reply.blList[0]!.dcsaContainerInfo[0]!); }));
    fails(edited(`tracking-${BILL}`, reply => { reply.blList = {} as never; }));
    fails([]);
    fails(edited(`tracking-${CONTAINER}`, reply => { moves(reply)[0]!.moveDate = '2026/02/30 19:06'; }), CONTAINER);
    fails(edited(`tracking-${CONTAINER}`, reply => { moves(reply)[0]!.moveDate = '2026-11-16 19:06'; }), CONTAINER);
    fails(edited(`tracking-${CONTAINER}`, reply => { moves(reply)[0]!.moveDate = '1999/11/16 19:06'; }), CONTAINER);
    fails(edited(`tracking-${CONTAINER}`, reply => { moves(reply)[0]!.eventClassifie = 'Guessed'; }), CONTAINER);
    fails(edited(`tracking-${CONTAINER}`, reply => { moves(reply)[0]!.eventDesc = ' '; }), CONTAINER);
    fails(edited(`tracking-${CONTAINER}`, reply => { moves(reply)[0]!.atFacility = 7; }), CONTAINER);
    fails(edited(`tracking-${CONTAINER}`, reply => { reply.containerList[0]!.trackTypeCode = 'BLNO'; }), CONTAINER);
    for (const reply of [fixture(`detail-${SAVANNAH_CONTAINER}`), missing(CONTAINER)]) {
      expect(() => yangMingDetail(reply, CONTAINER, new Map())).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads Akamai\'s refusal and the block page as a challenge, and other pages as a changed reply', () => {
    expect(() => yangMingJson('<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const body of ['', '<html><body>Maintenance</body></html>', '{"successCnt":1']) {
      expect(() => yangMingJson(body), body).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(yangMingJson('﻿{"successCnt":0}')).toEqual({ successCnt: 0 });
  });
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const carrier = (fetcher: typeof fetch, recorder?: StepRecorder) =>
  adapter({ fetcher, ...(recorder ? { recorder } : {}), env: {}, trawl: null, browserExecutablePath: null } as Parameters<typeof adapter>[0]);
/** Answers the page's lookups from the fixtures, and the block status as given. */
const site = (blocked = false, replies: Record<string, unknown> = {}) => vi.fn<typeof fetch>(async input => {
  const url = new URL(String(input));
  if (url.pathname === '/api/Public/GetBlockStatus') return json({ isInBlackList: blocked, isUnlocked: false, clientIP: '192.0.2.1' });
  const number = url.searchParams.get('paramTrackNo')!;
  const name = url.searchParams.get('paramTrackPosition') === 'BL_CT' ? `detail-${number}` : `tracking-${number}`;
  return json(replies[name] ?? (() => { try { return fixture(name); } catch { return missing(number); } })());
});

describe('Yang Ming adapter', () => {
  it('takes a bill with or without its SCAC, or a container with its check digit, and nothing else', async () => {
    expect([containerCheckDigit('YMMU706551'), containerCheckDigit('ZZZU999999')]).toEqual([0, 2]);
    expect(yangMingQuery(' ymja w501 000 129 ')).toEqual({ kind: 'bill', number: BILL });
    expect(yangMingQuery('YMLUE232257945')).toEqual({ kind: 'bill', number: SAVANNAH_BILL });
    expect(yangMingQuery(BILL)).toEqual({ kind: 'bill', number: BILL });
    expect(yangMingQuery('ymmu 706551-0')).toEqual({ kind: 'container', number: CONTAINER });
    expect(yangMingLookupUrl(CONTAINER, 'BL_CT', BILL))
      .toBe(`https://www.yangming.com/api/CargoTracking/GetTracking?paramTrackNo=${CONTAINER}&paramTrackPosition=BL_CT&paramRefNo=${BILL}`);
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['YMMU7065511', 'YMJA501000129', 'ZIMUW501000129', 'W50100012', 'WW501000129', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks for the bill as the page searches, then its containers\' moves as the page asks for them', async () => {
    const fetcher = site();
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, recorder).track({ number: `YMJA${BILL}` })).resolves.toMatchObject({ current_stage: 'delivered', events: expect.any(Array) });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([yangMingLookupUrl(BILL), yangMingLookupUrl(CONTAINER, 'BL_CT', BILL)]);
    const headers = new Headers(fetcher.mock.calls[0]![1]!.headers);
    expect([headers.get('user-agent'), headers.get('referer')]).toEqual([YANG_MING_USER_AGENT, 'https://www.yangming.com/en/ebusiness/cargo_tracking']);
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
  });

  it('asks for the moves of a bill\'s first containers only', async () => {
    const bill = edited(`tracking-${SAVANNAH_BILL}`, reply => {
      const [first] = reply.blList[0]!.dcsaContainerInfo;
      reply.blList[0]!.dcsaContainerInfo = ['ZZZU9999992', 'ZZZU9999987', 'ZZZU9999971', 'ZZZU9999966'].map(ctnrNo => ({ ...first, ctnrNo }));
    });
    const detail = (number: string) => edited(`detail-${SAVANNAH_CONTAINER}`, reply => { reply.containerList[0]!.queryTrackNo = number; });
    const fetcher = site(false, { [`tracking-${SAVANNAH_BILL}`]: bill, ...Object.fromEntries(['ZZZU9999992', 'ZZZU9999987', 'ZZZU9999971']
      .map(number => [`detail-${number}`, detail(number)])) });
    await expect(carrier(fetcher).track({ number: SAVANNAH_BILL })).resolves.toMatchObject({ current_stage: 'delivered', history_truncated: true });
    expect(fetcher).toHaveBeenCalledTimes(1 + MAX_DETAILS);
  });

  it('reads no result as not found only when Yang Ming does not block the address', async () => {
    const open = site();
    await expect(carrier(open).track({ number: 'Z999999999' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(open.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/CargoTracking/GetTracking', '/api/Public/GetBlockStatus']);
    await expect(carrier(site(true)).track({ number: 'Z999999999' })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => json({ blocked: 'yes' })).track({ number: 'Z999999999' })).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(async () => new Response('', { status: 403 })).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => new Response('', { status: 429 })).track({ number: BILL })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('asks once more when the lookup does not reach Yang Ming', async () => {
    const fixtures = site();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(fixtures);
    await expect(carrier(fetcher).track({ number: CONTAINER })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is asked when the number is filed under Yang Ming or comes in a link to its tracking page', async () => {
    await expect(createTracker({ providers: [], env: {}, fetcher: site() }).track({ number: SAVANNAH_BILL, carrier: 'yang-ming' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'yang-ming', source: 'yang-ming', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('yang-ming').tracking).toMatchObject({ adapter: 'yang-ming', localClocks: true });
    expect(parseTrackingInput(`https://www.yangming.com/en/ebusiness/tracking/cargo_tracking_detail?trackNo=${BILL}&position=SEARCH&refNo=${BILL}`))
      .toMatchObject({ trackingNumber: BILL, carrier: 'yang-ming', source: 'link' });
  });
});

describe('Yang Ming status vocabulary', () => {
  it('stages each wording the replies give, by its event and load', () => {
    for (const entry of statuses.entries) {
      expect(yangMingStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'yang-ming', providerCode: null, description: entry.wording }).kind, entry.wording).toBe('mapped');
    }
    expect(yangMingStage('Gate out of Laden Equipment by Rail at Port terminal')).toBe('in_transit');
    expect(yangMingStage('Gate in of Empty Equipment by Truck at Depot')).toBe('delivered');
    expect(yangMingStage('Departure by Rail at Inland terminal')).toBe('in_transit');
    expect(yangMingStage('Load of Empty Equipment onto Vessel at Port terminal')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'yang-ming', providerCode: null, description: 'Load of Empty Equipment onto Vessel at Port terminal' }).kind)
      .toBe('intentional_gap');
    expect(statusMap.stage(null, 'stuffing of equipment')).toBeUndefined();
  });
});
