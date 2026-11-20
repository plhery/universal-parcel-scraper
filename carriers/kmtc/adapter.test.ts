import { hash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KMTC_USER_AGENT } from './adapter.js';
import { KMTC_API, MAX_DETAILS, kmtcContainers, kmtcDetailUrl, kmtcJson, kmtcMoves, kmtcQuery, kmtcResult, type KmtcContainer } from './parser.js';
import { parseKmtcChallenge, solveKmtcChallenge } from './pow.js';
import { kmtcStage, kmtcWording, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples, and a booking their replies give. Other numbers are synthetic.
const SINGLE = 'PNC4932453';
const SINGLE_CONTAINER = 'TXGU6145102';
const NINGBO = 'NBO9602122';
const SIX = 'PNC4932614';
const AT_CONSIGNEE = 'FFAU1068820';
const BOOKING = 'KR04510826';
const BOOKING_BILL = 'PNC4932478';
const BOOKING_CONTAINER = 'KMTU9654910';

type Row = Record<string, unknown>;
type Search = Row & { cntrList: Row[] };
type Detail = Row & { trackingList: Row[]; inlandListIn: Row[] };
const FIXTURES = readdirSync(new URL('./fixtures/', import.meta.url)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
const fixture = <T = Row>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const detailOf = (container: string) => FIXTURES.find(name => name.startsWith('detail-') && name.endsWith(`-${container}`))!;
const edited = <T,>(name: string, edit?: (reply: T) => void) => {
  const reply = fixture<T>(name);
  edit?.(reply);
  return reply;
};
/** A number's result from its search and its containers' moves, each optionally edited. */
const read = (number: string, edits: Record<string, (reply: Detail) => void> = {}, editSearch?: (reply: Search) => void) => {
  const query = kmtcQuery(number);
  const containers = kmtcContainers(edited<Search>(`search-${number}`, editSearch), query);
  const details = new Map((containers ?? []).map(container =>
    [container.container, kmtcMoves(edited<Detail>(detailOf(container.container), edits[container.container]), container)]));
  const result = kmtcResult(containers, details);
  return { ...result, events: result.events ?? [] };
};
const rows = (result: { events: { time?: string; local_time?: string; description?: string; location?: string; stage?: string }[] }) =>
  result.events.map(event => [event.time ?? null, event.local_time, event.description, event.location ?? null, event.stage ?? null]);
// KMTC's answer for a number it does not hold.
const NOTHING = { cntrList: [], railCnt: 0, size: 0, useYn: 'Y', rsforChVessel: 0 };

const SSA = 'SSA TERMINALS (PIER A), LLC., LONG BEACH, UNITED STATES';
const BCT = 'BUSAN CONTAINER TERMINAL, BUSAN NEW PORT, KOREA';
const DONGWON = 'DONGWON BUSAN GLOBAL TERMINAL BUSAN, BUSAN NEW PORT, KOREA';

describe('KMTC replies', () => {
  it('reads a container\'s moves newest first, at its port\'s zone, a terminal shift as transit', () => {
    const result = read(SINGLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty Container Return', last_update: '2026-11-13T00:01:00-08:00', expected_delivery: null });
    expect(result).not.toHaveProperty('history_truncated');
    expect(rows(result)).toEqual([
      ['2026-11-13T00:01:00-08:00', '2026-11-13T00:01:00', 'Empty Container Return', SSA, 'delivered'],
      ['2026-11-06T23:40:00-08:00', '2026-11-06T23:40:00', 'Full Container Pick Up', SSA, 'out_for_delivery'],
      ['2026-11-04T10:50:00-08:00', '2026-11-04T10:50:00', 'Discharging', SSA, 'in_transit'],
      ['2026-10-20T04:42:00+09:00', '2026-10-20T04:42:00', 'On Board', BCT, 'in_transit'],
      ['2026-10-17T22:38:00+09:00', '2026-10-17T22:38:00', 'Full Container Gate In', BCT, 'in_transit'],
      ['2026-10-17T22:19:00+09:00', '2026-10-17T22:19:00', 'Full Container Gate Out', DONGWON, 'in_transit'],
      ['2026-10-13T10:02:00+09:00', '2026-10-13T10:02:00', 'Full Container Gate In', DONGWON, 'accepted'],
      ['2026-10-12T10:06:00+09:00', '2026-10-12T10:06:00', 'Empty Container Pick Up', 'HUTCHISON GAMMAN TMNL(#1), BUSAN,KOREA', 'registered'],
    ]);
    expect(result.events[0]).toEqual({ time: '2026-11-13T00:01:00-08:00', local_time: '2026-11-13T00:01:00', time_zone: 'America/Los_Angeles',
      time_zone_basis: 'place', location: SSA, description: 'Empty Container Return', provider_code: 'GTIIBE', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events[3]).toMatchObject({ time_zone: 'Asia/Seoul', provider_code: 'LDGOBF' });
    expect(read(NINGBO).events.filter(event => event.location?.includes('NINGBO')).map(event => event.time_zone)).toEqual(Array(3).fill('Asia/Shanghai'));
  });

  it('keeps the wall clock of a US port whose zone it does not know', () => {
    const result = read(SINGLE, { [SINGLE_CONTAINER]: reply => { reply.trackingList[0]!.plcCd = 'SAV'; } });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-11-13T00:01:00' });
    expect(result.events[0]).not.toHaveProperty('time');
    expect(result.events[0]).not.toHaveProperty('time_zone');
  });

  it('sets aside a previous trip\'s moves, reads a depot move after the return without a stage, and an unused container as no delivery', () => {
    const result = read(SINGLE, { [SINGLE_CONTAINER]: reply => {
      const returned = reply.trackingList[0]!;
      reply.trackingList.push({ ...returned, mvntDt: '20260901', mvntTm: '120000' });
      reply.trackingList.unshift({ ...returned, mvntDt: '20261114', mvntTm: '080000', rkCode: 'GTOIDE', rk: 99, cntrStsCd: 'GTO', cntrMvntCd: 'ID' });
    } });
    expect(result.events).toHaveLength(9);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Gate Out Empty (Depot)' });
    expect(result.events[0]).toMatchObject({ provider_code: 'GTOIDE' });
    expect(result.events[0]).not.toHaveProperty('stage');
    const unused = read(SINGLE, { [SINGLE_CONTAINER]: reply => {
      reply.trackingList = [{ ...reply.trackingList[0]!, mvntDt: '20261013' }, reply.trackingList.at(-1)!];
    } });
    expect(unused).toMatchObject({ status: 'pending', current_stage: 'registered' });
    expect(unused.events[0]).not.toHaveProperty('stage');
  });

  it('leads with a container still with the consignee, and delivers a bill once every container is back', () => {
    const result = read(SIX);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Empty Container Return',
      last_update: '2026-11-13T15:40:00-08:00' });
    expect(result).not.toHaveProperty('history_truncated');
    expect(result.events).toHaveLength(27);
    expect(result.events.filter(event => event.provider_code === 'LDGOBF')).toHaveLength(1);
    const back = read(SIX, { [AT_CONSIGNEE]: reply => {
      reply.trackingList.unshift({ ...reply.trackingList[0]!, mvntDt: '20261114', rkCode: 'GTIIBE', rk: 11, cntrStsCd: 'GTI', feCatCd: 'E' });
    } });
    expect(back).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-11-14T18:39:00-08:00' });
    const consignee = kmtcMoves(fixture(detailOf(AT_CONSIGNEE)), { container: AT_CONSIGNEE, bill: SIX, booking: 'KR04509426' });
    const unasked = kmtcResult(kmtcContainers(fixture(`search-${SIX}`), kmtcQuery(SIX)), new Map([[AT_CONSIGNEE, consignee]]));
    expect(unasked).toMatchObject({ current_stage: 'out_for_delivery', history_truncated: true });
  });

  it('reads a booking\'s containers under their bill, and a container listed under several bookings', () => {
    const query = kmtcQuery(BOOKING);
    expect(kmtcContainers(fixture(`search-${BOOKING}`), query)).toEqual([{ container: BOOKING_CONTAINER, bill: BOOKING_BILL, booking: BOOKING }]);
    expect(read(BOOKING)).toMatchObject({ status: 'delivered', last_update: '2026-11-09T23:13:00-08:00' });
    const shared = kmtcContainers(edited<Search>(`search-${BOOKING}`, reply => { reply.cntrList[0]!.bkgNo = `KR00000001<br>${BOOKING}`; }), query)!;
    expect(shared).toHaveLength(1);
    expect(kmtcDetailUrl(query, { container: BOOKING_CONTAINER, bill: '', booking: BOOKING }))
      .toBe(`${KMTC_API}/cargo-tracking/${BOOKING}/detail?bkgNo=${BOOKING}&cntrNo=${BOOKING_CONTAINER}&dtKnd=BK&strBkgNo=${BOOKING}`);
  });

  it('reads no containers as missing, a closed search as maintenance, and a reply for another number as changed', () => {
    expect(kmtcContainers(NOTHING, kmtcQuery('ZZZ9999999'))).toBeNull();
    expect(() => kmtcResult(null)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => kmtcContainers({ ...NOTHING, useYn: 'N' }, kmtcQuery('ZZZ9999999'))).toThrowError(expect.objectContaining({ kind: 'maintenance' }));
    expect(() => kmtcResult(kmtcContainers(fixture(`search-${SINGLE}`), kmtcQuery(SINGLE)), new Map([[SINGLE_CONTAINER, []]])))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    const fails = (reply: unknown, number = SINGLE) => expect(() => kmtcContainers(reply, kmtcQuery(number))).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(fixture(`search-${SIX}`));
    fails(fixture(`search-${SINGLE}`), BOOKING);
    fails({ cntrList: [] });
    fails([]);
    fails(edited<Search>(`search-${SINGLE}`, reply => { reply.cntrList = {} as never; }));
    fails(edited<Search>(`search-${SINGLE}`, reply => { reply.cntrList[0]!.cntrNo = 'TXGU614510'; }));
    fails(edited<Search>(`search-${SINGLE}`, reply => { reply.cntrList[0]!.bkgNo = '<script>'; }));
    expect(kmtcContainers(edited<Search>(`search-${SINGLE}`, reply => { reply.cntrList.push({ ...reply.cntrList[0]! }); }), kmtcQuery(SINGLE))).toHaveLength(1);
    const container: KmtcContainer = { container: SINGLE_CONTAINER, bill: SINGLE, booking: 'KR04510813' };
    const detail = (edit: (reply: Detail) => void, owner = container) =>
      expect(() => kmtcMoves(edited<Detail>(detailOf(SINGLE_CONTAINER), edit), owner)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    detail(() => {}, { ...container, bill: SIX });
    detail(reply => { reply.trackingList[0]!.mvntDt = '20261131'; });
    detail(reply => { reply.trackingList[0]!.mvntDt = '19991113'; });
    detail(reply => { reply.trackingList[0]!.mvntTm = '0001'; });
    detail(reply => { reply.trackingList[0]!.rkCode = ''; });
    detail(reply => { reply.trackingList[0]!.trmlNm = 7; });
    detail(reply => { reply.inlandListIn = {} as never; });
  });

  it('reads Akamai\'s refusal as a challenge, and other pages as a changed reply', () => {
    expect(() => kmtcJson('<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>You don\'t have permission</BODY></HTML>'))
      .toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const body of ['', '<html><body>Maintenance</body></html>', '{"cntrList":[']) {
      expect(() => kmtcJson(body), body).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(kmtcJson('﻿{"useYn":"Y"}')).toEqual({ useYn: 'Y' });
  });
});

// A proof of work shaped like KMTC's, made here with a known answer.
const SALT = '1795000000-0123456789abcdef01234567';
const ANSWER = 4242;
const CHALLENGE = { salt: SALT, challenge: hash('sha256', `${SALT}${ANSWER}`, 'hex'), maxNumber: 100_000, signature: 'c'.repeat(64) };
const TOKEN = `${SALT}.${ANSWER}.${CHALLENGE.challenge}.${CHALLENGE.signature}`;

describe('KMTC proof of work', () => {
  it('finds the number whose hash after the salt is the challenge', async () => {
    const challenge = parseKmtcChallenge(CHALLENGE);
    await expect(solveKmtcChallenge(challenge, new AbortController().signal, performance.now() + 10_000, 10_000)).resolves.toBe(TOKEN);
    await expect(solveKmtcChallenge({ ...challenge, maxNumber: ANSWER - 1 }, new AbortController().signal, performance.now() + 10_000, 10_000))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(solveKmtcChallenge(challenge, new AbortController().signal, performance.now() - 1, 10_000)).rejects.toMatchObject({ kind: 'budget' });
    await expect(solveKmtcChallenge(challenge, AbortSignal.abort(new Error('cancelled')), performance.now() + 10_000, 10_000)).rejects.toThrow('cancelled');
  });

  it('reads a changed challenge as a challenge', () => {
    for (const change of [{ salt: 'a.b-0123456789' }, { salt: 'short' }, { challenge: 'abc' }, { signature: 'C'.repeat(64) }, { maxNumber: 0 }, { maxNumber: 1e7 }, { maxNumber: '100000' }]) {
      expect(() => parseKmtcChallenge({ ...CHALLENGE, ...change }), JSON.stringify(change)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(() => parseKmtcChallenge(null)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const carrier = (fetcher: typeof fetch, recorder?: StepRecorder) =>
  adapter({ fetcher, ...(recorder ? { recorder } : {}), env: {}, trawl: null, browserExecutablePath: null } as Parameters<typeof adapter>[0]);
/** Answers the page's requests from the fixtures, or as KMTC answers a number it does not hold. */
const site = (replies: Record<string, unknown> = {}) => vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith('/pow/challenge')) return json(CHALLENGE);
  if (url.pathname.endsWith('/cargo-tracking/')) {
    if (new Headers(init?.headers).get('pow-token') !== TOKEN) return json({ respcode: 'C9003', respmsg: 'ERR_POW_FAILED' }, 403);
    const name = `search-${(JSON.parse(String(init?.body)) as { blNo: string }).blNo}`;
    return json(replies[name] ?? (FIXTURES.includes(name) ? fixture(name) : NOTHING));
  }
  const name = detailOf(url.searchParams.get('cntrNo')!);
  return json(replies[name] ?? fixture(name));
});
const search = (number: string, kind: 'BL' | 'BK' = 'BL') => [`${KMTC_API}/cargo-tracking/`, JSON.stringify({ dtKnd: kind, blNo: number })];

describe('KMTC adapter', () => {
  it('takes a bill with or without KORP, or a booking, and nothing else', async () => {
    expect(kmtcQuery(' korp pnc 4932614 ')).toEqual({ kind: 'BL', number: SIX });
    expect(kmtcQuery('kr04510826')).toEqual({ kind: 'BK', number: BOOKING });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['KMTCPNC4932614', 'PNC493261', 'PNC49326140', 'KMTU9654910', 'KR0451082', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: SINGLE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('solves the proof of work, then asks for the bill and its container\'s moves as the page does', async () => {
    const fetcher = site();
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, recorder).track({ number: `KORP${SINGLE}` })).resolves.toMatchObject({ current_stage: 'delivered', events: expect.any(Array) });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method, init?.body ?? null])).toEqual([
      [`${KMTC_API}/pow/challenge`, 'GET', null],
      [search(SINGLE)[0], 'POST', search(SINGLE)[1]],
      [kmtcDetailUrl(kmtcQuery(SINGLE), { container: SINGLE_CONTAINER, bill: SINGLE, booking: 'KR04510813' }), 'GET', null],
    ]);
    const headers = new Headers(fetcher.mock.calls[1]![1]!.headers);
    expect(Object.fromEntries(['accept', 'content-type', 'pow-token', 'referer', 'user-agent'].map(name => [name, headers.get(name)]))).toEqual({
      accept: 'application/json, text/plain, */*', 'content-type': 'application/json', 'pow-token': TOKEN, referer: 'https://www.ekmtc.com/', 'user-agent': KMTC_USER_AGENT,
    });
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('pow-token')).toBeNull();
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
  });

  it('asks for a booking, and the moves of a bill\'s first containers only', async () => {
    const booking = site();
    await expect(carrier(booking).track({ number: BOOKING })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(booking.mock.calls[1]![1]!.body).toBe(search(BOOKING, 'BK')[1]);
    expect(String(booking.mock.calls[2]![0])).toBe(kmtcDetailUrl(kmtcQuery(BOOKING), { container: BOOKING_CONTAINER, bill: BOOKING_BILL, booking: BOOKING }));
    const six = site();
    await expect(carrier(six).track({ number: SIX })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(six).toHaveBeenCalledTimes(2 + MAX_DETAILS);
    const many = site({ [`search-${SIX}`]: edited<Search>(`search-${SIX}`, reply => { reply.cntrList.push({ ...reply.cntrList[0]!, cntrNo: 'ZZZU9999992' }); }) });
    await expect(carrier(many).track({ number: SIX })).resolves.toMatchObject({ current_stage: 'out_for_delivery', history_truncated: true });
    expect(many).toHaveBeenCalledTimes(2 + MAX_DETAILS);
  });

  it('reads a number KMTC does not hold as not found, and refusals by their kind', async () => {
    await expect(carrier(site()).track({ number: 'ZZZ9999999' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site()).track({ number: 'ZZ99999999' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site({ 'search-ZZZ9999999': { ...NOTHING, useYn: 'N' } })).track({ number: 'ZZZ9999999' })).rejects.toMatchObject({ kind: 'maintenance' });
    const refused = async () => new Response('<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>', { status: 403 });
    await expect(carrier(refused).track({ number: SINGLE })).rejects.toMatchObject({ kind: 'challenge' });
    const wrongToken = site();
    wrongToken.mockImplementationOnce(async () => json({ ...CHALLENGE, signature: 'd'.repeat(64) }));
    await expect(carrier(wrongToken).track({ number: SINGLE })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(async () => new Response('', { status: 429 })).track({ number: SINGLE })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('asks once more when a request does not reach KMTC', async () => {
    const fixtures = site();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(fixtures);
    await expect(carrier(fetcher).track({ number: SINGLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('is asked when the number is filed under KMTC', async () => {
    await expect(createTracker({ providers: [], env: {}, fetcher: site() }).track({ number: SINGLE, carrier: 'kmtc' }, { budgetMs: 5000 }))
      .resolves.toMatchObject({ carrier: 'kmtc', source: 'kmtc', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('kmtc').tracking).toMatchObject({ adapter: 'kmtc', localClocks: true });
  });
});

describe('KMTC status vocabulary', () => {
  it('stages each move the replies give, by its kind, leg and load', () => {
    for (const entry of statuses.entries) {
      expect(kmtcWording(entry.code), entry.code).toBe(entry.wording);
      expect(kmtcStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'kmtc', providerCode: entry.code, description: entry.wording }).kind, entry.code).toBe('mapped');
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
    }
    expect([kmtcWording('DISTSF'), kmtcStage('DISTSF')]).toEqual(['Discharging Full (Transshipment)', 'in_transit']);
    expect([kmtcWording('GTIIDE'), kmtcStage('GTIIDE')]).toEqual(['Gate In Empty (Depot)', undefined]);
    expect([kmtcWording('LDGOBE'), kmtcStage('LDGOBE')]).toEqual(['Loading Empty (Export)', undefined]);
    expect([kmtcWording('XYZ'), kmtcStage('XYZ')]).toEqual(['XYZ', undefined]);
  });
});
