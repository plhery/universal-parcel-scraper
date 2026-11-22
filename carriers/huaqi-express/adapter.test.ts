import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { HuaqiTracker } from './adapter.js';
import { HUAQI_PAGE, normalizeHuaqiNumber, parseHuaqi } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '400800901904';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('Huaqi Express guest adapter', () => {
  it('reads the tracking page for the whole waybill with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new HuaqiTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' 4008 0090 1904 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${HUAQI_PAGE}?orderNumbers=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Referer: HUAQI_PAGE, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '快件已签收', last_update: null,
      last_update_local: '2026-08-20T21:40:08' });
  });

  it('keeps scans, branches and hubs without couriers, scanners, phones or courtesy lines', () => {
    const result = parseHuaqi(page('delivered.html'), DELIVERED);
    expect(result.events).toHaveLength(21);
    expect(result.events!.slice(0, 4).map(event => [event.local_time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-08-20T21:40:08', '已签收', '快件已签收', 'delivered'],
      ['2026-08-20T21:35:00', '已派送', '您的快件已派送至本人', 'delivered'],
      ['2026-08-20T20:50:00', '派送途中', '快件正在派送途中', 'out_for_delivery'],
      ['2026-08-20T18:23:00', undefined, '我们正在为您的快件分配最合适的快递员，请您稍等', undefined],
    ]);
    expect(result.events!.find(event => event.local_time === '2026-08-19T13:49:00')).toMatchObject({
      provider_code: '快件到达', description: '快件到达【上海华新转运中心】', location: '上海华新转运中心', stage: 'in_transit' });
    expect(result.events!.slice(-3).map(event => [event.description, event.location, event.stage])).toEqual([
      ['离开【上海华企】,发往【广东省-广州市-白云区】', '上海华企', 'in_transit'],
      ['已入库,到达【上海华企】', '上海华企', 'in_transit'],
      ['已收件,收件网点【上海华企】', '上海华企', 'accepted'],
    ]);
    expect(result.events!.filter(event => event.provider_code === '长途运输').every(event => !event.location)).toBe(true);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/方树辉|徐国胜|扫描员|电话|体验|\d{7,}/);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new HuaqiTracker({ fetcher }).fetch('999999999990')).rejects.toMatchObject({ kind: 'not_found' });
    const html = page('delivered.html');
    expect(() => parseHuaqi(html, '400800901905')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHuaqi(html.replace('2026-08-20 15:51:00', '2026-02-30 15:51:00'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHuaqi(html.replace('2026-08-20 15:51:00', '2026-08-20'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHuaqi('<html>maintenance</html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['40080090190', '4008009019040', 'HQ400800901904']) {
      expect(() => normalizeHuaqiNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseHuaqi('<html><title>Just a moment...</title></html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new HuaqiTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the scans and leaves others without a stage', () => {
    expect(statusMap.stage('已签收', '')).toBe('delivered');
    expect(statusMap.stage('派送途中', '')).toBe('out_for_delivery');
    expect(statusMap.stage('异常', '')).toBeUndefined();
    const result = parseHuaqi(page('delivered.html').replace('<span class="desc">快件已签收</span>', '<span class="desc">快件滞留【广州白云罗冲围店】</span>'), DELIVERED);
    expect(result.events![0]).toMatchObject({ description: '快件滞留【广州白云罗冲围店】' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.current_stage).toBe('delivered');
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('huaqi-express');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'huaqi-express', number: DELIVERED });
    expect(tracked.source).toBe('huaqi-express');
    expect(tracked.result.status).toBe('delivered');
  });
});
