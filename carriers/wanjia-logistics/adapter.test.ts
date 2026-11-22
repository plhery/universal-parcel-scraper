import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { WanjiaTracker } from './adapter.js';
import { normalizeWanjiaNumber, parseWanjia, WANJIA_ENDPOINT, WANJIA_PAGE } from './parser.js';
import { statusMap } from './status.js';

const PICKED_UP = '37100001554334';
const LOCKER = '37300000040744';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });

describe('Wanjia Logistics guest adapter', () => {
  it('reads the framed tracking page for the whole waybill with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('picked-up.html')));
    const result = await new WanjiaTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' 3710 0001 5543 34 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${WANJIA_ENDPOINT}?nu=${PICKED_UP}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Referer: WANJIA_PAGE, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '您的包裹已签收。', last_update: null,
      last_update_local: '2026-10-27T19:52:43' });
  });

  it('keeps scans, regions, the pickup point and the partner waybill without couriers, collectors or phones', () => {
    const result = parseWanjia(page('picked-up.html'), PICKED_UP);
    expect(result.events).toHaveLength(11);
    expect(result.events!.slice(0, 5).map(event => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-10-27T19:52:43', '已签收', '您的包裹已签收。', '天津', 'delivered'],
      ['2026-10-27T18:45:43', '已领取', '您的包裹已领取，收件人在[代收点](海北千美商城代收)取件', '天津市宁河区', 'delivered'],
      ['2026-10-27T11:57:55', '待取件', '您的包裹已到达[代收点](海北千美商城代收)千美商城院内，请及时取件。已转圆通快递YT0720517807194派送', '天津市宁河区',
        'ready_for_pickup'],
      ['2026-10-27T07:59:10', '派件', '【天津市宁河区芦台镇】正在为您派件', '天津市宁河区', 'out_for_delivery'],
      ['2026-10-27T07:58:54', '到达', '您的包裹已经到达【天津市宁河区芦台镇】', '天津市宁河区', 'in_transit'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-10-25T02:58:46', provider_code: '已揽收',
      description: '您的包裹在【福建省泉州市石狮市塘园分部】已揽收', location: '泉州市石狮市', stage: 'accepted' });
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/阎春瑶|蔡荣沛|揽收人|电话|联系不上|0769|1[3-9]\d{9}/);
  });

  it('keeps a locker store and its address without the pickup code or courier', () => {
    const result = parseWanjia(page('locker.html'), LOCKER);
    expect(result.events![0]).toMatchObject({ local_time: '2026-09-18T21:36:00', provider_code: '暂存',
      description: '包裹已送达兔喜生活+暂存,取件地址:新垵村东片176号中通快递厦门海沧海沧新垵东片176店', location: '厦门市', stage: 'ready_for_pickup' });
    expect(result.events!.at(-1)).toMatchObject({ description: '广州沙埔网点 已揽收', location: '增城区', stage: 'accepted' });
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', last_update_local: '2026-09-18T21:36:00' });
    expect(JSON.stringify(result)).not.toMatch(/取件码|121315|冯瑞强|投诉|1[3-9]\d{9}/);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new WanjiaTracker({ fetcher }).fetch('99999999999990')).rejects.toMatchObject({ kind: 'not_found' });
    const html = page('picked-up.html');
    expect(() => parseWanjia(html, '37100001554335')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWanjia(html.replace('2026-10-26 14:18:54', '2026-02-30 14:18:54'), PICKED_UP)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWanjia(html.replace('2026-10-26 14:18:54', '2026-10-26'), PICKED_UP)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWanjia(page('not-found.html').replace('<div class="result-not-found">', '<div>'), '99999999999990'))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWanjia('<html>maintenance</html>', PICKED_UP)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['3710000155433', '371000015543340', 'WJ37100001554334']) {
      expect(() => normalizeWanjiaNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseWanjia('<html><title>Just a moment...</title></html>', PICKED_UP)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new WanjiaTracker({ fetcher }).fetch(PICKED_UP)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the scans and leaves others without a stage', () => {
    expect(statusMap.stage('已领取', '')).toBe('delivered');
    expect(statusMap.stage('暂存', '')).toBe('ready_for_pickup');
    expect(statusMap.stage('退回', '')).toBeUndefined();
    const result = parseWanjia(page('picked-up.html').replace('【天津】您的包裹已签收。', '【天津】您的包裹因地址不详退回商家'), PICKED_UP);
    expect(result.events![0]).toMatchObject({ description: '您的包裹因地址不详退回商家', location: '天津' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.current_stage).toBe('delivered');
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(PICKED_UP).candidates ?? []).not.toContain('wanjia-logistics');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('picked-up.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'wanjia-logistics', number: PICKED_UP });
    expect(tracked.source).toBe('wanjia-logistics');
    expect(tracked.result.status).toBe('delivered');
  });
});
