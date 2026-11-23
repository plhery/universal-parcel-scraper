import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TS_LINES_SITE } from './adapter.js';
import {
  captchaRejected, containerCheckDigit, MAX_DETAILS, TS_LINES_API, tsLinesBill, tsLinesCaptcha, tsLinesCaptchaCode, tsLinesContainer, tsLinesHistory,
  tsLinesJson, tsLinesQuery, tsLinesResult,
} from './parser.js';
import { statusMap, tsLinesStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples and the bills T.S. Lines names for them. Other numbers are synthetic.
const NEXT_CYCLE = 'TSSU2130380';
const NEXT_CYCLE_BILL = '741650181991';
const RETURNED = 'TSSU5150815';
const RETURNED_BILL = '721611659707';
const UNUSED = 'TSTU8204797';
const LOADED = 'TSSU2065200';
const LOADED_BILL = '800610312902';
const SIXTY = '554610098792';
const UNKNOWN_CONTAINER = 'TSLU0000015';
const UNKNOWN_BILL = '999999999990';
const CODES = ['3477', '0668', '0411'];

type Row = Record<string, unknown>;
type Reply = { cargoOnTheWay: Row[]; cargos: Row[]; docs: Row[]; captchaSVG: string; captchaToken: string };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const edited = (name: string, edit?: (reply: Reply) => void) => {
  const reply = fixture(name);
  edit?.(reply);
  return reply;
};
type Moves = ReturnType<typeof tsLinesHistory>;
/** A container's result from its search and, when its latest cycle names a bill, its moves under that bill. */
const container = (number: string, edit?: (reply: Reply) => void, editMoves?: (reply: Reply) => void) => {
  const cycle = tsLinesContainer(edited(`container-${number}`, edit), number);
  const details = new Map<string, Moves>(cycle?.bill ? [[number, tsLinesHistory(edited(`his-${cycle.bill}-${number}`, editMoves), number)]] : []);
  const result = tsLinesResult(cycle ? [cycle] : null, details);
  return { ...result, events: result.events ?? [] };
};
/** A bill's result from its search and the moves of its first containers. */
const bill = (number: string, edit?: (reply: Reply) => void) => {
  const cycles = tsLinesBill(edited(`bill-${number}`, edit), number);
  const details = new Map<string, Moves>((cycles ?? []).slice(0, MAX_DETAILS)
    .filter(cycle => existsSync(new URL(`./fixtures/his-${number}-${cycle.number}.json`, import.meta.url)))
    .map(cycle => [cycle.number, tsLinesHistory(fixture(`his-${number}-${cycle.number}`), cycle.number)]));
  const result = tsLinesResult(cycles, details);
  return { ...result, events: result.events ?? [] };
};
const rows = (result: { events: { local_time?: string; description?: string; location?: string; stage?: string }[] }) =>
  result.events.map(event => [event.local_time, event.description, event.location ?? null, event.stage ?? null]);

const CCTC = 'CCTC NO.9/10/11 PUBLIC CONTAINER TERMINAL 中國貨櫃專用碼頭, Taiwan';
const DONG_AN = 'GREATING FORTUNE DEPOT (DONG AN), Vietnam';
const CHIWAN = 'CHIWAN CONTAINER TERMINAL CO., LTD. (CCT), China';
const TIANJIN = 'TIANJIN PORT SECOND CONTAINER TERMINAL CO., LTD., China';
const EMPTY_AVAILABLE = 'EMPTY AVAILABLE GATE IN/CHANGE AVAILABLE/EMPTY AVAILABLE';

describe('T.S. Lines captcha', () => {
  const svg = fixture('captcha-3477').captchaSVG;
  const glyphs = svg.match(/<path fill="[^"]+" d="[^"]+"\/>/g) ?? [];

  it('reads the four digits from the curves of their glyphs, left to right', () => {
    expect(glyphs).toHaveLength(4);
    CODES.forEach((code, index) => {
      expect(tsLinesCaptchaCode(fixture(`captcha-${code}`).captchaSVG), code).toBe(code);
      expect(tsLinesCaptcha(fixture(`captcha-${code}`))).toEqual({ token: `fixture-token-${index + 1}`, code });
    });
  });

  it('refuses an image it cannot read, and a reply without an image or token', () => {
    const unreadable = [
      svg.replace(glyphs[0]!, ''),
      svg.replace(glyphs[0]!, `${glyphs[0]}${glyphs[0]}`),
      svg.replace(glyphs[0]!, glyphs[0]!.replace('Q', 'L')),
      svg.replace(glyphs[0]!, glyphs[0]!.replace('Z"', 'A1 1 0 0 1 2 2Z"')),
      `${svg}${svg}`,
      '<html><body>Captcha unavailable</body></html>',
      `<svg>${'<rect/>'.repeat(10_000)}</svg>`,
    ];
    for (const image of unreadable) {
      expect(() => tsLinesCaptchaCode(image), image.slice(0, 80)).toThrowError(expect.objectContaining({ kind: 'challenge', reason: 'puzzle_unsolved' }));
    }
    expect(() => tsLinesCaptcha({ captchaSVG: unreadable[0], captchaToken: 'fixture-token-1' })).toThrowError(expect.objectContaining({ reason: 'puzzle_unsolved' }));
    for (const reply of [{ captchaToken: 'fixture-token-1' }, { captchaSVG: svg, captchaToken: 'two words' }, { captchaSVG: svg }, [], null]) {
      expect(() => tsLinesCaptcha(reply), JSON.stringify(reply).slice(0, 40)).toThrowError(expect.objectContaining({ kind: 'challenge', reason: 'puzzle_missing' }));
    }
  });
});

describe('T.S. Lines replies', () => {
  it('reads a container whose latest cycle names no bill yet by that cycle\'s latest move alone', () => {
    expect(tsLinesContainer(fixture(`container-${NEXT_CYCLE}`), NEXT_CYCLE)).toMatchObject({ number: NEXT_CYCLE, bill: null });
    const result = container(NEXT_CYCLE);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map', last_status_text: 'FULL TURN IN CY-OUTBOUND',
      last_update: null, last_update_local: '2026-11-16T15:35:00', expected_delivery: null });
    expect(result).not.toHaveProperty('history_truncated');
    expect(result.events).toEqual([{ local_time: '2026-11-16T15:35:00', description: 'FULL TURN IN CY-OUTBOUND', location: CCTC, stage: 'accepted', stage_source: 'carrier_map' }]);
    // An empty container made available with no bill has not moved in its cycle: no delivery.
    const unused = container(UNUSED);
    expect(unused).toMatchObject({ status: 'unknown', last_status_text: EMPTY_AVAILABLE, last_update_local: '2026-11-04T13:44:00' });
    expect(unused).not.toHaveProperty('current_stage');
    expect(unused.events).toHaveLength(1);
    expect(unused.events[0]).not.toHaveProperty('stage');
  });

  it('reads a container\'s latest cycle from its moves under the bill, with the search\'s latest move where they lack it', () => {
    expect(tsLinesContainer(fixture(`container-${RETURNED}`), RETURNED)).toMatchObject({ bill: RETURNED_BILL });
    const result = container(RETURNED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: EMPTY_AVAILABLE, last_update: null, last_update_local: '2026-11-20T17:58:00' });
    expect(result).not.toHaveProperty('history_truncated');
    expect(rows(result)).toEqual([
      ['2026-11-20T17:58:00', EMPTY_AVAILABLE, DONG_AN, 'delivered'],
      ['2026-11-20T09:52:00', 'Empty gate-In', DONG_AN, 'delivered'],
      ['2026-11-19T02:30:00', 'FULL CONTAINER OUT FOR DEVANNING', 'CAT LAI, Vietnam', 'out_for_delivery'],
      ['2026-11-18T01:00:00', 'FCL CONTAINER DISCHAREGED FROM VESSEL', 'CAT LAI, Vietnam', 'in_transit'],
      ['2026-11-13T11:31:00', 'FULL CONTAINER LOADED ON VESSEL', CHIWAN, 'in_transit'],
      ['2026-11-05T12:26:00', 'FULL TURN IN CY-OUTBOUND', CHIWAN, 'accepted'],
      ['2026-11-04T18:15:00', 'MTY CONTAINER OUT FOR VANNING', CHIWAN, 'registered'],
    ]);
    expect(result.events.some(event => 'time' in event || 'time_zone' in event)).toBe(false);
    const loaded = container(LOADED);
    expect(loaded).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-11-10T03:30:00' });
    expect(rows(loaded).map(([time, wording]) => [time, wording])).toEqual([
      ['2026-11-10T03:30:00', 'FULL CONTAINER LOADED ON VESSEL'],
      ['2026-11-06T23:18:00', 'FULL TURN IN CY-OUTBOUND'],
      ['2026-10-28T08:17:00', 'EMTY CONTAINER TO CFS FOR STUFFING'],
    ]);
  });

  it('reads a gate in after the container moved as transit, and an empty container back before it moved as no delivery', () => {
    const moved = container(RETURNED, undefined, reply => {
      reply.docs.unshift({ ...reply.docs.find(row => row.ACTIVITY === 'FULL TURN IN CY-OUTBOUND'), EQPA_MOVE_DATE: '2026/11/21 08:00:00' });
    });
    expect(moved).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(moved.events[0]).toMatchObject({ description: 'FULL TURN IN CY-OUTBOUND', stage: 'in_transit' });
    const back = { ACTIVITY: 'Empty gate-In', ACTIVETIME: '2026/10/29 09:00', EQPA_MOVE_DATE: '2026/10/29 09:00:00' };
    const unused = container(LOADED, reply => {
      const newest = reply.cargoOnTheWay.find(row => row.BL_NUMBER === LOADED_BILL)!;
      Object.assign(newest, { ACTIVITY: back.ACTIVITY, ACTIVETIME: back.ACTIVETIME });
    }, reply => {
      reply.docs = [{ ...reply.docs.at(-1), ACTIVITY: back.ACTIVITY, EQPA_MOVE_DATE: back.EQPA_MOVE_DATE }, reply.docs.at(-1)!];
    });
    expect(unused).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Empty gate-In' });
    expect(unused.events).toHaveLength(2);
    expect(unused.events[0]).not.toHaveProperty('stage');
  });

  it('reads a bill\'s containers, with the moves of its first containers and the latest move of the others', () => {
    const one = bill(NEXT_CYCLE_BILL);
    expect(one).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Empty gate-In', last_update_local: '2026-10-28T10:11:00' });
    expect(one).not.toHaveProperty('history_truncated');
    expect(rows(one).map(([time, wording, , stage]) => [time, wording, stage])).toEqual([
      ['2026-10-28T10:11:00', 'Empty gate-In', 'delivered'],
      ['2026-10-28T07:55:00', 'FULL CONTAINER OUT FOR DEVANNING', 'out_for_delivery'],
      ['2026-10-16T08:59:00', 'FCL CONTAINER DISCHAREGED FROM VESSEL', 'in_transit'],
      ['2026-10-13T12:00:00', 'FULL CONTAINER LOADED ON VESSEL', 'in_transit'],
      ['2026-10-13T00:00:00', 'FULL TURN IN CY-OUTBOUND', 'accepted'],
      ['2026-10-01T11:44:00', 'MTY CONTAINER OUT FOR VANNING', 'registered'],
    ]);
    expect(one.events[1]).toMatchObject({ location: CCTC });
    // Five containers loaded together: their shared moves are kept once.
    expect(tsLinesBill(fixture(`bill-${LOADED_BILL}`), LOADED_BILL)).toHaveLength(5);
    const five = bill(LOADED_BILL);
    expect(five).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', history_truncated: true, last_update_local: '2026-11-10T03:30:00' });
    expect(rows(five)).toEqual([
      ['2026-11-10T03:30:00', 'FULL CONTAINER LOADED ON VESSEL', TIANJIN, 'in_transit'],
      ['2026-11-06T23:18:00', 'FULL TURN IN CY-OUTBOUND', TIANJIN, 'accepted'],
      ['2026-10-28T08:17:00', 'EMTY CONTAINER TO CFS FOR STUFFING', 'TIANJIN EX INTERNATIONAL LOGISTICS CO.,LTD, China', 'registered'],
    ]);
    const sixty = bill(SIXTY);
    expect(tsLinesBill(fixture(`bill-${SIXTY}`), SIXTY)).toHaveLength(60);
    expect(sixty).toMatchObject({ status: 'delivered', current_stage: 'delivered', history_truncated: true, last_status_text: 'Empty gate-In.', last_update_local: '2026-11-17T17:15:00' });
    expect(sixty.events).toHaveLength(62);
    expect(sixty.events).toContainEqual(expect.objectContaining({ local_time: '2026-09-24T13:49:00', description: 'FULL CONTAINER OUT FOR DEVANNING', stage: 'out_for_delivery' }));
  });

  it('delivers a bill only once every container is back, and leaves the stage open for a container it cannot stage', () => {
    const waiting = bill(SIXTY, reply => {
      Object.assign(reply.cargos[10]!, { ACTIVITY: 'FULL CONTAINER OUT FOR DEVANNING', ACTIVE_DATE: '2026/11/18 08:00' });
    });
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'FULL CONTAINER OUT FOR DEVANNING' });
    const unstaged = bill(SIXTY, reply => { reply.cargos[10]!.ACTIVITY = 'CONTAINER INSPECTED'; });
    expect(unstaged).toMatchObject({ status: 'unknown', history_truncated: true });
    expect(unstaged).not.toHaveProperty('current_stage');
    const twice = tsLinesBill(edited(`bill-${NEXT_CYCLE_BILL}`, reply => {
      reply.cargos.push({ ...reply.cargos[0], ACTIVITY: 'MTY CONTAINER OUT FOR VANNING', ACTIVE_DATE: '2026/10/01 11:44' });
    }), NEXT_CYCLE_BILL);
    expect(twice).toEqual([expect.objectContaining({ number: NEXT_CYCLE, latest: expect.objectContaining({ description: 'Empty gate-In' }) })]);
  });

  it('reads a reply for another container or bill as indeterminate', () => {
    const another = (read: () => unknown) => expect(read).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    another(() => tsLinesContainer(fixture(`container-${NEXT_CYCLE}`), RETURNED));
    another(() => tsLinesContainer(edited(`container-${RETURNED}`, reply => { reply.cargoOnTheWay[3]!.CONTAINERNUMBER = NEXT_CYCLE; }), RETURNED));
    another(() => tsLinesBill(fixture(`bill-${LOADED_BILL}`), NEXT_CYCLE_BILL));
    another(() => tsLinesBill(edited(`bill-${SIXTY}`, reply => { reply.cargos[59]!.BL_NUMBER = LOADED_BILL; }), SIXTY));
    another(() => tsLinesHistory(fixture(`his-${NEXT_CYCLE_BILL}-${NEXT_CYCLE}`), RETURNED));
  });

  it('reads empty lists as not found, and a changed reply as a schema error', () => {
    expect(tsLinesContainer(fixture(`container-${UNKNOWN_CONTAINER}`), UNKNOWN_CONTAINER)).toBeNull();
    expect(tsLinesBill(fixture(`bill-${UNKNOWN_BILL}`), UNKNOWN_BILL)).toBeNull();
    expect(tsLinesHistory({ docs: [] }, RETURNED)).toEqual([]);
    expect(() => tsLinesResult(null)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => tsLinesResult([])).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const schema = (read: () => unknown, label: string) => expect(read, label).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const cycle = (edit: (row: Row) => void, label: string) =>
      schema(() => tsLinesContainer(edited(`container-${RETURNED}`, reply => edit(reply.cargoOnTheWay[0]!)), RETURNED), label);
    for (const reply of [{}, { cargoOnTheWay: {} }, { cargoOnTheWay: [7] }, [], 'null']) schema(() => tsLinesContainer(reply, RETURNED), JSON.stringify(reply));
    schema(() => tsLinesContainer({ cargoOnTheWay: Array.from({ length: 501 }, () => fixture(`container-${RETURNED}`).cargoOnTheWay[0]) }, RETURNED), 'too many rows');
    schema(() => tsLinesBill({ cargoOnTheWay: [] }, UNKNOWN_BILL), 'container reply for a bill');
    cycle(row => { row.ACTIVETIME = '2026-11-20 17:58'; }, 'dashed date');
    cycle(row => { row.ACTIVETIME = '1999/11/20 17:58'; }, 'old year');
    cycle(row => { row.ACTIVETIME = '2026/11/31 17:58'; }, 'no such day');
    cycle(row => { row.ACTIVITY = ' '; }, 'blank wording');
    cycle(row => { row.LOCATION = 7; }, 'numeric facility');
    cycle(row => { row.BL_NUMBER = '<b>'; }, 'markup bill');
    schema(() => tsLinesBill(edited(`bill-${NEXT_CYCLE_BILL}`, reply => { reply.cargos[0]!.CONTAINER_NUMBER = 'TSSU213038'; }), NEXT_CYCLE_BILL), 'short container');
    schema(() => tsLinesHistory(edited(`his-${RETURNED_BILL}-${RETURNED}`, reply => { reply.docs[0]!.EQPA_MOVE_DATE = ''; }), RETURNED), 'no move time');
  });

  it('reads a bot check page as a challenge, other pages as a changed reply, and a refused captcha code by its message', () => {
    for (const body of ['<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><head><title>Access Denied</title></head><body>Reference errors.edgesuite.net</body></html>']) {
      expect(() => tsLinesJson(body), body).toThrowError(expect.objectContaining({ kind: 'challenge', reason: 'api_denied' }));
    }
    for (const body of ['', '<html><body>Maintenance</body></html>', '{"cargos":']) {
      expect(() => tsLinesJson(body), body).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(tsLinesJson('﻿{"docs":[]}')).toEqual({ docs: [] });
    expect(captchaRejected({ statusCode: 400, error: 'Bad Request', message: 'captcha code invalid.' })).toBe(true);
    expect(captchaRejected({ statusCode: 400, error: 'Bad Request', message: 'BL_NUMBER must be a string' })).toBe(false);
    expect(captchaRejected('captcha code invalid.')).toBe(false);
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const carrier = (fetcher: typeof fetch, options: { recorder?: StepRecorder; userAgent?: string } = {}) =>
  adapter({ fetcher, ...options, env: {}, trawl: null, browserExecutablePath: null } as Parameters<typeof adapter>[0]);
const stored = (name: string, missing: unknown) => existsSync(new URL(`./fixtures/${name}.json`, import.meta.url)) ? fixture(name) : missing;
/**
 * T.S. Lines' service from the fixtures: captchas in turn, each token good for one search with its
 * code; searches answered as for a number it does not hold when no fixture has one. The first
 * `refuse` searches are refused as a wrong code.
 */
const site = ({ refuse = 0, replies = {} }: { refuse?: number; replies?: Record<string, unknown> } = {}) => {
  const issued = new Map<string, string>();
  let captchas = 0;
  let refused = 0;
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).slice(TS_LINES_API.length + 1);
    if (path === 'captcha') {
      const reply = fixture(`captcha-${CODES[captchas % CODES.length]}`);
      captchas += 1;
      // Each captcha its own token, as T.S. Lines issues them.
      const token = `${reply.captchaToken}.${captchas}`;
      issued.set(token, tsLinesCaptchaCode(reply.captchaSVG));
      return json({ ...reply, captchaToken: token });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    if (path === 'CargoTrackingHis') return json(replies[`his-${body.BL_NUMBER}-${body.CONTAINER_NUMBER}`] ?? stored(`his-${body.BL_NUMBER}-${body.CONTAINER_NUMBER}`, { docs: [] }));
    const code = issued.get(body.CAPTCHA_TOKEN ?? '');
    issued.delete(body.CAPTCHA_TOKEN ?? '');
    if (!code || code !== body.CAPTCHA_CODE || refused++ < refuse) return json({ statusCode: 400, error: 'Bad Request', message: 'captcha code invalid.' }, 400);
    const name = path === 'CargoTrackingByContainerNumber' ? `container-${body.CONTAINER_NUMBER}` : `bill-${body.BL_NUMBER}`;
    const empty = path === 'CargoTrackingByContainerNumber' ? { cargoOnTheWay: [], estimatedCargoRoute: [] } : { cargos: [], estimatedCargoRoute: [] };
    return json(replies[name] ?? stored(name, empty));
  });
};
const requests = (fetcher: ReturnType<typeof site>) => fetcher.mock.calls.map(([url, init]) => [String(url).slice(TS_LINES_API.length + 1), init?.method,
  init?.body ? JSON.parse(String(init.body)) as Record<string, string> : null] as const);

describe('T.S. Lines adapter', () => {
  it('takes a container with its check digit or a bill of twelve digits, and nothing else', async () => {
    expect([containerCheckDigit('TSSU213038'), containerCheckDigit('TSLU000001')]).toEqual([0, 5]);
    expect(tsLinesQuery(' tssu 213038-0 ')).toEqual({ kind: 'container', number: NEXT_CYCLE });
    expect(tsLinesQuery('7416 5018 1991')).toEqual({ kind: 'bill', number: NEXT_CYCLE_BILL });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TSSU2130381', 'TSSU213038', 'TSSB2130380', '74165018199', '7416501819910', 'TSLU741650181991', '', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NEXT_CYCLE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers a captcha, searches the container with its code, then asks the moves under the latest cycle\'s bill', async () => {
    const fetcher = site();
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, { recorder, userAgent: 'Parcel test agent' }).track({ number: RETURNED }))
      .resolves.toMatchObject({ current_stage: 'delivered', last_update_local: '2026-11-20T17:58:00', events: expect.any(Array) });
    expect(requests(fetcher)).toEqual([
      ['captcha', 'GET', null],
      ['CargoTrackingByContainerNumber', 'POST', { CONTAINER_NUMBER: RETURNED, CAPTCHA_TOKEN: 'fixture-token-1.1', CAPTCHA_CODE: '3477' }],
      ['CargoTrackingHis', 'POST', { BL_NUMBER: RETURNED_BILL, CONTAINER_NUMBER: RETURNED }],
    ]);
    const headers = fetcher.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(headers.map(sent => [sent.get('origin'), sent.get('referer'), sent.get('user-agent'), sent.get('accept')]))
      .toEqual(Array.from({ length: 3 }, () => [TS_LINES_SITE, `${TS_LINES_SITE}/`, 'Parcel test agent', 'application/json']));
    expect(headers.map(sent => sent.get('content-type'))).toEqual([null, 'application/json', 'application/json']);
    expect(headers.some(sent => sent.has('cookie'))).toBe(false);
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
  });

  it('asks no moves for a cycle that names no bill, and the moves of a bill\'s first containers only', async () => {
    const next = site();
    await expect(carrier(next).track({ number: NEXT_CYCLE })).resolves.toMatchObject({ current_stage: 'accepted' });
    expect(requests(next).map(([path]) => path)).toEqual(['captcha', 'CargoTrackingByContainerNumber']);
    const many = site();
    await expect(carrier(many).track({ number: SIXTY })).resolves.toMatchObject({ current_stage: 'delivered', history_truncated: true });
    expect(requests(many).slice(1).map(([path, , body]) => [path, body?.BL_NUMBER, body?.CONTAINER_NUMBER ?? null])).toEqual([
      ['CargoTrackingByBLNumber', SIXTY, null],
      ...tsLinesBill(fixture(`bill-${SIXTY}`), SIXTY)!.slice(0, MAX_DETAILS).map(cycle => ['CargoTrackingHis', SIXTY, cycle.number]),
    ]);
    expect(many).toHaveBeenCalledTimes(2 + MAX_DETAILS);
  });

  it('answers one new captcha when T.S. Lines refuses the code, and stops at a second refusal', async () => {
    const once = site({ refuse: 1 });
    await expect(carrier(once).track({ number: LOADED_BILL })).resolves.toMatchObject({ current_stage: 'in_transit', history_truncated: true });
    expect(requests(once).slice(0, 4).map(([path, , body]) => [path, body?.CAPTCHA_TOKEN ?? null, body?.CAPTCHA_CODE ?? null])).toEqual([
      ['captcha', null, null], ['CargoTrackingByBLNumber', 'fixture-token-1.1', '3477'],
      ['captcha', null, null], ['CargoTrackingByBLNumber', 'fixture-token-2.2', '0668'],
    ]);
    const twice = site({ refuse: 2 });
    await expect(carrier(twice).track({ number: LOADED_BILL })).rejects.toMatchObject({ kind: 'challenge', reason: 'verification_refused' });
    expect(requests(twice).map(([path]) => path)).toEqual(['captcha', 'CargoTrackingByBLNumber', 'captcha', 'CargoTrackingByBLNumber']);
  });

  it('reads empty lists after an accepted code as not found, and every other refusal by its kind', async () => {
    await expect(carrier(site()).track({ number: UNKNOWN_CONTAINER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site()).track({ number: UNKNOWN_BILL })).rejects.toMatchObject({ kind: 'not_found' });
    const blocked = '<html><head><title>Just a moment...</title></head><body></body></html>';
    const answers: [string, () => Response][] = [
      ['challenge', () => new Response(blocked, { status: 200, headers: { 'content-type': 'text/html' } })],
      ['challenge', () => new Response(blocked, { status: 403 })],
      ['rate_limited', () => new Response('', { status: 429 })],
      ['transport', () => json({ statusCode: 404, message: 'Cannot GET /v1/captcha' }, 404)],
      ['schema', () => new Response('<html><body>Maintenance</body></html>', { status: 200 })],
    ];
    for (const [kind, answer] of answers) {
      await expect(carrier(async () => answer()).track({ number: RETURNED }), kind).rejects.toMatchObject({ kind });
    }
    const unreadable = vi.fn<typeof fetch>(async () => json({ ...fixture('captcha-3477'), captchaSVG: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }));
    await expect(carrier(unreadable).track({ number: RETURNED })).rejects.toMatchObject({ kind: 'challenge', reason: 'puzzle_unsolved' });
    expect(unreadable).toHaveBeenCalledTimes(1);
    // A blocked search, a refusal other than the code's, or a missing history route is no missing number.
    const searchBlocked = vi.fn<typeof fetch>(async (input, init) => String(input).endsWith('/captcha') ? site()(input, init) : new Response(blocked, { status: 200 }));
    await expect(carrier(searchBlocked).track({ number: RETURNED })).rejects.toMatchObject({ kind: 'challenge' });
    const badRequest = vi.fn<typeof fetch>(async (input, init) => String(input).endsWith('/captcha')
      ? site()(input, init) : json({ statusCode: 400, error: 'Bad Request', message: 'CONTAINER_NUMBER must be a string' }, 400));
    await expect(carrier(badRequest).track({ number: RETURNED })).rejects.toMatchObject({ kind: 'transport', status: 400 });
    const fixtures = site();
    const noHistory = vi.fn<typeof fetch>(async (input, init) => String(input).endsWith('/CargoTrackingHis') ? json({ statusCode: 404 }, 404) : fixtures(input, init));
    await expect(carrier(noHistory).track({ number: RETURNED })).rejects.toMatchObject({ kind: 'transport', status: 404 });
  });

  it('reads the moves again, with new captchas, when a request does not reach T.S. Lines', async () => {
    const fixtures = site();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(fixtures);
    const recorded: unknown[] = [];
    await expect(carrier(fetcher, { recorder: { step: entry => { recorded.push(entry); }, lookup() {} } }).track({ number: RETURNED }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'transport' }, { step: 'retry', outcome: 'ok' }]);
  });

  it('is asked when the number is filed under T.S. Lines', async () => {
    await expect(createTracker({ providers: [], env: {}, fetcher: site() }).track({ number: RETURNED, carrier: 'ts-lines' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ts-lines', source: 'ts-lines', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('ts-lines').tracking).toMatchObject({ adapter: 'ts-lines', localClocks: true });
  });
});

describe('T.S. Lines status vocabulary', () => {
  it('stages each wording the replies give, typos and full stops included', () => {
    for (const entry of statuses.entries) {
      expect(tsLinesStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'ts-lines', providerCode: null, description: entry.wording }).kind, entry.wording).toBe('mapped');
    }
    expect(tsLinesStage('  full container  loaded on vessel ')).toBe('in_transit');
    expect(tsLinesStage('EMPTY CONTAINER LOADED ON VESSEL')).toBeUndefined();
    expect(statusMap.stage(null, 'CONTAINER INSPECTED')).toBeUndefined();
  });
});
