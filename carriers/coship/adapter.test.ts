import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, COSHIP_LOOKUP } from './adapter.js';
import { normalizeCoshipNumber, parseCoship } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The first public sample in numbers.json, and an invented number the tracker does not know.
const SAMPLE = '6076184085349';
const OTHER = '0000000000000';
// A synthetic waybill for parcels built here.
const SYNTHETIC = '6999999999990';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const ARRIVED = fixture('arrived');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const reply = (...mArray: unknown[]) => ({ resultJson: { mArray } });
const row = (statusCd: string, statusNm: string, stepDt: string, locationNm = '', ProcessStoreName = '') =>
  ({ statusCd, statusNm, stepDt, ProcessStoreName, csInfo: 'SYNTHETIC NOTE', locationNm, memo: 'SYNTHETIC MEMO' });
// A synthetic parcel to Korea in the reply's shape, delivered by Korea Post, with the recipient's
// name and address, the contents and the postman's name.
const parcel = (fields: Record<string, unknown> = {}) => ({
  buyernm: 'SYNTHETIC BUYER', custordno: 'SYNTHETIC-ORDER', hawbno: SYNTHETIC, itemcnt: 2, itemnm: 'SYNTHETIC CONTENTS',
  rcptaddr: 'SYNTHETIC ADDRESS', rcptnm: 'SYNTHETIC RECIPIENT', stepnm: 'NG',
  details: [
    row('', 'Wait for loading', '2030-01-02', 'VANCOUVER'),
    row('', 'Departure', '2030-01-07', 'VANCOUVER AIRPORT'),
    row('', '입항보고 제출', '2030-01-08 10:05', '공항세관'),
    row('', '반입신고', '2030-01-10 21:37', '공항세관'),
    row('', '통관목록심사완료', '2030-01-10 21:37', '공항세관'),
    row('', '반출신고', '2030-01-10 21:37', '공항세관'),
    row('', '접수', '2030-01-11 14:11', '', '국제우편물류센터'),
    row('', '배달준비 집배원 :SYNTHETIC POSTMAN', '2030-01-12 08:08', '', '서울강서우체국'),
    row('', '배달완료 (배달) (수령인:SYNTHETIC RECIPIENT님 - 본인)', '2030-01-12 09:57', '', '서울강서우체국'),
  ],
  ...fields,
});

describe('COSHIP numbers', () => {
  it('takes 6 to 30 letters and digits with at least one digit, in capitals', () => {
    expect(normalizeCoshipNumber(` ${SAMPLE.slice(0, 5)}-${SAMPLE.slice(5)} `)).toBe(SAMPLE);
    expect(normalizeCoshipNumber('cos1234567')).toBe('COS1234567');
    for (const other of ['', '12345', 'ABCDEFGHIJ', `${SAMPLE},${OTHER}`, '6076/184085349', `${'A'.repeat(30)}1`, '1'.repeat(65)]) {
      expect(() => normalizeCoshipNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('COSHIP tracking adapter', () => {
  it('reads the number from the lookup the tracking page reads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(ARRIVED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`${COSHIP_LOOKUP}${SAMPLE}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(carrier(fetcher)).toMatchObject({ id: 'coship', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s blank record as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('does not ask the tracker about an ocean shipment, as the page does not', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'COS1234567' })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps challenges, refusals, redirects and changed replies apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>403 Forbidden</h1>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    // A redirect or a missing route is a moved tracker.
    expect(await answer(() => html('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://www.coship.ca/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{"message":"error"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<!doctype html><html><body>COSHIP</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"resultJson":{}}'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"resultJson":{"mArray":[]}}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('COSHIP replies', () => {
  it('reads the public sample: its rows from Vancouver to Incheon, on their days', () => {
    const result = parseCoship(JSON.parse(ARRIVED), SAMPLE);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: '도착',
      last_update: null, last_update_local: '2021-02-04', expected_delivery: null,
      events: [
        { local_time: '2021-02-04', description: '도착', location: 'INCHEON AIRPORT', provider_code: '02', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2021-02-03', description: '출고', location: 'VANCOUVER AIRPORT', provider_code: '01', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2021-02-01', description: '입고 완료', location: 'VANCOUVER', provider_code: '00', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads a parcel to Korea through customs to Korea Post’s delivery, on its wall clocks, newest first', () => {
    const result = parseCoship(reply(parcel()), SYNTHETIC);
    const events = result.events ?? [];
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '배달완료', last_update_local: '2030-01-12T09:57:00' });
    expect(events.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2030-01-12T09:57:00', '배달완료', '서울강서우체국', 'delivered'],
      ['2030-01-12T08:08:00', '배달준비', '서울강서우체국', 'out_for_delivery'],
      ['2030-01-11T14:11:00', '접수', '국제우편물류센터', 'in_transit'],
      ['2030-01-10T21:37:00', '반출신고', '공항세관', 'in_transit'],
      ['2030-01-10T21:37:00', '통관목록심사완료', '공항세관', 'in_transit'],
      ['2030-01-10T21:37:00', '반입신고', '공항세관', 'customs'],
      ['2030-01-08T10:05:00', '입항보고 제출', '공항세관', 'in_transit'],
      ['2030-01-07', 'Departure', 'VANCOUVER AIRPORT', 'in_transit'],
      ['2030-01-02', 'Wait for loading', 'VANCOUVER', 'accepted'],
    ]);
  });

  it('never reads the recipient, the address, the contents, the order number, the notes or the postman', () => {
    const answer = JSON.stringify(parseCoship(reply(parcel()), SYNTHETIC));
    for (const hidden of ['SYNTHETIC', '수령인', '집배원', '(배달)']) expect(answer).not.toContain(hidden);
  });

  it('reads a number in other spacing as the reply’s, and keeps a step the map does not know visible', () => {
    const result = parseCoship(reply(parcel({ details: [row('', '입고 완료', '2030-01-02', 'VANCOUVER'), row('07', 'Unknown new step', '2030-01-03 11:00', 'VANCOUVER')] })),
      ` ${SYNTHETIC.slice(0, 4)} ${SYNTHETIC.slice(4)}`);
    expect(result).toMatchObject({ current_stage: 'accepted', last_status_text: 'Unknown new step' });
    expect(result.events?.[0]).toEqual({ local_time: '2030-01-03T11:00:00', description: 'Unknown new step', location: 'VANCOUVER', provider_code: '07' });
  });

  it('keeps another shipment’s reply, a listed parcel without rows and a changed row apart from a missing one', () => {
    expect(() => parseCoship(reply(parcel({ hawbno: '6999999999991' })), SYNTHETIC)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCoship(reply(parcel({ details: [] })), SYNTHETIC)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => parseCoship(reply(parcel({ details: [row('00', '입고 완료', '2030-02-30')] })), SYNTHETIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCoship(reply(parcel({ details: [row('00', '입고 완료', '')] })), SYNTHETIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCoship(reply(parcel({ details: [{ ...row('00', '', '2030-01-02'), statusNm: 5 }] })), SYNTHETIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCoship(reply(parcel({ details: 'none' })), SYNTHETIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The page leaves out a row with neither a step nor a time.
    expect(parseCoship(reply(parcel({ details: [row('00', '입고 완료', '2030-01-02'), row('', '', '')] })), SYNTHETIC).events).toHaveLength(1);
  });
});

describe('COSHIP statuses', () => {
  it('maps every wording it records to its stage', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code ?? null, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'coship', providerCode: entry.code, description: entry.wording }), entry.wording).toMatchObject({ stage: entry.stage });
    }
  });
});
