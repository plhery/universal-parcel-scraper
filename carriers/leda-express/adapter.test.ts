import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { LedaTracker } from './adapter.js';
import { LEDA_PAGE, normalizeLedaNumber, parseLeda } from './parser.js';
import { ledaStage, statusMap } from './status.js';

const NUMBER = 'LD89581317335286';
const SF = 'SF5146168504329';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; Charset=UTF-8' } });

describe('Leda Express guest adapter', () => {
  it('posts one number as the tracking form does, over HTTP, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new LedaTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' ld8958 1317 335286 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://www.leda-express.com/queryexpress.html');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: `express=${NUMBER}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: LEDA_PAGE, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-10-18T18:23:00',
      delivery_carrier: 'sf-express', delivery_tracking_number: SF });
    expect(result.last_status_text).toMatch(/^您的快件已派送至本人/);
  });

  it('reads Leda\'s rows and SF Express\'s on China\'s wall clock, newest first, with their places', () => {
    const result = parseLeda(page('delivered.html'), NUMBER);
    expect(result.events).toHaveLength(31);
    expect(result.events!.every(event => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)) && !event.time)).toBe(true);
    expect(result.events!.slice(-7).map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-10-15T16:14:00', '深圳市', '顺丰速运 已收取快件，您的期待，我们定竭诚守护，不负所托。', 'in_transit'],
      ['2026-10-14T12:16:00', '深圳', `海关已放行。待交付当地承运方（顺丰：${SF}）。`, 'in_transit'],
      ['2026-10-13T18:30:00', '深圳', '清关中', 'customs'],
      ['2026-10-13T18:00:00', '深圳', '货物到达海关，等待清关', 'customs'],
      ['2026-10-13T16:25:00', '香港', '貨物離開香港倉', 'in_transit'],
      ['2026-10-13T13:12:00', '香港', '貨物到達樂達全球速遞香港倉', 'in_transit'],
      ['2026-10-13T13:00:00', '香港', '樂達全球速遞 已攬收', 'accepted'],
    ]);
    expect(result.events!.at(-1)!.original_description).toBe('【中国香港】樂達全球速遞 已攬收');
    expect(result.events!.slice(0, 5).map(event => [event.location, event.stage])).toEqual([
      ['兰州市', 'delivered'], ['兰州市', 'delivered'], ['兰州市', 'ready_for_pickup'], ['兰州市', 'out_for_delivery'], ['兰州市', 'in_transit'],
    ]);
    // A truck's position on a long haul names no city of its own.
    const truck = result.events!.find(event => event.description!.startsWith('车辆正在长途运输中'))!;
    expect(truck).toMatchObject({ stage: 'in_transit' });
    expect(truck.location).toBeUndefined();
    expect(result.events!.every(event => event.stage)).toBe(true);
  });

  it('keeps the courier\'s name and phone in SF\'s wording, as SF Express\'s adapter does, and out of the place', () => {
    const result = parseLeda(page('delivered.html'), NUMBER);
    const round = result.events!.find(event => event.stage === 'out_for_delivery')!;
    expect(round.description).toMatch(/^快件交给【.+，联系电话：\d{11}】，正在派送途中/);
    expect(round.location).toBe('兰州市');
    const point = result.events!.find(event => event.description!.startsWith('快件到达 【兰州安宁教育世家店，地址：'))!;
    expect(point.location).toBe('兰州市');
  });

  it('reports an unknown number as not found only when the notice names the whole number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new LedaTracker({ fetcher }).fetch('LD00000000000000')).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseLeda(page('not-found.html'), 'LD00000000000001')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const html = page('delivered.html');
    expect(() => parseLeda(html, 'LD89581317335287')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLeda(html.replace('2026-10-15 20:27 ', '2026-02-30 20:27 '), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLeda(html.replace('2026-10-15 20:27 ', '2026-10-15 '), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLeda('<html>maintenance</html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const listed = html.replace(/<tr><td>\d{4}-[\s\S]*<\/td><\/tr>/, '');
    expect(() => parseLeda(listed, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed', deliveryTrackingNumber: SF }));
    for (const number of ['89581317335286', 'LD8958131733528', 'LD895813173352860', 'SF5146168504329']) {
      expect(() => normalizeLedaNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseLeda('<html><title>Just a moment...</title></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new LedaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the rows by wording and leaves others to the shared rules', () => {
    expect(statusMap.stage(null, '樂達全球速遞 已攬收')).toBe('accepted');
    expect(statusMap.stage(null, '海关已放行。待交付当地承运方（顺丰：sf0000000000000）。')).toBe('in_transit');
    expect(statusMap.stage(null, '快件领取成功')).toBe('delivered');
    expect(statusMap.stage('X', '快件领取成功')).toBeUndefined();
    expect(ledaStage('快件已交接给顺丰合作点(示例店，联系电话：00000000000，地址：示例），请凭取货信息前往合作点领取您的快递。'))
      .toMatchObject({ stage: 'ready_for_pickup' });
    expect(ledaStage('包裹已发往美国仓库')).toBeNull();
    const result = parseLeda(page('delivered.html').replace(/\[兰州市\]您的快件已派送至本人[^<]*/, '包裹已发往美国仓库'), NUMBER);
    expect(result.events![0]).toMatchObject({ description: '包裹已发往美国仓库' });
    expect(result.events![0]!.stage).toBeUndefined();
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('leda-express');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'leda-express', number: NUMBER });
    expect(tracked.source).toBe('leda-express');
    expect(tracked.result.status).toBe('delivered');
  });
});
