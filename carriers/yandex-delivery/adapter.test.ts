import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CARRIERS, trackingNumberForLink } from '../../core/catalog/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { normalizeStatusWording, statusGapNote } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { YandexDeliveryTracker } from './adapter.js';
import { normalizeYandexDeliveryNumber, parseYandexDeliveryPage } from './parser.js';
import { statusMap, yandexDeliveryStage } from './status.js';

// The tracking page's own example number; its page is the fixture.
const NUMBER = 'LO-835645864';
// A number of the page's layout that it does not know; its page is the other fixture.
const UNKNOWN = 'LO-000000000';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, status = 200, headers: HeadersInit = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { wording: string; stage: string | null }[] };
const carrier = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')) as { tracking: Record<string, unknown> };
/** The sample's page with its history edited. */
const edited = (edit: (track: string) => string) => page('disposed').replace(/<ul class="order-track">[\s\S]*?<\/ul>/, edit);
const scan = (clock: string, wording: string, line = '') => `<li class="track-item track-item--done"><div class="track-marker"><span class="track-bead"></span></div>
  <div class="track-content"><div class="track-time">${clock}</div><div class="track-desc">${wording}</div><div class="track-subtitle">${line}</div></div></li>`;
const then = (...rows: string[]) => edited(track => track.replace('</ul>', `${rows.join('\n')}</ul>`));

