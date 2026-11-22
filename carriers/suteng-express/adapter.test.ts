import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { decodeText } from '../../core/transport/index.js';
import { createTracker } from '../../facade/index.js';
import { SutengTracker } from './adapter.js';
import { normalizeSutengNumber, parseSuteng, SUTENG_ENDPOINT, SUTENG_SITE } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '888079392918';
const UNKNOWN = '999999999990';
const bytes = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const page = (name: string) => decodeText(bytes(name), 'gb18030');
const response = (body: BodyInit, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=gb2312' } });

describe('Suteng Express guest adapter', () => {
  it('reads the GB2312 page for the whole waybill with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered.html')));
    const result = await new SutengTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(` ${DELIVERED} `, { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${SUTENG_ENDPOINT}?billcode=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Referer: SUTENG_SITE, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-11-14T17:04:33', last_status_text: '派件已【签收】,签收网点是【广州市】【岗顶】' });
  });

  it('keeps branch names and local clocks without phones, couriers or the signatory', () => {
    const result = parseSuteng(page('delivered.html'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-11-14T17:04:33', '签收', '派件已【签收】,签收网点是【广州市】【岗顶】', '岗顶', 'delivered'],
      ['2026-11-14T16:53:58', '正在派件', '【广州市】【岗顶】正在派件', '岗顶', 'out_for_delivery'],
      ['2026-11-14T16:42:27', '快件到达', '快件到达【广州市】【岗顶】', '岗顶', 'in_transit'],
      ['2026-11-14T12:55:16', '装车', '快件在【东莞市】【虎门分拨中心】装车,正发往【岗顶】', '虎门分拨中心', 'in_transit'],
      ['2026-11-14T12:27:16', '二次分拣', '【东莞市】虎门分拨中心已二次分拣，安检通过', '虎门分拨中心', 'in_transit'],
      ['2026-11-14T12:27:16', '快件到达', '快件到达【东莞市】【虎门分拨中心】', '虎门分拨中心', 'in_transit'],
      ['2026-11-13T21:56:49', '装车', '快件在【吉安】【吉安分拨】装车,正发往【虎门分拨中心】', '吉安分拨', 'in_transit'],
      ['2026-11-13T21:28:49', '快件到达', '快件到达【吉安】【吉安分拨】', '吉安分拨', 'in_transit'],
      ['2026-11-13T19:43:34', '已收件', '【吉安市】【泰和三部】已收件', '泰和三部', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/电话|签收人|本人|\d{7,}|陈秋根|李江洋|刘秋萍/);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('not-found.html')));
    await expect(new SutengTracker({ fetcher }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseSuteng(page('delivered.html'), '888079392919')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSuteng(page('delivered.html').replace('2026-11-14 16:42:27', '2026-02-30 16:42:27'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSuteng(page('delivered.html').replace('<td>2026-11-14 16:42:27</td>', '<td>2026-11-14</td>'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSuteng('<html>maintenance</html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['88807939291', '8880793929180', 'STE888079392918']) {
      expect(() => normalizeSutengNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('reads a waybill entered without scans as having no history yet', () => {
    const html = page('delivered.html');
    const header = html.slice(0, html.indexOf('<div class="gztitle">&nbsp;&nbsp;&nbsp;&nbsp;跟踪信息'));
    expect(() => parseSuteng(`${header}</body></html>`, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseSuteng('<html><title>Just a moment...</title></html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new SutengTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('tries once more after a request that does not reach the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(response(bytes('delivered.html')));
    const result = await new SutengTracker({ fetcher }).fetch(DELIVERED, { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('delivered');
  });

  it('maps the scans and leaves others without a stage', () => {
    expect(statusMap.stage('签收', '')).toBe('delivered');
    expect(statusMap.stage('正在派件', '')).toBe('out_for_delivery');
    expect(statusMap.stage('问题件', '')).toBeUndefined();
    const html = page('delivered.html').replace('<td>2026-11-14 17:04:33</td><td>派件已',
      '<td>2026-11-14 17:30:00</td><td>【广州市】【岗顶】问题件:地址不详</td><td>岗顶</td></tr><tr><td>888079392918</td><td>2026-11-14 17:04:33</td><td>派件已');
    const result = parseSuteng(html, DELIVERED);
    expect(result.events![0]).toMatchObject({ local_time: '2026-11-14T17:30:00', description: '【广州市】【岗顶】问题件:地址不详', location: '岗顶' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.events![0]!.provider_code).toBeUndefined();
    expect(result.current_stage).toBe('delivered');
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('suteng-express');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'suteng-express', number: DELIVERED });
    expect(tracked.source).toBe('suteng-express');
    expect(tracked.result.status).toBe('delivered');
  });
});
