import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { RiyuTracker } from './adapter.js';
import { normalizeRiyuNumber, parseRiyu, RIYU_ENDPOINT, riyuJson } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = 'G0480119226';
const LATE = 'G1260043114';
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Reply = { success: boolean; data: { orderTrackList: Record<string, unknown>[] } };
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const edited = (edit: (reply: Reply) => void) => { const reply = fixture('delivered.json'); edit(reply); return reply; };
const response = (body: string, status = 200) => new Response(body, { status });

describe('Riyu Logistics guest adapter', () => {
  it('posts the waybill as the tracking page does, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const result = await new RiyuTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' g048 0119 226 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${RIYU_ENDPOINT}?omsNo=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual',
      headers: { Referer: `https://www.rywl.cn/cargoMap-${DELIVERED}`, 'User-Agent': 'SyntheticHost/1' } });
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '已签收：武汉黄陂汉口北营业部',
      last_update: null, last_update_local: '2026-05-11T09:40:28' });
  });

  it('keeps state codes, sites and wall clocks without phones or the operator field', () => {
    const result = parseRiyu(fixture('delivered.json'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.location, event.stage])).toEqual([
      ['2026-05-11T09:40:28', '150', '武汉黄陂汉口北营业部', 'delivered'],
      ['2026-05-09T15:15:46', '080', '武汉黄陂汉口北营业部', 'in_transit'],
      ['2026-05-09T13:37:27', '070', '武汉理货管理部', 'in_transit'],
      ['2026-05-09T13:37:27', '050', '武汉理货管理部', 'in_transit'],
      ['2026-05-08T14:58:57', '040', '广州出港组', 'in_transit'],
      ['2026-05-08T14:58:57', '030', '广州出港组', 'in_transit'],
      ['2026-05-07T20:32:04', '020', '广州番禺沙溪网点', 'in_transit'],
      ['2026-05-07T10:17:15', '010', '广州番禺沙溪网点', 'accepted'],
    ]);
    expect(result.events!.at(-1)!.description).toBe('您的货物已揽收：广州番禺沙溪网点');
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/1[3-9]\d{9}|84666806|2026-05-08 23:43:59/);
  });

  it('keeps the endpoint order when a step is dated after the delivery', () => {
    const result = parseRiyu(fixture('late-row.json'), LATE);
    expect(result.events!.slice(0, 3).map(event => [event.local_time, event.provider_code])).toEqual([
      ['2026-05-13T15:32:52', '150'], ['2026-05-13T14:37:15', '080'], ['2026-05-16T14:28:34', '070']]);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-05-13T15:32:52' });
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found.json')));
    await expect(new RiyuTracker({ fetcher }).fetch('G9999999990')).rejects.toMatchObject({ kind: 'not_found' });
    for (const reply of [edited(reply => { reply.data.orderTrackList[3]!.omsNo = 'G0480119227'; }),
      edited(reply => { reply.data.orderTrackList[3]!.oprTime = '2026-02-30 13:37:27'; }),
      edited(reply => { reply.data.orderTrackList[3]!.oprTime = '2026-05-09'; }),
      edited(reply => { reply.data.orderTrackList[3]!.state = 50; }),
      edited(reply => { (reply.data as Record<string, unknown>).orderTrackList = {}; })]) {
      expect(() => parseRiyu(reply, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const number of ['G048011922', 'G04801192260', '0480119226', 'GG480119226']) {
      expect(() => normalizeRiyuNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps failures, checks and malformed replies distinct', async () => {
    expect(() => parseRiyu({ success: false, message: '系统异常' }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRiyu({ success: false, message: '请求过于频繁' }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => riyuJson('<html><title>Just a moment...</title></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => riyuJson('<html>maintenance</html>')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('{}', status));
      await expect(new RiyuTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the state codes and leaves others without a stage', () => {
    expect(statusMap.stage('150', '')).toBe('delivered');
    expect(statusMap.stage('010', '')).toBe('accepted');
    expect(statusMap.stage('090', '')).toBeUndefined();
    const result = parseRiyu(edited(reply => {
      reply.data.orderTrackList[0] = { ...reply.data.orderTrackList[0], state: '090', desc: '派送中：武汉黄陂汉口北营业部' };
    }), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '090', location: '武汉黄陂汉口北营业部' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: '派送中：武汉黄陂汉口北营业部' });
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('riyu-logistics');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'riyu-logistics', number: DELIVERED });
    expect(tracked.source).toBe('riyu-logistics');
    expect(tracked.result.status).toBe('delivered');
  });
});
