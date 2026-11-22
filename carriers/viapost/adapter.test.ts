import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { ViapostTracker } from './adapter.js';
import { normalizeViapostNumber, parseViapost, viapostTrackingUrl } from './parser.js';
import { statusMap } from './status.js';

const ALIEXPRESS = 'RR745733230HU';
const ORDER = '269793';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('Viapost guest adapter', () => {
  it('reads the order page with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new ViapostTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' rr745733230hu ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://www.viapost.solutions/Order/Track/${ALIEXPRESS}`);
    expect(init).toMatchObject({ redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'ДОСТАВЕНО', last_update: null,
      last_update_local: '2025-04-04T09:42:38' });
  });

  it('keeps the statuses on Skopje wall clocks, newest first, without the repeated notices', () => {
    const result = parseViapost(page('delivered.html'), ALIEXPRESS);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2025-04-04T09:42:38', 'ДОСТАВЕНО', 'delivered'],
      ['2025-04-03T09:08:08', 'НА ДОСТАВА', 'out_for_delivery'],
      ['2025-04-02T18:24:17', 'ВО МАГАЦИН', 'in_transit'],
      ['2025-04-02T17:43:46', 'НА ЧЕКАЊЕ', 'failed_attempt'],
      ['2025-04-02T09:29:26', 'НА ДОСТАВА', 'out_for_delivery'],
      ['2025-04-01T19:21:33', 'ВО МАГАЦИН', 'in_transit'],
      ['2025-04-01T19:21:32', 'ВО МАГАЦИН', 'in_transit'],
      ['2025-03-28T12:52:42', 'НОВИ', 'registered'],
    ]);
    expect(result.events!.every(event => event.description === event.provider_code && !event.time && !event.location)).toBe(true);
    const tetovo = parseViapost(page('tetovo.html'), ORDER);
    expect(tetovo.events!.map(event => event.provider_code)).toEqual(
      ['ДОСТАВЕНО', 'НА ДОСТАВА', 'ВО МАГАЦИН', 'НА ДОСТАВА', 'ВО МАГАЦИН', 'НА ДОСТАВА', 'НОВИ']);
    expect(tetovo.events!.at(-1)!.local_time).toBe('2024-10-25T16:13:39');
  });

  it('never reads the recipient, the sender, the accounts or the comments', () => {
    for (const [name, number] of [['delivered.html', ALIEXPRESS], ['tetovo.html', ORDER]]) {
      const text = JSON.stringify(parseViapost(page(name!), number!));
      expect(text).not.toMatch(/\d{6,}|recipient|address|Viber|Magyar|MAGACIN|SKOPJE|TETOVO|YENIMARMARIS|javuva|MKD/i);
    }
  });

  it('reports only the site error page under HTTP 500 as not found', async () => {
    const notFound = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html'), 500));
    await expect(new ViapostTracker({ fetcher: notFound }).fetch('99999999')).rejects.toMatchObject({ kind: 'not_found' });
    for (const [body, status] of [['<html><body>Server Error in \'/\' Application.</body></html>', 500], [page('not-found.html'), 502],
      ['', 503], ['<title>Via Post</title>', 500]] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body, status));
      await expect(new ViapostTracker({ fetcher }).fetch(ORDER)).rejects.toMatchObject({ kind: 'transport' });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    // The same page under HTTP 200 is no answer about the order.
    const ok = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new ViapostTracker({ fetcher: ok }).fetch(ORDER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('requires the whole number and a readable history', () => {
    const html = page('delivered.html');
    expect(() => parseViapost(html, 'RR745733231HU')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseViapost(html.replace('4/2/2025 5:43:46 PM', '2/30/2025 5:43:46 PM'), ALIEXPRESS)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseViapost(html.replace('4/2/2025 5:43:46 PM', '4/2/2025 17:43'), ALIEXPRESS)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseViapost('<html>maintenance</html>', ALIEXPRESS)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const listed = html.replace(/<div class="new-tracking-event-list">[\s\S]*?<\/p>\s*<\/div>\s*<\/div>\s*<\/div>/g, '');
    expect(listed).toContain('ИСТОРИЈА НА НАРАЧКА');
    expect(() => parseViapost(listed, ALIEXPRESS)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    for (const number of ['123', 'RR74573323HU', 'ABC123456', 'RR745733230HU1']) {
      expect(() => normalizeViapostNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(viapostTrackingUrl(' 269793 ')).toBe('https://www.viapost.solutions/Order/Track/269793');
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseViapost('<html><title>Just a moment...</title></html>', ORDER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new ViapostTracker({ fetcher }).fetch(ORDER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the statuses and leaves others without a stage', () => {
    expect(statusMap.stage('ДОСТАВЕНО', '')).toBe('delivered');
    expect(statusMap.stage('НА ЧЕКАЊЕ', '')).toBe('failed_attempt');
    expect(statusMap.stage('ВРАТЕНО', '')).toBeUndefined();
    const result = parseViapost(page('delivered.html').replace('ДОСТАВЕНО - SASESKOPJE', 'ВРАТЕНО - SASESKOPJE'), ALIEXPRESS);
    expect(result.events![0]).toMatchObject({ provider_code: 'ВРАТЕНО', description: 'ВРАТЕНО' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'ВРАТЕНО' });
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(ORDER).candidates ?? []).not.toContain('viapost');
    expect(detectCarrierMatch(ALIEXPRESS).candidates ?? []).not.toContain('viapost');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('tetovo.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'viapost', number: ORDER });
    expect(tracked.source).toBe('viapost');
    expect(tracked.result.status).toBe('delivered');
  });
});
