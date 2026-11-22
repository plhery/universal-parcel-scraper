import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording, statusGapNote } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, WOORI_LOOKUP } from './adapter.js';
import { normalizeWooriNumber, parseWoori, wooriClock } from './parser.js';
import { statusMap, wooriStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples whose replies are `delivered.json` and `listed-without-events.json`.
const SAMPLE = '5026148326';
const LISTED = '5020389636';
// Synthetic, far beyond the range in use: `not-found.json` answers it, and the reply names no number.
const UNKNOWN = '9999999999';
// Invented: another waybill of the same shape.
const OTHER = '5099999991';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string | null, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const failure = (run: () => unknown) => { try { run(); } catch (error) { return error; } return undefined; };

type Json = Record<string, unknown>;
/** The public sample's reply, changed by `edit`. */
const delivered = (edit: (payload: Json, shipment: Json) => void = () => undefined): string => {
  const payload = JSON.parse(fixture('delivered')) as Json;
  edit(payload, (payload.ODS0 as Json[])[0]!);
  return JSON.stringify(payload);
};
/** The public sample's reply with only these scans, oldest first as the tracker lists them. */
const withScans = (...scans: Json[]) => delivered((_payload, shipment) => { shipment.TRACKING_DTL = scans; });
/** A scan at an invented branch. */
const scan = (step: string, clock: string, fields: Json = {}): Json => ({
  SCAN_AGY_TEL_NO: '0310000000', SCAN_NO: `${SAMPLE}01`, SCANGB_NM: step, SCAN_USER_ID: '0000', SCAN_USER_NM: '예시지점',
  SCANGB: '00', SCAN_DM: clock, SCAN_AGY_NM: '예시지점', SCAN_AGY_ID: '0000', ...fields,
});

describe('Woori Taekbae numbers', () => {
  it('takes ten to fourteen digits, as the tracking page asks', () => {
    expect(normalizeWooriNumber(` ${SAMPLE.slice(0, 4)}-${SAMPLE.slice(4)} `)).toBe(SAMPLE);
    expect(normalizeWooriNumber('50999999910001')).toBe('50999999910001');
    for (const other of ['', '509999999', '509999999100011', '50999A9991', 'X'.repeat(70)]) {
      expect(() => normalizeWooriNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Woori Taekbae tracking adapter', () => {
  it('posts the number to the page’s lookup over HTTP, with the lookup’s signal and the host’s User-Agent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: ` ${SAMPLE} ` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://www.honamlogis.co.kr/tracking_number.php');
    expect(WOORI_LOOKUP).toBe(String(url));
    expect(init).toMatchObject({
      method: 'POST', body: `SLIP_BARCD=${SAMPLE}`, redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': expect.any(String) }),
    });
    const named = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    await adapter({ fetcher: named, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'Host/1.0' }).track({ number: SAMPLE });
    expect(named.mock.calls[0]![1]).toMatchObject({ headers: expect.objectContaining({ 'User-Agent': 'Host/1.0' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'woori-taekbae', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number Woori Taekbae does not issue without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '50123' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads only the tracker’s own empty answer as not found', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('not-found')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, verification pages, error pages, moved routes and other replies apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => reply('', { status: 429, headers: { 'Retry-After': '30' } }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => reply('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => reply('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => reply('<div class="g-recaptcha" data-sitekey="example"></div>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => reply('<title>Error</title>', { status: 500 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => reply('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    for (const status of [404, 410]) expect(await answer(() => reply('<h1>Not Found</h1>', { status }))).toMatchObject({ kind: 'transport', status });
    expect(await answer(() => reply(null, { status: 302, headers: { Location: 'https://www.honamlogis.co.kr/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => reply(''))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('<br />\n<b>Warning</b>: mysqli_connect(): Too many connections'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('{"MSG_ID":"9999","ODS0_TOTAL":0,"ODS0":[]}'))).toMatchObject({ kind: 'indeterminate' });
  });

  it('reads once more after a network failure, and ends with the budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(async () => reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: SAMPLE }, { budgetMs: 5000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const hanging = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = performance.now();
    const ended = await carrier(hanging).track({ number: SAMPLE }, { budgetMs: 50 }).catch((error: unknown) => error);
    // The request's own timeout and the lookup's deadline end together; either way the lookup stops with its budget.
    expect(ended).toMatchObject({ kind: expect.stringMatching(/^(?:budget|transport)$/) });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(hanging.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('Woori Taekbae replies', () => {
  it('reads the public sample: wall clocks newest first, the branch as the place, the delivery', () => {
    const result = parseWoori(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '배송완료', last_update: null, last_update_local: '2025-04-26T13:07:26', expected_delivery: null,
    });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2025-04-26T13:07:26', '90', '배송완료', '김해', 'delivered'],
      ['2025-04-26T11:07:26', '60', '배송중', '김해', 'out_for_delivery'],
      ['2025-04-26T09:07:26', '50', '영업소출고', '김해', 'in_transit'],
      ['2025-04-26T08:09:28', '80', '영업소입고', '김해', 'in_transit'],
      ['2025-04-26T06:09:28', '40', 'HUB T/M도착', '허브터미널', 'in_transit'],
      ['2025-04-25T00:07:45', '30', 'T/M출고', '터미널', 'in_transit'],
      ['2025-04-24T15:41:44', '10', '집하상차', '동일산', 'accepted'],
      ['2025-04-24T13:15:03', '05', '상품준비중', '동일산', 'registered'],
    ]);
    expect(result.events![0]).toEqual({
      local_time: '2025-04-26T13:07:26', description: '배송완료', provider_code: '90', location: '김해', stage: 'delivered', stage_source: 'carrier_map',
    });
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps the customers, the phones, the goods and the scan’s user out of the result', () => {
    const text = JSON.stringify(parseWoori(fixture('delivered'), SAMPLE));
    const shipment = (JSON.parse(fixture('delivered')) as { ODS0: Json[] }).ODS0[0]!;
    const scans = shipment.TRACKING_DTL as Json[];
    // The users that are not also a branch's name: the shipper and a terminal's scanner.
    const users = scans.map((row) => String(row.SCAN_USER_NM)).filter((user) => !scans.some((row) => String(row.SCAN_AGY_NM).includes(user)));
    expect(users).toEqual(['(주)자출사', '신갈터미널06']);
    for (const value of [shipment.S_AGY_TEL_NO, shipment.R_AGY_TEL_NO, shipment.GOODS_NM, shipment.SEND_DT, ...scans.map((row) => row.SCAN_AGY_TEL_NO), ...users]
      .map(String).filter((value) => value.length > 3)) {
      expect(text, value).not.toContain(value);
    }
    expect(text).not.toMatch(/redacted|SCAN_|S_CUST|R_CUST|\d{9,}/);
    // A person's name in the scan's user never shows; a place keeps no phone number and is dropped when it names a person.
    const result = parseWoori(withScans(
      scan('집하상차', '20250424154144', { SCAN_USER_NM: '홍길동', SCAN_AGY_NM: '예시지점(010-0000-0000)' }),
      scan('영업소입고', '20250426080928', { SCAN_USER_NM: '홍길동', SCAN_AGY_NM: '예시 055 000 0000' }),
      scan('배송중', '20250426110726', { SCAN_USER_NM: '홍길동', SCAN_AGY_NM: '홍*동' }),
      scan('배송완료', '20250426130726', { SCAN_USER_NM: '홍길동', SCAN_AGY_NM: '배송기사' }),
    ), SAMPLE);
    expect(result.events!.map((event) => event.location)).toEqual([undefined, undefined, '예시', '예시지점']);
    expect(JSON.stringify(result)).not.toMatch(/홍|000/);
  });

  it('keeps a wall clock in local_time, and text that does not read as one in provider_time_text', () => {
    expect(wooriClock('20250426130726')).toEqual({ local_time: '2025-04-26T13:07:26' });
    expect(wooriClock('20240229000000')).toEqual({ local_time: '2024-02-29T00:00:00' });
    expect(wooriClock('20251231235959')).toEqual({ local_time: '2025-12-31T23:59:59' });
    for (const text of ['20250229120000', '20251301120000', '20250400120000', '20250426240000', '20250426126000', '20250426120060',
      '2025042613072', '202504261307261', '2025-04-26 13:07:26', '2025-04-26 13:07']) {
      expect(wooriClock(text), text).toEqual({ provider_time_text: text });
    }
    expect(wooriClock('')).toEqual({});
  });

  it('turns the oldest-first scans newest first and sorts them stably, keeping a scan without a clock under the scan above it', () => {
    const result = parseWoori(withScans(
      scan('상품준비중', '20250424131503'),
      scan('집하상차', '20250424131503'),
      scan('T/M출고', 'yesterday'),
      scan('HUB T/M도착', '20250426060928'),
      scan('배송완료', '20250426130726'),
      scan('배송완료', '20250426130726'),
      scan('배송중', '20250426110726'),
    ), SAMPLE);
    expect(result.events!.map((event) => [event.local_time ?? event.provider_time_text, event.description])).toEqual([
      ['2025-04-26T13:07:26', '배송완료'], ['2025-04-26T11:07:26', '배송중'], ['2025-04-26T06:09:28', 'HUB T/M도착'],
      ['yesterday', 'T/M출고'], ['2025-04-24T13:15:03', '집하상차'], ['2025-04-24T13:15:03', '상품준비중'],
    ]);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2025-04-26T13:07:26' });
    const untimed = parseWoori(withScans(scan('집하상차', '20250424154144'), scan('배송완료', 'today')), SAMPLE);
    expect(untimed.events![0]).toMatchObject({ provider_time_text: 'today', description: '배송완료', stage: 'delivered' });
    expect(untimed.last_update_local).toBe('2025-04-24T15:41:44');
  });

  it('stages out for delivery apart from a delivery, and leaves a scan it does not know without a stage', () => {
    const collected = scan('집하상차', '20250424154144');
    expect(parseWoori(withScans(collected, scan('배송중', '20250426110726')), SAMPLE))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    expect(parseWoori(withScans(collected, scan('노선하차', '20250426060928')), SAMPLE)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(parseWoori(withScans(collected, scan('배송출발', '20250426090000')), SAMPLE)).toMatchObject({ current_stage: 'out_for_delivery' });
    // A step the map does not know after a delivery may undo it: the parcel's stage stays open.
    const after = parseWoori(withScans(collected, scan('배송완료', '20250426130726'), scan('반송', '20250427090000')), SAMPLE);
    expect(after.status).toBe('unknown');
    expect(after).not.toHaveProperty('current_stage');
    expect(after.events![0]).toEqual({ local_time: '2025-04-27T09:00:00', description: '반송', provider_code: '00', location: '예시지점' });
    // Before a delivery, the newest staged scan leads.
    expect(parseWoori(withScans(collected, scan('보류', '20250425090000')), SAMPLE)).toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
  });

  it('binds the reply to the number asked', () => {
    expect(failure(() => parseWoori(fixture('delivered'), OTHER))).toMatchObject({ kind: 'indeterminate' });
    expect(failure(() => parseWoori(fixture('listed-without-events'), SAMPLE))).toMatchObject({ kind: 'indeterminate' });
    expect(failure(() => parseWoori(fixture('listed-without-events'), SAMPLE))).not.toHaveProperty('reason', 'listed');
    expect(failure(() => parseWoori(fixture('not-found'), UNKNOWN))).toMatchObject({ kind: 'not_found' });
    expect(failure(() => parseWoori(fixture('not-found'), SAMPLE))).toMatchObject({ kind: 'not_found' });
    expect(failure(() => parseWoori(delivered((_payload, shipment) => { delete shipment.SLIP_BARCD; }), SAMPLE))).toMatchObject({ kind: 'schema' });
    expect(failure(() => parseWoori(delivered((_payload, shipment) => { shipment.SLIP_BARCD = Number(SAMPLE); }), SAMPLE))).toMatchObject({ kind: 'schema' });
    const twice = delivered((payload) => { payload.ODS0_TOTAL = 2; payload.ODS0 = [...(payload.ODS0 as Json[]), ...(payload.ODS0 as Json[])]; });
    expect(failure(() => parseWoori(twice, SAMPLE))).toMatchObject({ kind: 'indeterminate' });
  });

  it('reads a listed shipment without scans as no history, and refuses a changed reply', () => {
    expect(failure(() => parseWoori(fixture('listed-without-events'), LISTED))).toMatchObject({ kind: 'indeterminate', reason: 'listed' });
    expect(failure(() => parseWoori('{"MSG_ID":"9999","ODS0_TOTAL":0,"ODS0":[]}', UNKNOWN))).toMatchObject({ kind: 'indeterminate' });
    for (const body of [
      '', 'null', '[]', '{}', '<html><body>Service Unavailable</body></html>',
      '{"MSG_ID":0,"ODS0_TOTAL":0,"ODS0":[]}', '{"MSG_ID":"0000","ODS0_TOTAL":1,"ODS0":[]}', '{"MSG_ID":"0000","ODS0_TOTAL":"0","ODS0":[]}',
      '{"MSG_ID":"0000","ODS0_TOTAL":0}', '{"MSG_ID":"0000","ODS0_TOTAL":0,"ODS0":[],"MSG":"error"}',
      delivered((payload) => { payload.ODS0 = [null]; }),
      delivered((_payload, shipment) => { delete shipment.TRACKING_DTL; }),
      withScans(null as unknown as Json),
      withScans(scan('', '20250426130726')),
      withScans(scan('배송완료', '20250426130726', { SCANGB_NM: 90 })),
      withScans(scan('배송완료', '20250426130726', { SCANGB: '9 0' })),
      withScans(scan('배송완료', '20250426130726', { SCAN_DM: 20250426130726 })),
      withScans(...Array.from({ length: 301 }, (_, index) => scan('영업소입고', `2025042613${String(index % 60).padStart(2, '0')}00`))),
    ]) expect(failure(() => parseWoori(body, SAMPLE)), body.slice(0, 80)).toMatchObject({ kind: 'schema' });
  });

  it('answers each step statuses.json records by its stage, whatever its code', () => {
    for (const { wording, stage } of statuses.entries as { wording: string; stage?: string }[]) {
      // Hangul, Latin capitals, a slash and single spaces, as the reply gives them: no hidden characters.
      expect(wording, wording).toMatch(/^[\p{Script=Hangul}A-Z/]+(?: [\p{Script=Hangul}A-Z/]+)*$/u);
      expect(wording.normalize('NFC')).toBe(wording);
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
      expect(statusMap.stage('99', normalizeStatusWording(wording)), wording).toBe(stage);
      expect(statusGapNote(statusMap, null, normalizeStatusWording(wording))).toBeUndefined();
    }
    // Every step of the public sample is recorded with its code.
    const recorded = new Set((statuses.entries as { code?: string; wording: string }[]).map((entry) => `${entry.code} ${entry.wording}`));
    for (const row of (JSON.parse(fixture('delivered')) as { ODS0: { TRACKING_DTL: Json[] }[] }).ODS0[0]!.TRACKING_DTL) {
      expect(recorded.has(`${String(row.SCANGB)} ${String(row.SCANGB_NM)}`), String(row.SCANGB_NM)).toBe(true);
    }
    expect(wooriStage('배송중')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(wooriStage('반송')).toBeNull();
    expect(statusMap.stage(null, '반송')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});
