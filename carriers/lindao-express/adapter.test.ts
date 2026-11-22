import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { LindaoTracker } from './adapter.js';
import { LINDAO_PAGE, normalizeLindaoNumber, parseLindao } from './parser.js';
import { statusMap } from './status.js';

const ORDER = '506539694570';
const JAPANESE = '363470421016';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });

describe('Lindao Express guest adapter', () => {
  it('posts one number as the tracking form does, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new LindaoTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' 5065 3969 4570 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(LINDAO_PAGE);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: `number=${ORDER}`,
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9', 'Content-Type': 'application/x-www-form-urlencoded', Referer: LINDAO_PAGE, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '配達完了', last_update: null,
      last_update_local: '2026-09-18T15:08:00', delivery_tracking_number: JAPANESE });
  });

  it('keeps the steps in China and Japan, their places and the page order', () => {
    const result = parseLindao(page('delivered.html'), ORDER);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.location, event.stage])).toEqual([
      ['2026-09-18T15:08:00', '配達完了', undefined, 'delivered'],
      ['2026-09-18T12:03:00', '配達中', undefined, 'out_for_delivery'],
      ['2026-09-18T03:01:00', '輸送中', undefined, 'in_transit'],
      ['2026-09-17T18:12:00', '集荷', undefined, 'in_transit'],
      ['2026-09-17T17:12:00', '进口清关完成/輸入通関許可', undefined, 'in_transit'],
      ['2026-09-17T10:45:00', '货物抵达日本清关中/フライト到着（輸入通関手続き中）', undefined, 'customs'],
      ['2026-09-16T19:29:18', '订单已发出', undefined, 'in_transit'],
      ['2026-09-16T17:55:22', '已揽件', undefined, 'accepted'],
      ['2026-09-16T15:17:10', '抵达操作中心', '青岛操作中心', 'in_transit'],
    ]);
    expect(result.events![6]!.description).toBe('订单已发出；预计起飞-到达时间:2026-09-17 07:30~~2026-09-17 10:45');
    const dalian = parseLindao(page('dalian.html'), '506542880196');
    expect(dalian.events!.filter(event => event.location).map(event => [event.provider_code, event.location])).toEqual([
      ['空港に到着予定', '成田空港'], ['空港から出発', '大连空港']]);
    expect(dalian.delivery_tracking_number).toBe('358972041713');
  });

  it('answers the Japanese waybill with the same order, without repeating it', () => {
    const result = parseLindao(page('delivered.html'), JAPANESE);
    expect(result.events).toHaveLength(9);
    expect(result.delivery_tracking_number).toBeUndefined();
  });

  it('reports an unknown number as not found and requires the whole number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new LindaoTracker({ fetcher }).fetch('999999999990')).rejects.toMatchObject({ kind: 'not_found' });
    const html = page('delivered.html');
    expect(() => parseLindao(html, '506539694571')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLindao(html.replace('2026-09-18 03:01:00', '2026-02-30 03:01:00'), ORDER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLindao(html.replace('2026-09-18 03:01:00', '2026-09-18'), ORDER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLindao('<html>maintenance</html>', ORDER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['50653969457', '5065396945700', 'LD506539694570']) {
      expect(() => normalizeLindaoNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseLindao('<html><title>Just a moment...</title></html>', ORDER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new LindaoTracker({ fetcher }).fetch(ORDER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the steps and leaves others without a stage', () => {
    expect(statusMap.stage('配達完了', '')).toBe('delivered');
    expect(statusMap.stage('货物抵达日本清关中/フライト到着（輸入通関手続き中）', '')).toBe('customs');
    expect(statusMap.stage('持戻', '')).toBeUndefined();
    const result = parseLindao(page('delivered.html').replace('15:08:00 配達完了', '15:08:00 持戻'), ORDER);
    expect(result.events![0]).toMatchObject({ provider_code: '持戻', description: '持戻' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: '持戻' });
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(ORDER).candidates ?? []).not.toContain('lindao-express');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'lindao-express', number: ORDER });
    expect(tracked.source).toBe('lindao-express');
    expect(tracked.result.status).toBe('delivered');
  });
});
