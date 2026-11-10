import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { activeRequirements } from '../../core/catalog/index.js';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { InputRequiredError, NoHistoryError, UpstreamHttpError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { UniversalTracker } from '../../providers/universal.js';
import { adapter, J_AND_T_MX_API, JAndTMxTracker } from './adapter.js';
import { normalizeJAndTMxNumber, parseJAndTMx } from './parser.js';

const DELIVERED = 'JMX900000000017';
// Made-up phone digits: no test reaches the site.
const DIGITS = '0042';

type Row = Record<string, unknown>;
type Reply = Row & { data: Row & { details: Row[] } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const changed = (name: string, change: (reply: Reply) => void) => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const site = (answer: () => Response | Promise<Response>) => vi.fn<typeof fetch>(async () => answer());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('J&T Express Mexico HTTP adapter', () => {
  it('asks the page’s lookup for the whole waybill with the phone digits, in Spanish, through the supplied transport', async () => {
    const fetcher = site(() => reply(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JAndTMxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch({ number: ' jmx 9000-0000-0017 ', phoneDigits: ` ${DIGITS} ` }, { budgetMs: 3000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(url);
    expect(`${asked.origin}${asked.pathname}`).toBe(J_AND_T_MX_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ waybillNo: DELIVERED, langType: 'ES', phoneVerify: DIGITS });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', langType: 'ES', timezone: 'GMT-0600', token: '',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'j-and-t-mx', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('asks in the reader’s language when the page has it', async () => {
    for (const [language, langType] of [['en-MX', 'EN'], ['zh-CN', 'CN'], ['es', 'ES'], ['fr', 'ES']] as const) {
      const fetcher = site(() => reply(fixture('in-transit')));
      await carrier(fetcher).track({ number: DELIVERED, phoneDigits: DIGITS, language });
      const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
      expect(new URL(url).searchParams.get('langType'), language).toBe(langType);
      expect((init.headers as Record<string, string>).langType).toBe(langType);
    }
  });

  it.each([undefined, null, '', '  ', '123', '12345', 'abcd', '１２３４'])('asks for the phone digits without a request when given %j', async (phoneDigits) => {
    const fetcher = site(() => reply(fixture('in-transit')));
    const failure = await carrier(fetcher).track({ number: DELIVERED, phoneDigits }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InputRequiredError);
    expect(failure).toMatchObject({ kind: 'input_required', field: 'phoneDigits' });
    expect((failure as Error).message).toMatch(/last four digits/);
    expect((failure as InputRequiredError).reason).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads each scan’s time as an instant at Mexico City’s offset, its label and the place its sentence starts with, once, without the people or phones', () => {
    const result = parseJAndTMx(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'Entregado', last_update: '2026-05-14T16:42:10-06:00', delivered_at: '2026-05-14T16:42:10-06:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2026-05-14T16:42:10-06:00', 'Entregado', 'Sample City Branch', 'delivered'],
      ['2026-05-14T09:05:33-06:00', 'En ruta de entrega', 'Sample City Branch', 'out_for_delivery'],
      // The repeated arrival is kept once.
      ['2026-05-13T22:18:02-06:00', 'En tránsito', 'Sample City Hub', 'in_transit'],
      ['2026-05-12T19:47:51-06:00', 'En tránsito', 'Origin Town Hub', 'in_transit'],
      // A label neither the map nor the wording rules know has no stage.
      ['2026-05-12T11:30:00-06:00', 'Recolectado', 'Origin Town Branch', undefined],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.provider_code === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Courier|Recipient|5500000000|Recibió|mensajero|Origin Town"|Sample City"/);
  });

  it('reads a place in square brackets, and no place where the sentence starts with a phone', () => {
    const result = parseJAndTMx(fixture('in-transit'), DELIVERED);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'En tránsito',
      last_update: '2026-07-02T06:12:40-06:00' });
    expect(result.events!.map((event) => event.location)).toEqual(['Sample City Hub', 'Origin Town Hub', undefined]);
    expect(JSON.stringify(result)).not.toMatch(/5500000000|Courier/);
  });

  it('orders the scans by their instants, newest first', () => {
    const result = parseJAndTMx(changed('delivered', (body) => body.data.details.reverse()), DELIVERED);
    expect(result.events!.map((event) => event.time)).toEqual(['2026-05-14T16:42:10-06:00', '2026-05-14T09:05:33-06:00',
      '2026-05-13T22:18:02-06:00', '2026-05-12T19:47:51-06:00', '2026-05-12T11:30:00-06:00']);
  });

  it('lets no newer unstaged scan keep an older delivery', () => {
    const result = parseJAndTMx(changed('delivered', (body) => {
      body.data.details.unshift({ scanTime: '2026-05-15 10:00:00', status: 'Sample status', customerTracking: '【Sample City Branch】Sample note' });
    }), DELIVERED);
    expect(result.current_stage).not.toBe('delivered');
    expect(result.status).not.toBe('delivered');
  });

  it('reads the reply’s refusals by their codes', async () => {
    const failure = (body: unknown) => carrier(site(() => reply(body))).track({ number: DELIVERED, phoneDigits: DIGITS });
    // An unknown waybill is not found, whatever the digits.
    await expect(failure(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    // Digits that are not the parcel's ask for them again.
    const refused = await failure(fixture('digits-refused')).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InputRequiredError);
    expect(refused).toMatchObject({ kind: 'input_required', field: 'phoneDigits', reason: 'phone_digits_mismatch' });
    expect(JSON.stringify({ ...refused as object, message: (refused as Error).message })).not.toContain(DIGITS);
    await expect(failure({ code: 999001010, msg: '参数不全', succ: false })).rejects.toMatchObject({ kind: 'schema' });
    await expect(failure({ code: 135000000, msg: 'Too many requests', succ: false })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(failure({ code: 135000001, msg: '系统繁忙', succ: false })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(failure({ data: {} })).rejects.toMatchObject({ kind: 'schema' });
    await expect(failure(changed('delivered', (body) => { body.data.details = []; }))).rejects.toBeInstanceOf(NoHistoryError);
  });

  it('refuses an answer for another waybill and malformed scans', () => {
    expect(() => parseJAndTMx(changed('delivered', (body) => { body.data.waybillNo = 'JMX900000000024'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseJAndTMx(changed('delivered', (body) => { body.data.waybillNo = DELIVERED.toLowerCase(); }), DELIVERED).events).toHaveLength(5);
    for (const change of [
      (body: Reply) => { body.data.details[0]!.scanTime = '2026-05-14 24:00:00'; },
      (body: Reply) => { body.data.details[0]!.scanTime = '2026-05-14T16:42:10Z'; },
      (body: Reply) => { body.data.details[0]!.status = ''; },
      (body: Reply) => { body.data.details[0]!.status = 7; },
      (body: Reply) => { body.data.details = 'none' as unknown as Row[]; },
    ]) {
      expect(() => parseJAndTMx(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a page in place of the reply as a challenge, and a moved route as a transport failure', async () => {
    const tracked = (response: () => Response) => carrier(site(response)).track({ number: DELIVERED, phoneDigits: DIGITS });
    await expect(tracked(() => new Response('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracked(() => new Response('not json'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(tracked(() => new Response('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(tracked(() => new Response(null, { status: 302, headers: { Location: '/elsewhere' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('keeps the phone digits out of the diagnostics of a refused request', async () => {
    const asked = vi.fn<typeof fetch>(async (input) => Object.defineProperty(
      reply({ code: 'FORBIDDEN' }, { status: 403 }), 'url', { value: String(input) }));
    const failure = await carrier(asked).track({ number: DELIVERED, phoneDigits: DIGITS }).catch((error: unknown) => error) as UpstreamHttpError;
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(failure.request?.url).toContain('phoneVerify=[redacted]');
    expect(failure.diagnostics?.response_url).toContain('phoneVerify=[redacted]');
    expect(JSON.stringify([failure.message, failure.request, failure.diagnostics])).not.toContain(DIGITS);
  });

  it('takes JMX and twelve digits only', () => {
    expect(normalizeJAndTMxNumber(' jmx-9000 0000 0017 ')).toBe(DELIVERED);
    for (const number of ['JMX90000000001', 'JMX9000000000170', 'JTE900000000017', '900000000017']) {
      expect(() => normalizeJAndTMxNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'j-and-t-mx', confidence: 'high' });
  });

  it('offers the phone digits as an optional input of four digits, which the catalog validates without repeating them', () => {
    expect(activeRequirements('j-and-t-mx', DELIVERED)).toMatchObject([{ field: 'phoneDigits', validator: 'phoneLastFour',
      optional: true, showsMore: true, pattern: '^[0-9]{4}$', maxLength: 4, inputMode: 'numeric' }]);
    expect(normalizeCarrierInputs('j-and-t-mx', DELIVERED, '', '', ` ${DIGITS} `)).toEqual({ trackingUrl: null, postcode: null, phoneDigits: DIGITS });
    expect(normalizeCarrierInputs('j-and-t-mx', DELIVERED, '', '')).toEqual({ trackingUrl: null, postcode: null, phoneDigits: null });
    for (const digits of ['123', '12345', '12a4']) {
      expect(() => normalizeCarrierInputs('j-and-t-mx', DELIVERED, '', '', digits)).toThrow('J&T Express Mexico takes the last four digits of a phone number');
    }
    expect(() => normalizeCarrierInputs('j-and-t-middle-east', 'JTE300000000002', '', '', DIGITS)).toThrow('Phone digits are not used');
  });

  it('gives the phone digits to its own lookup only: without them the providers are asked, as before', async () => {
    const asked = vi.spyOn(UniversalTracker.prototype, 'fetchSource');
    let refuse = false;
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).startsWith(J_AND_T_MX_API)
      ? reply(fixture(refuse ? 'digits-refused' : 'delivered')) : new Response('unavailable', { status: 503 }));
    const tracker = createTracker({ fetcher, providers: ['ParcelsApp', 'Ship24', '17TRACK'], env: {
      SHIP24_API_KEY: 'synthetic', SEVENTEEN_TRACK_API_KEY: 'synthetic',
    } });
    await expect(tracker.track({ number: DELIVERED, phoneDigits: DIGITS })).resolves.toMatchObject({ carrier: 'j-and-t-mx', source: 'j-and-t-mx',
      result: { status: 'delivered' } });
    expect(fetcher).toHaveBeenCalledOnce();
    const failure = await tracker.track({ number: DELIVERED }).catch((error: unknown) => error) as { attempts: { source: string; kind: string }[] };
    expect(failure.attempts[0]).toMatchObject({ source: 'j-and-t-mx', kind: 'input_required' });
    expect(failure.attempts.length).toBeGreaterThan(1);
    const sent = fetcher.mock.calls.slice(1).map(([input, init]) => JSON.stringify([String(input), init?.body ?? '', init?.headers ?? {}]));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((request) => request.includes(J_AND_T_MX_API))).toBe(false);
    // Refused digits leave the providers to answer, and they are never handed the digits.
    refuse = true;
    const refused = await tracker.track({ number: DELIVERED, phoneDigits: DIGITS }).catch((error: unknown) => error) as typeof failure;
    expect(refused.attempts[0]).toMatchObject({ source: 'j-and-t-mx', kind: 'input_required' });
    expect(asked.mock.calls.length).toBeGreaterThan(1);
    expect(asked.mock.calls.flat().some((value) => typeof value === 'string' && value.includes(DIGITS))).toBe(false);
    await expect(tracker.track({ number: DELIVERED, phoneDigits: '12' })).rejects.toThrow(TypeError);
    asked.mockRestore();
  });

  it('maps no label of its own yet, and reads others by the shared wording rules', () => {
    expect(statusMapAnswer({ carrier: 'j-and-t-mx', providerCode: null, description: 'Entregado' })).toEqual({ kind: 'unknown' });
  });
});
