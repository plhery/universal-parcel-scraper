import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import statuses from './statuses.json' with { type: 'json' };
import { PostIntTracker } from './adapter.js';
import { normalizePostIntNumber, parsePostInt, POST_INT_AJAX, POST_INT_HOME, postIntPageNonce } from './parser.js';
import { statusMap } from './status.js';

const NUMBER = 'DE2142001481122UA';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
const page = (body = fixture('home.html'), status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
/** The delivered reply with its status HTML changed, as the handler would send it. */
const edited = (edit: (html: string) => string) => {
  const payload = JSON.parse(fixture('delivered.json').trim()) as { success: boolean; data: { orderStatus: string } };
  return JSON.stringify({ ...payload, data: { orderStatus: edit(payload.data.orderStatus) } });
};

describe('Post-International guest adapter', () => {
  it('reads the home page nonce, then posts the number as the tracking form does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(fixture('delivered.json')));
    const result = await new PostIntTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' de2142001481122ua ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![0]).toBe(POST_INT_HOME);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe(POST_INT_AJAX);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual',
      body: `trackingID=${NUMBER}&action=post_int_home_tracking_action&nonce_code=5123527ea5`,
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: POST_INT_HOME, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Самостійно забране клієнтом з сортувального центру',
      last_update: null, last_update_local: '2024-06-04T19:42:50' });
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBeUndefined();
  });

  it('keeps the history oldest first on its wall clocks, a midnight row with a count of seconds by its day alone', () => {
    const result = parsePostInt(fixture('delivered.json'), NUMBER);
    expect(result.events!.map(event => [event.local_time, event.description, event.stage])).toEqual([
      ['2024-05-28', 'Надійшло на термінал EU', 'accepted'],
      ['2024-05-28', 'Відвантажено з терміналу EU', 'in_transit'],
      ['2024-05-28T17:55:23', 'Сформовано партію', 'in_transit'],
      ['2024-05-28T18:00:35', 'Відправлення зареєстровано', 'registered'],
      ['2024-05-28T18:02:30', 'Заплановано відвантаження з терміналу EU', 'in_transit'],
      ['2024-05-28T18:10:08', 'Сформовано рейс', 'in_transit'],
      ['2024-05-30', 'Очікується надходження на сортувальний центр UA', 'in_transit'],
      ['2024-06-04T19:42:06', 'Прийнято на сортувальний центр UA', 'in_transit'],
      ['2024-06-04T19:42:50', 'Самостійно забране клієнтом з сортувального центру', 'delivered'],
    ]);
    expect(result.events!.every(event => !event.time && !event.location)).toBe(true);
  });

  it('names the onward carrier and its waybill only together with the waybill', () => {
    const withTtn = parsePostInt(edited(html => html.replace('<span id="post-int-ttn-num"></span>', '<span id="post-int-ttn-num">20450000000000</span>')), NUMBER);
    expect(withTtn).toMatchObject({ delivery_carrier: 'nova-poshta', delivery_tracking_number: '20450000000000' });
    const unnamed = parsePostInt(edited(html => html
      .replace('<span id="post-int-ttn-num"></span>', '<span id="post-int-ttn-num">20450000000000</span>').replace('<td>Новая почта</td>', '<td>JustIn</td>')), NUMBER);
    expect(unnamed.delivery_carrier).toBeUndefined();
    expect(unnamed.delivery_tracking_number).toBe('20450000000000');
    const listed = edited(html => html.replace('<span id="post-int-ttn-num"></span>', '<span id="post-int-ttn-num">20450000000000</span>')
      .replace(/(<h3>Історія статусів відправлення<\/h3>[\s\S]*?<\/tr>)[\s\S]*?(\s*<\/table>)/, '$1$2'));
    expect(() => parsePostInt(listed, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed',
      deliveryCarrier: 'nova-poshta', deliveryTrackingNumber: '20450000000000' }));
  });

  it('reads an empty status as not found and accepts only the shipment whose heading repeats the whole number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(fixture('not-found.json')));
    await expect(new PostIntTracker({ fetcher }).fetch('CV406000000PL')).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parsePostInt(fixture('delivered.json'), 'DE2142001481122U')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePostInt(fixture('delivered.json'), '1234567890')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePostInt(JSON.stringify({ success: true, data: { error: 'Помилка' } }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePostInt(edited(html => html.replace('28.05.2024', '30.02.2024')), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostInt(edited(html => html.replace('17:55:23', '17:55')), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostInt(edited(html => html.replace('<td>17:55:23</td>', '')), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostInt(edited(html => html.replace(/<h2>[^<]*<\/h2>/, '')), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostInt('{"success":false,"data":null}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostInt('<html>maintenance</html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['DE21420', 'DE2142001481122UA-1', 'POSTINTERNATIONAL', 'A'.repeat(20) + '1'.repeat(13)]) {
      expect(() => normalizePostIntNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps the nonce for an hour and reads it again when WordPress refuses a kept one', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(fixture('not-found.json')))
      .mockResolvedValueOnce(reply(fixture('delivered.json')))
      .mockResolvedValueOnce(reply('-1', 403)).mockResolvedValueOnce(page(fixture('home.html').replace('5123527ea5', 'abcdef0123')))
      .mockResolvedValueOnce(reply(fixture('delivered.json')))
      .mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(fixture('delivered.json')));
    const tracker = new PostIntTracker({ fetcher, now: () => now });
    await expect(tracker.fetch('CV406000000PL')).rejects.toMatchObject({ kind: 'not_found' });
    await tracker.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await tracker.fetch(NUMBER);
    expect(String(fetcher.mock.calls[5]![1]!.body)).toContain('nonce_code=abcdef0123');
    now = 2 * 60 * 60_000;
    await tracker.fetch(NUMBER);
    expect(fetcher.mock.calls[6]![0]).toBe(POST_INT_HOME);
    const refused = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply('-1', 403));
    await expect(new PostIntTracker({ fetcher: refused }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(postIntPageNonce(fixture('home.html'))).toBe('5123527ea5');
    expect(() => parsePostInt('<html><title>Just a moment...</title></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><title>Just a moment...</title><div class="cf-turnstile"></div></html>'));
    await expect(new PostIntTracker({ fetcher: challenged }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><title>Post-international</title></html>'));
    await expect(new PostIntTracker({ fetcher: moved }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [400, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(status === 400 ? '0' : '', status));
      await expect(new PostIntTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('maps every recorded status and leaves others without a stage', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    expect(statusMap.stage(null, 'повернуто відправнику')).toBeUndefined();
    const result = parsePostInt(edited(html => html.replace(/<td>Самостійно забране клієнтом з сортувального центру<\/td>(\s*<td>04\.06\.2024<\/td>)/,
      '<td>Повернуто відправнику</td>$1')), NUMBER);
    expect(result.events!.at(-1)!.stage).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Повернуто відправнику' });
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('post-international');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(reply(fixture('delivered.json')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'post-international', number: NUMBER });
    expect(tracked.source).toBe('post-international');
    expect(tracked.result.status).toBe('delivered');
  });
});
