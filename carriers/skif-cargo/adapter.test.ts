import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, SKIF_LOOKUP, SKIF_PAGE, SKIF_PROFILE, SkifTracker } from './adapter.js';
import { normalizeSkifNumber, parseSkif } from './parser.js';
import { skifStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The two public samples, by their digits, and a synthetic number for replies that name none.
const DELIVERED = '161683384';
const OTHER = '946642412';
const UNKNOWN = '000000009';
const TOKEN = 'A'.repeat(32);

type Row = Record<string, unknown>;
type Reply = { order_tracking: Row; points: Row[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Reply;
const changed = (name: string, change: (body: Reply) => void) => {
  const body = fixture(name);
  change(body);
  return body;
};
const html = (body: string, init: ResponseInit = {}, cookies: string[] = []) => new Response(body, { status: 200, ...init,
  headers: [['Content-Type', 'text/html; charset=utf-8'], ...cookies.map((cookie) => ['set-cookie', cookie] as [string, string])] });
// The tracking page clears the old site-wide cookies and sets the one the account check asks for.
const page = (cookies = [
  'csrftoken=""; Domain=.skif-cargo.ru; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; SameSite=Lax; Secure',
  'sessionid=""; Domain=.skif-cargo.ru; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/',
  '_ck_hostonly=1; Max-Age=31536000; Path=/; SameSite=Lax; Secure',
]) => html(`<html><head><meta name="csrf-token" content="${'B'.repeat(64)}"></head>`
  + '<body><form>Подтвердите, что вы не робот.<script src="https://smartcaptcha.yandexcloud.net/captcha.js"></script></form></body></html>', {}, cookies);
const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}, cookies: string[] = []) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: init.status ?? 200, headers: [
    ['Content-Type', 'application/json'], ...Object.entries(init.headers ?? {}), ...cookies.map((cookie) => ['set-cookie', cookie] as [string, string]),
  ] });
// The account check refuses an anonymous visitor, and issues their CSRF cookie with that refusal.
const profile = (cookies = [`csrftoken=${TOKEN}; Max-Age=31449600; Path=/; SameSite=Lax; Secure`]) =>
  json({ status: 401, error: 'Пользователь не авторизован' }, {}, cookies);
