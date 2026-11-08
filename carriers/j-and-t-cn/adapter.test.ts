import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { activeRequirements } from '../../core/catalog/index.js';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InputRequiredError, NoHistoryError, UpstreamHttpError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, J_AND_T_CN_API, J_AND_T_CN_SCANS_API, J_AND_T_CN_SIGNING_SALT, jAndTCnSignedHeaders, JAndTCnTracker } from './adapter.js';
import { jAndTCnAnswer, normalizeJAndTCnNumber, parseJAndTCn } from './parser.js';

const NUMBER = 'JT9000000000017';
// Made-up phone digits: no test reaches the site.
const DIGITS = '0042';

type Row = Record<string, unknown>;
type Reply = Row & { data: (Row & { details: Row[] })[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** A transport answering the first stage and the second, each from its own reply. */
const site = (first: () => Response | Promise<Response>, second: () => Response | Promise<Response> = () => reply(fixture('second-stage'))) =>
  vi.fn<typeof fetch>(async (input) => (String(input).startsWith(J_AND_T_CN_SCANS_API) ? second() : first()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const parsed = (body: unknown) => parseJAndTCn(jAndTCnAnswer(body, NUMBER), NUMBER);
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

describe('J&T Express China HTTP adapter', () => {
  it('asks the page’s lookup for the whole waybill with the phone digits, signed as the page signs it, through the supplied transport', async () => {
    const fetcher = site(() => reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JAndTCnTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch({ number: ' jt 9000-0000-0001 7 ', phoneDigits: ` ${DIGITS} ` }, { budgetMs: 3000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(url);
    expect(`${asked.origin}${asked.pathname}`).toBe(J_AND_T_CN_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ waybillList: NUMBER, randstr: '', ticket: '', phoneLast: DIGITS });
    const headers = init.headers as Record<string, string>;
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(headers.times).toMatch(/^\d{13}$/);
    expect(headers.sign).toBe(md5(md5(`${J_AND_T_CN_SIGNING_SALT}${headers.times}`)));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'j-and-t-cn', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('signs a time with MD5 of MD5 of the page’s salt and the time', () => {
    expect(jAndTCnSignedHeaders(1_700_000_000_000)).toEqual({ times: '1700000000000', sign: md5(md5(`${J_AND_T_CN_SIGNING_SALT}1700000000000`)) });
  });

  it.each([undefined, null, '', '  ', '123', '12345', 'abcd'])('asks for the phone digits without a request when given %j', async (phoneDigits) => {
    const fetcher = site(() => reply(fixture('delivered')));
    const failure = await carrier(fetcher).track({ number: NUMBER, phoneDigits }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InputRequiredError);
    expect(failure).toMatchObject({ kind: 'input_required', field: 'phoneDigits' });
    expect((failure as Error).message).toMatch(/last four digits/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads each scan’s Beijing time as an instant and its status, once, without the people, phones, places or pictures', () => {
    const result = parsed(fixture('delivered'));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收', last_update: '2026-05-14T16:42:10+08:00', delivered_at: '2026-05-14T16:42:10+08:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.description, event.stage, event.stage_source])).toEqual([
      ['2026-05-14T16:42:10+08:00', '已签收', 'delivered', 'carrier_map'],
      ['2026-05-14T09:05:33+08:00', '派件中', 'out_for_delivery', 'carrier_map'],
      // The repeated arrival is kept once.
      ['2026-05-13T22:18:02+08:00', '运送中', 'in_transit', 'carrier_map'],
      ['2026-05-12T19:47:51+08:00', '运送中', 'in_transit', 'carrier_map'],
      ['2026-05-12T11:30:00+08:00', '已揽件', 'accepted', 'carrier_map'],
    ]);
    expect(result.events!.every((event) => event.location === undefined && event.local_time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/示例|样本|13000000000|example\.invalid|SYNTHETIC/);
  });

  it('reads a scan without a status by its sentence, without the people, phones or bracketed text it names', () => {
    const result = parsed(changed('delivered', (body) => {
      body.data[0]!.details = body.data[0]!.details.slice(0, 2).map((row) => ({ ...row, status: null }));
    }));
    expect(result.events!.map((event) => event.description)).toEqual(['您的快件已签收，签收人。如有疑问请电联快递员', '的快递员正在为您派件']);
    expect(JSON.stringify(result)).not.toMatch(/示例|样本|13000000000/);
    // A sentence left with nothing is no scan.
    expect(() => parsed(changed('delivered', (body) => {
      body.data[0]!.details = [{ scanTime: '2026-05-14 16:42:10', status: null, customerTracking: '【示例快递员 13000000000】' }];
    }))).toThrow(NoHistoryError);
  });

  it('asks the second stage, with the answer’s code, for the scans of an answer that lists none, and keeps the code out of diagnostics', async () => {
    const fetcher = site(() => reply(fixture('without-scans')));
    const result = await carrier(fetcher).track({ number: NUMBER, phoneDigits: DIGITS });
    expect(result.events!.map((event) => [event.time, event.description])).toEqual([
      ['2026-07-01T17:03:09+08:00', '运送中'], ['2026-07-01T09:00:00+08:00', '已揽件'],
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const asked = new URL(String(fetcher.mock.calls[1]![0]));
    expect(`${asked.origin}${asked.pathname}`).toBe(J_AND_T_CN_SCANS_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ waybillList: NUMBER, code: 'SYNTHETICSTAGECODE' });
    expect((fetcher.mock.calls[1]![1]!.headers as Record<string, string>).sign).toMatch(/^[0-9a-f]{32}$/);
    // The second stage refused: its diagnostics keep neither the code nor the digits.
    const refused = site(() => reply(fixture('without-scans')), () => Object.defineProperty(reply({}, { status: 403 }), 'url',
      { value: `${J_AND_T_CN_SCANS_API}?waybillList=${NUMBER}&code=SYNTHETICSTAGECODE` }));
    const failure = await carrier(refused).track({ number: NUMBER, phoneDigits: DIGITS }).catch((error: unknown) => error) as UpstreamHttpError;
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(JSON.stringify([failure.request, failure.diagnostics])).not.toMatch(/SYNTHETICSTAGECODE|0042/);
    // A second stage without scans leaves a waybill J&T knows without history.
    const empty = site(() => reply(fixture('without-scans')), () => reply(changed('second-stage', (body) => { body.data[0]!.details = []; })));
    await expect(carrier(empty).track({ number: NUMBER, phoneDigits: DIGITS })).rejects.toBeInstanceOf(NoHistoryError);
  });

  it('reads the reply’s refusals by their codes', async () => {
    const failure = (body: unknown) => carrier(site(() => reply(body))).track({ number: NUMBER, phoneDigits: DIGITS });
    // Digits that are not the parcel's, or a waybill J&T does not know: the same reply, which asks for the digits again.
    const refused = await failure(fixture('digits-refused')).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InputRequiredError);
    expect(refused).toMatchObject({ kind: 'input_required', field: 'phoneDigits', reason: 'phone_digits_mismatch' });
    expect(JSON.stringify({ ...refused as object, message: (refused as Error).message })).not.toContain(DIGITS);
    // An answer that leaves the waybill out is one the page reports as not found.
    await expect(failure({ code: 1, data: [] })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(failure({ code: 149000017, msg: '请求不合法' })).rejects.toMatchObject({ kind: 'schema' });
    await expect(failure({ code: 135000000, msg: '访问过于频繁' })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(failure({ code: 135000001, msg: '系统繁忙' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(failure({ msg: 'success' })).rejects.toMatchObject({ kind: 'schema' });
    // An answer without scans and without a second-stage code has no history.
    await expect(failure(changed('without-scans', (body) => { delete body.data[0]!.code; }))).rejects.toBeInstanceOf(NoHistoryError);
  });

  it('refuses an answer for another waybill, several answers and malformed scans', () => {
    expect(() => parsed(changed('delivered', (body) => { body.data[0]!.keyword = 'JT9000000000024'; })))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsed(changed('delivered', (body) => { body.data.push({ ...body.data[0]! }); })))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (body: Reply) => { body.data[0]!.details[0]!.scanTime = '2026-05-14 24:00:00'; },
      (body: Reply) => { body.data[0]!.details[0]!.status = 7; },
      (body: Reply) => { body.data[0]!.details = 'none' as unknown as Row[]; },
      (body: Reply) => { body.data[0]!.keyword = ''; },
    ]) {
      expect(() => parsed(changed('delivered', change))).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a page in place of the reply as a challenge, and a moved route as a transport failure', async () => {
    const tracked = (response: () => Response) => carrier(site(response)).track({ number: NUMBER, phoneDigits: DIGITS });
    await expect(tracked(() => new Response('<html><script>var acw_sc__v2</script></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracked(() => new Response('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(tracked(() => new Response(null, { status: 302, headers: { Location: '/elsewhere' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('keeps the phone digits out of the diagnostics of a refused request', async () => {
    const asked = vi.fn<typeof fetch>(async (input) => Object.defineProperty(reply({}, { status: 403 }), 'url', { value: String(input) }));
    const failure = await carrier(asked).track({ number: NUMBER, phoneDigits: DIGITS }).catch((error: unknown) => error) as UpstreamHttpError;
    expect(failure.request?.url).toContain('phoneLast=[redacted]');
    expect(JSON.stringify([failure.message, failure.request, failure.diagnostics])).not.toContain(DIGITS);
  });

  it('takes JT or UT and thirteen digits, and puts JT before thirteen bare digits as the page does', () => {
    expect(normalizeJAndTCnNumber(' jt 9000-0000-0001 7 ')).toBe(NUMBER);
    expect(normalizeJAndTCnNumber('9000000000017')).toBe(NUMBER);
    expect(normalizeJAndTCnNumber('ut9000000000017')).toBe('UT9000000000017');
    for (const number of ['JT900000000001', 'JT90000000000170', 'JMX900000000017', '900000000001']) {
      expect(() => normalizeJAndTCnNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('offers the phone digits as an optional input of four digits', () => {
    expect(activeRequirements('j-and-t-cn', NUMBER)).toMatchObject([{ field: 'phoneDigits', validator: 'phoneLastFour',
      optional: true, showsMore: true, pattern: '^[0-9]{4}$', maxLength: 4, inputMode: 'numeric' }]);
    expect(normalizeCarrierInputs('j-and-t-cn', NUMBER, '', '', DIGITS)).toEqual({ trackingUrl: null, postcode: null, phoneDigits: DIGITS });
    expect(() => normalizeCarrierInputs('j-and-t-cn', NUMBER, '', '', '00 42')).toThrow('J&T Express China takes the last four digits of a phone number');
  });

  it('answers its statuses from its map', () => {
    expect(statusMapAnswer({ carrier: 'j-and-t-cn', providerCode: null, description: '已签收' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'j-and-t-cn', providerCode: null, description: '已代收' })).toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});