describe('Yandex Delivery guest adapter', () => {
  it('asks the page for the whole number once, with the supplied transport, agent and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('disposed')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new YandexDeliveryTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(' lo-835645864 ', { budgetMs: 4000 });
    expect(result.events).toHaveLength(14);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://dostavka.yandex.ru/ndd/tracking/?order_tracking_id=LO-835645864');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'yandex-delivery', step: 'direct', outcome: 'ok' }));
  });

  it('reads an unknown number\'s HTTP 404 notice, which names it, as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('unknown'), 404));
    await expect(new YandexDeliveryTracker({ fetcher }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps a notice for another number, a bare 404 and other pages as failures', async () => {
    expect(() => parseYandexDeliveryPage(page('unknown'), 'LO-000000001')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const [body, status] of [['Not Found', 404], ['<html><body>Ошибка</body></html>', 200]] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(body, status));
      await expect(new YandexDeliveryTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    }
    const rateLimited = vi.fn<typeof fetch>().mockResolvedValue(html('Too Many Requests', 429, { 'Retry-After': '1' }));
    await expect(new YandexDeliveryTracker({ fetcher: rateLimited }).fetch(NUMBER, { budgetMs: 500 })).rejects.not.toMatchObject({ kind: 'not_found' });
  });

  it('reads Yandex\'s SmartCaptcha, by redirect or by page, as a challenge', async () => {
    const redirect = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://dostavka.yandex.ru/showcaptcha?cc=1&retpath=x' } }));
    await expect(new YandexDeliveryTracker({ fetcher: redirect }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const captcha = '<html><head><title>Ой!</title></head><body><form action="/checkcaptcha"><div class="SmartCaptcha"></div></form></body></html>';
    expect(() => parseYandexDeliveryPage(captcha, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const moved = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 301, headers: { Location: 'https://dostavka.yandex.ru/' } }));
    await expect(new YandexDeliveryTracker({ fetcher: moved }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('gives a stored LO number back the hyphen the tracker needs, in requests and links', async () => {
    const stored = NUMBER.replace('-', '');
    expect(normalizeYandexDeliveryNumber(stored)).toBe(NUMBER);
    expect(normalizeYandexDeliveryNumber('LO00000000')).toBe('LO00000000');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(page('disposed')));
    const result = await new YandexDeliveryTracker({ fetcher }).fetch(stored);
    expect(result.events).toHaveLength(14);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://dostavka.yandex.ru/ndd/tracking/?order_tracking_id=${NUMBER}`);
    expect(trackingNumberForLink('yandex-delivery', stored)).toBe(NUMBER);
    expect(CARRIERS['yandex-delivery'].trackingUrl?.(stored)).toBe(`https://dostavka.yandex.ru/ndd/tracking/?order_tracking_id=${NUMBER}`);
  });

  it('takes the page\'s 6 to 40 Latin letters, digits and hyphens, upper-cased', () => {
    expect(normalizeYandexDeliveryNumber(' lo-835645864 ')).toBe(NUMBER);
    expect(normalizeYandexDeliveryNumber('1234567890')).toBe('1234567890');
    for (const raw of ['abc12', 'LO 835645864', 'ЛО-835645864', 'A'.repeat(41), '']) {
      expect(() => normalizeYandexDeliveryNumber(raw), raw).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Yandex Delivery page parser', () => {
  it('reads the public sample\'s scans newest first as wall clocks, with places but not notes', () => {
    const staged = (stage: string) => ({ stage, stage_source: 'carrier_map' });
    expect(parseYandexDeliveryPage(page('disposed'), NUMBER)).toEqual({
      status: languageStageStatus('exception'), current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Заказ утилизирован', last_update: null, last_update_local: '2026-06-07T14:06', expected_delivery: null,
      events: [
        { local_time: '2026-06-07T14:06', description: 'Заказ утилизирован', ...staged('exception') },
        { local_time: '2026-05-16T10:45', description: 'Ждёт вручения в пункте приема', ...staged('returned') },
        // The page shows this scan without a clock; it keeps its place.
        { description: 'Возврат принят пунктом приема', location: 'Новинский бульвар 8, Москва', ...staged('returned') },
        { local_time: '2026-05-16T08:57', description: 'Изменена дата возврата' },
        { local_time: '2026-05-14T21:18', description: 'Возвращается в пункт выдачи', location: 'улица Архитектора Щусева 4 к1, Москва', ...staged('returned') },
        { local_time: '2026-05-14T21:18', description: 'Отменен', ...staged('exception') },
        { local_time: '2026-05-03T17:08', description: 'Изменён срок хранения в пункте выдачи' },
        { local_time: '2026-04-30T16:12', description: 'Ждёт вручения в пункте выдачи', ...staged('ready_for_pickup') },
        { local_time: '2026-04-30T16:11', description: 'Принят пунктом выдачи', location: 'улица Архитектора Щусева 4 к1, Москва', ...staged('in_transit') },
        { local_time: '2026-04-30T12:09', description: 'Отгружен из сортировочного центра', location: 'Москва', ...staged('in_transit') },
        { local_time: '2026-04-29T10:18', description: 'Приехал в сортировочный центр', location: 'Москва', ...staged('in_transit') },
        { local_time: '2026-04-29T06:07', description: 'Едет в сортировочный центр', location: 'Новинский бульвар 8, Москва', ...staged('in_transit') },
        { local_time: '2026-04-28T15:53', description: 'Принят пунктом приёма', location: 'Новинский бульвар 8, Москва', ...staged('accepted') },
        { local_time: '2026-04-28T15:36', description: 'Создан', ...staged('registered') },
      ],
    });
    // The storage deadlines, the new return date and the reason of the cancellation are left out.
    const text = JSON.stringify(parseYandexDeliveryPage(page('disposed'), NUMBER));
    for (const note of ['Срок хранения', 'До 14 мая', 'На 17 мая', 'Истек срок хранения', 'Можно забрать']) expect(text).not.toContain(note);
  });

  it('binds the history to the whole number asked', () => {
    expect(parseYandexDeliveryPage(page('disposed'), 'lo-835645864').events).toHaveLength(14);
    for (const other of ['LO-835645865', 'LO-83564586']) {
      expect(() => parseYandexDeliveryPage(page('disposed'), other), other).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const twice = page('disposed').replace('</section>\n\n    <section class="content-section" aria-labelledby="howto-title">',
      '<h2 id="order-title">Заказ LO-835645864</h2></section>\n\n    <section class="content-section" aria-labelledby="howto-title">');
    expect(() => parseYandexDeliveryPage(twice, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a delivery and a parcel waiting at its pickup point', () => {
    const delivered = parseYandexDeliveryPage(edited(() => `<ul class="order-track">${scan('01.05.2026 10:00', 'Создан')}${scan('03.05.2026 12:30', 'Доставлено')}</ul>`), NUMBER);
    expect(delivered).toMatchObject({ status: languageStageStatus('delivered'), current_stage: 'delivered', last_update_local: '2026-05-03T12:30' });
    const waiting = parseYandexDeliveryPage(edited(() => `<ul class="order-track">${scan('01.05.2026 10:00', 'Создан')}${scan('03.05.2026 12:30', 'Ждёт вручения в пункте выдачи', 'Срок хранения до 10 мая')}</ul>`), NUMBER);
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', events: [{ description: 'Ждёт вручения в пункте выдачи' }, {}] });
    expect(waiting.events![0]).not.toHaveProperty('location');
  });

  it('keeps a newer notice without a stage from undoing the stage under it', () => {
    const result = parseYandexDeliveryPage(then(scan('08.06.2026 09:00', 'Изменён срок хранения в пункте выдачи', 'До 20 июня')), NUMBER);
    expect(result).toMatchObject({ last_status_text: 'Изменён срок хранения в пункте выдачи', current_stage: 'exception' });
  });

  it('refuses invalid clocks and unreadable scans', () => {
    expect(() => parseYandexDeliveryPage(then(scan('31.02.2026 10:00', 'Создан')), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYandexDeliveryPage(then(scan('2026-06-08 10:00', 'Создан')), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYandexDeliveryPage(then(scan('08.06.2026 10:00', ' ')), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYandexDeliveryPage(edited(() => '<ul class="order-track"></ul>'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYandexDeliveryPage(edited(() => ''), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Yandex Delivery statuses', () => {
  it('stages every recorded wording as statuses.json says, and names the gaps', () => {
    expect(statuses.entries.length).toBeGreaterThan(0);
    for (const entry of statuses.entries) {
      expect(yandexDeliveryStage(entry.wording) ?? null, entry.wording).toBe(entry.stage);
      if (entry.stage === null) expect(statusGapNote(statusMap, null, normalizeStatusWording(entry.wording)), entry.wording).toBeTruthy();
      else expect(STAGES).toContain(entry.stage);
    }
    for (const gap of statusMap.gaps) expect(statuses.entries.some(entry => normalizeStatusWording(entry.wording) === gap.wording), gap.wording).toBe(true);
  });

  it('flags its wall clocks in the catalog', () => {
    expect(carrier.tracking).toMatchObject({ adapter: 'yandex-delivery', steps: ['direct'], localClocks: true });
  });

  it('reads a wording its map lacks by the shared wording rules', () => {
    // Synthetic: a newer scan in words the shared rules read.
    expect(parseYandexDeliveryPage(then(scan('08.06.2026 09:00', 'Returned to sender')), NUMBER))
      .toMatchObject({ current_stage: 'returned', current_stage_source: 'wording:language' });
  });
});