const notFound = () => json(text('not-found.json'));
/** A transport that answers the page, the account check, then the lookup with the reply given. */
const site = (lookup: () => Response, steps: { page?: () => Response; profile?: () => Response } = {}) =>
  vi.fn<typeof fetch>(async (url, init) => String(url) === SKIF_PROFILE ? (steps.profile ?? profile)()
    : init?.method === 'POST' ? lookup() : (steps.page ?? page)());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Skif-Cargo HTTP adapter', () => {
  it('opens the page, makes its account check and posts the number with the check\'s token, through the supplied transport', async () => {
    const fetcher = site(() => json(fixture('issued')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SkifTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 16168 - 3384 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    const calls = fetcher.mock.calls as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([[SKIF_PAGE, 'GET'], [SKIF_PROFILE, 'GET'], [SKIF_LOOKUP, 'POST']]);
    expect(calls.every(([, init]) => init.redirect === 'manual' && init.signal instanceof AbortSignal)).toBe(true);
    expect(calls[0]![1].headers).toMatchObject({ 'User-Agent': 'SyntheticHost/1.0' });
    expect(calls[0]![1].headers).not.toHaveProperty('Cookie');
    // The page's cookie goes to the account check; the cleared ones do not.
    expect(calls[1]![1].headers).toMatchObject({ Cookie: '_ck_hostonly=1', 'User-Agent': 'SyntheticHost/1.0' });
    expect(calls[2]![1]).toMatchObject({ body: DELIVERED, headers: {
      'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0', Cookie: `_ck_hostonly=1; csrftoken=${TOKEN}`,
      'X-CSRFToken': TOKEN, Origin: 'https://www.skif-cargo.ru', Referer: SKIF_PAGE,
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'skif-cargo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an issued shipment newest first, its points by their day and the issue on its wall clock', () => {
    const result = parseSkif(fixture('issued'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Груз выдан получателю.', last_update: null, last_update_local: '2022-02-01T14:57:27', expected_delivery: null,
      weight_kg: 443 });
    expect(result.events!.map((event) => [event.local_time, event.location ?? null, event.description, event.stage ?? null])).toEqual([
      ['2022-02-01T14:57:27', 'Ижевск', 'Груз выдан получателю.', 'delivered'],
      ['2022-02-01', 'Ижевск', 'Доставка груза получателю', 'out_for_delivery'],
      ['2022-02-01', 'Ижевск', 'Обработка на складе', 'in_transit'],
      ['2022-01-29', 'Москва', 'Обработка на складе', 'in_transit'],
      ['2022-01-28', 'Обухово п.г.т', 'Забор груза у отправителя', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    expect(result).not.toHaveProperty('planned_events');
    // The parties, the cargo, its volume and pieces, and the price stay out.
    expect(JSON.stringify(result)).not.toMatch(/Импэкс|АССО|Хозтовары|21141|4\.3|Оплачена/);

    const other = parseSkif(fixture('issued-same-day'), OTHER);
    expect(other).toMatchObject({ current_stage: 'delivered', last_update_local: '2022-01-31T12:00:51' });
    expect(other.events!.map((event) => [event.local_time, event.location])).toEqual([
      ['2022-01-31T12:00:51', 'Санкт-Петербург'], ['2022-01-31', 'Санкт-Петербург'], ['2022-01-31', 'Санкт-Петербург'],
      ['2022-01-27', 'Москва'], ['2022-01-27', 'Обухово п.г.т'],
    ]);
  });

  it('keeps the points still ahead as planned steps, the last address\'s day as the expected delivery', () => {
    const moving = parseSkif(changed('issued', (body) => {
      body.points[1]!.point_status = 1;
      body.points[2]!.point_status = 0;
      body.points[3]!.point_status = 0;
      body.order_tracking.CurrCargoState = 'Синтетическое состояние';
      body.order_tracking.CompleteDate = null;
    }), DELIVERED);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Синтетическое состояние',
      last_update_local: '2022-01-29', expected_delivery: '2022-02-01', planned_events: [
        { local_time: '2022-02-01', location: 'Ижевск', description: 'Обработка на складе', stage: 'in_transit' },
        { local_time: '2022-02-01', location: 'Ижевск', description: 'Доставка груза получателю', stage: 'out_for_delivery' },
      ] });
    expect(moving.events!.map((event) => event.description)).toEqual(['Обработка на складе', 'Забор груза у отправителя']);

    // A warehouse last, or a last point without a day, is no expected delivery; nor is a reached delivery point.
    const ahead = (change: (body: Reply) => void) => parseSkif(changed('issued', (body) => {
      body.points[3]!.point_status = 0;
      body.order_tracking.CurrCargoState = '';
      body.order_tracking.CompleteDate = '';
      change(body);
    }), DELIVERED);
    expect(ahead(() => {}).expected_delivery).toBe('2022-02-01');
    expect(ahead((body) => { body.points[3]!.point_type = 1; }).expected_delivery).toBeNull();
    expect(ahead((body) => { body.points[3]!.point_date = null; }).expected_delivery).toBeNull();
    expect(ahead((body) => { body.points[3]!.point_date = null; })).not.toHaveProperty('planned_events');
    expect(ahead((body) => { body.points[3]!.point_status = 1; })).toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: null,
      last_status_text: 'Доставка груза получателю' });
    // Without the issued state, the issue's clock is no scan; with it but no clock, the state still settles the stage.
    expect(ahead((body) => { body.points[3]!.point_status = 1; body.order_tracking.CompleteDate = '01.02.2022 14:57:27'; }).events).toHaveLength(4);
    const undated = parseSkif(changed('issued', (body) => { body.order_tracking.CompleteDate = null; }), DELIVERED);
    expect(undated).toMatchObject({ current_stage: 'delivered', last_update_local: '2022-02-01', expected_delivery: null });
    expect(undated.events).toHaveLength(4);
  });

  it('reads an application without a reached point by its state, and one without a state as listed without history', () => {
    const waiting = (state: string) => parseSkif(changed('issued', (body) => {
      for (const point of body.points) point.point_status = 0;
      body.order_tracking.CurrCargoState = state;
      body.order_tracking.CompleteDate = null;
    }), DELIVERED);
    expect(waiting('В обработке. Ожидайте звонка.')).toMatchObject({ status: 'pending', current_stage: 'registered', summary_only: true,
      last_status_text: 'В обработке. Ожидайте звонка.', expected_delivery: '2022-02-01', events: [] });
    expect(waiting('В обработке. Ожидайте звонка.').planned_events).toHaveLength(4);
    expect(() => waiting('')).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed',
      plannedEvents: expect.arrayContaining([expect.objectContaining({ description: 'Забор груза у отправителя' })]) }));
    // A reached point the page shows without a day has no clock to stand at.
    expect(() => parseSkif(changed('issued', (body) => {
      for (const point of body.points) point.point_date = '';
      body.order_tracking.CurrCargoState = null;
      body.order_tracking.CompleteDate = null;
    }), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked, by its short or full application number', () => {
    expect(() => parseSkif(fixture('issued'), OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Skif-Cargo answered for another shipment' }));
    expect(parseSkif(fixture('issued'), '1519613384').events).toHaveLength(5);
    expect(parseSkif(changed('issued', (body) => { body.order_tracking.OrderShortNo = '161683384'; }), DELIVERED).events).toHaveLength(5);
    expect(() => parseSkif(changed('issued', (body) => { delete body.order_tracking.OrderNo; }), '1519613384'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the tracker\'s empty reply as not found and rejects a changed reply', () => {
    expect(() => parseSkif(JSON.parse(text('not-found.json')), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSkif({ order_tracking: null, points: [fixture('issued').points[0]] }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (body: Reply) => { delete (body as Row).order_tracking; },
      (body: Reply) => { body.order_tracking = 'shipment' as never; },
      (body: Reply) => { body.points = {} as never; },
      (body: Reply) => { body.points = Array.from({ length: 101 }, () => body.points[0]!); },
      (body: Reply) => { delete body.order_tracking.OrderShortNo; },
      (body: Reply) => { body.order_tracking.OrderShortNo = 'ПРИМЕР'; },
      (body: Reply) => { body.order_tracking.OrderNo = '1519613384'; },
      (body: Reply) => { body.points[0] = 'point' as never; },
      (body: Reply) => { body.points[0]!.point_status = '2'; },
      (body: Reply) => { delete body.points[0]!.point_type; },
      (body: Reply) => { body.points[0]!.point_message = ''; },
      (body: Reply) => { body.points[0]!.city_name = ['Москва']; },
      (body: Reply) => { body.points[0]!.point_date = '28.01.2022'; },
      (body: Reply) => { body.points[0]!.point_date = '2022-02-30'; },
      (body: Reply) => { body.order_tracking.CompleteDate = '2022-02-01 14:57:27'; },
      (body: Reply) => { body.order_tracking.CompleteDate = '01.02.2022 24:57:27'; },
      (body: Reply) => { body.order_tracking.CurrCargoState = { text: 'Груз выдан получателю.' }; },
      (body: Reply) => { body.order_tracking.FactWeight = '443'; },
    ]) {
      expect(() => parseSkif(changed('issued', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSkif('reply', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a refused session, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(site(response)).track({ number: UNKNOWN });
    await expect(lookup(notFound)).rejects.toMatchObject({ kind: 'not_found' });
    // Django's refusal of a request without its CSRF cookie, then any other refusal.
    await expect(lookup(() => html('<title>403 Forbidden</title><p>Ошибка проверки CSRF. Запрос отклонён.</p>', { status: 403 })))
      .rejects.toMatchObject({ kind: 'indeterminate', message: 'Skif-Cargo refused the tracking page’s session' });
    await expect(lookup(() => html('<title>403 Forbidden</title>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('<title>404</title>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('', { status: 302, headers: { Location: 'https://www.skif-cargo.ru/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // A captcha page in place of the reply is a challenge, even with HTTP 200; the tracking page is a changed reply.
    await expect(lookup(() => html('<html><script src="https://smartcaptcha.yandexcloud.net/captcha.js"></script></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => page())).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json('{"order_tracking":'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json('Too Many Requests', { status: 429, headers: { 'Retry-After': '10' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 10_000 });
  });

  it('reads a page or account check without the session as changed or moved, and a bot wall in its place as a challenge', async () => {
    const opened = (steps: Parameters<typeof site>[1]) => carrier(site(() => json(fixture('issued')), steps)).track({ number: DELIVERED });
    await expect(opened({ profile: () => profile([]) })).rejects.toMatchObject({ kind: 'schema', message: 'Skif-Cargo opened no session for its lookup' });
    await expect(opened({ profile: () => profile(['csrftoken=""; Max-Age=0; Path=/']) })).rejects.toMatchObject({ kind: 'schema' });
    await expect(opened({ profile: () => profile(['csrftoken=short; Path=/']) })).rejects.toMatchObject({ kind: 'schema' });
    await expect(opened({ page: () => html('<html><head><title>DDoS-Guard</title></head><body>Checking your browser</body></html>') }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(opened({ profile: () => html('<html><head><title>Just a moment...</title></head></html>') })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(opened({ page: () => new Response('', { status: 301, headers: { Location: 'https://skif-cargo.ru/' } }) }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(opened({ profile: () => new Response('', { status: 404 }) })).rejects.toMatchObject({ kind: 'transport' });
    // The page loads a captcha for its callback form; that is not a check on the lookup.
    await expect(opened({})).resolves.toMatchObject({ current_stage: 'delivered' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s on the page, the account check and the lookup', async (status, kind) => {
      const blocked = () => new Response('', { status });
      for (const fetcher of [site(() => json({}), { page: blocked }), site(() => json({}), { profile: blocked }), site(blocked)]) {
        await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      }
    });

  it('tries once more in a new session after a failure to reach Skif-Cargo, inside the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(profile())
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(page()).mockResolvedValueOnce(profile()).mockResolvedValueOnce(json(fixture('issued')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SkifTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([SKIF_PAGE, SKIF_PROFILE, SKIF_LOOKUP, SKIF_PAGE, SKIF_PROFILE, SKIF_LOOKUP]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'skif-cargo', step: 'retry', outcome: 'ok' }));
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects numbers Skif-Cargo does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['00000', '0000000000000', '00000000A', 'SAMPLETRACKING', '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSkifNumber(' 00000 - 0009 ')).toBe(UNKNOWN);
  });

  it('tracks a number filed under Skif-Cargo, and claims no bare nine digits', async () => {
    const tracker = createTracker({ fetcher: site(() => json(fixture('issued'))), providers: [], env: {} });
    await expect(tracker.track({ number: '16168-3384', carrier: 'skif-cargo' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'skif-cargo', source: 'skif-cargo', result: { current_stage: 'delivered' } });
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('skif-cargo');
  });
});

describe('Skif-Cargo status vocabulary', () => {
  it('records every wording with the stage the adapter gives it', () => {
    for (const entry of statuses.entries) {
      expect(skifStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'skif-cargo', providerCode: null, description: 'Груз выдан получателю.' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(skifStage('Синтетическое состояние')).toBeNull();
  });
});
