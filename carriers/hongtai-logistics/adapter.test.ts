import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { HongtaiTracker } from './adapter.js';
import { HONGTAI_ENDPOINT, HONGTAI_PAGE, hongtaiJson, normalizeHongtaiNumber, parseHongtai } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '262776663';
const TRANSFERRED = '262753872';
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Reply = { code: string; msg: string; rows: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const edited = (edit: (reply: Reply) => void) => { const reply = fixture('delivered.json'); edit(reply); return reply; };
const response = (body: string, status = 200) => new Response(body, { status });

describe('Hongtai Logistics guest adapter', () => {
  it('posts the waybill as the search page does, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const result = await new HongtaiTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' 262 776 663 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(HONGTAI_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: JSON.stringify({ orderNo: DELIVERED }),
      headers: { 'Content-Type': 'application/json;charset=utf-8', Referer: HONGTAI_PAGE, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '货物已签收',
      last_update: '2026-11-16T15:44:35+08:00' });
  });

  it('keeps instants, nodes and branches without phones, plates, drivers, load numbers or the signatory', () => {
    const result = parseHongtai(fixture('delivered.json'), DELIVERED);
    expect(result.events!.map(event => [event.time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-11-16T15:44:35+08:00', '客户签收', '货物已签收', '长治', 'delivered'],
      ['2026-11-16T10:01:05+08:00', '卸货入库', '货物已由【长治市】【长治】卸货入库', '长治', 'in_transit'],
      ['2026-11-16T10:01:05+08:00', '整车签收', '运单整车签收-【长治】【长治】', '长治', 'in_transit'],
      ['2026-11-16T00:58:16+08:00', '分拨发车', '货物已由【山西库】发往【长治】【18】车', '山西库', 'in_transit'],
      ['2026-11-14T20:50:11+08:00', '货物配载', '下一站网点【山西库】装车，下一站网点【长治】', '山西库', 'in_transit'],
      ['2026-11-14T19:57:05+08:00', '卸货入库', '货物已由【郑州市】【山西库】卸货入库', '山西库', 'in_transit'],
      ['2026-11-14T17:26:38+08:00', '卸货入库', '货物已由【郑州市】【省外分拣】卸货入库', '省外分拣', 'in_transit'],
      ['2026-11-13T18:24:37+08:00', '网点发车', '货物已由【丁栾镇】发往【郑州物流中心】', '丁栾镇', 'in_transit'],
      ['2026-11-13T18:20:16+08:00', '货物配载', '下一站网点【丁栾镇】装车，下一站网点【郑州物流中心】', '丁栾镇', 'in_transit'],
      ['2026-11-13T12:04:07+08:00', '收货开单', '货物已由【丁栾镇】揽收，信息已录入系统', '丁栾镇', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time && !event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/电话|车牌|驾驶员|编号|胡景尧|高红彪|豫G|\d{7,}/);
  });

  it('keeps a transfer\'s partner, its waybill and station without its phone', () => {
    const result = parseHongtai(fixture('transferred.json'), TRANSFERRED);
    expect(result.events!.find(event => event.provider_code === '货物转出')).toMatchObject({
      description: '货物已转出，承运商单号【151271】承运商【中龙龙山】承运到站【龙山】', location: '湖南库', stage: 'in_transit' });
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-11-18T09:52:03+08:00' });
    expect(JSON.stringify(result)).not.toMatch(/0743|联系方式/);
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found.json')));
    await expect(new HongtaiTracker({ fetcher }).fetch('999999990')).rejects.toMatchObject({ kind: 'not_found' });
    for (const reply of [edited(reply => { reply.rows[3]!.eventNo = '262776664'; }),
      edited(reply => { reply.rows[3]!.eventTime = 'soon'; }),
      edited(reply => { reply.rows[3]!.eventTimeStr = '2026-11-14 18:26:38'; }),
      edited(reply => { (reply as Record<string, unknown>).rows = {}; })]) {
      expect(() => parseHongtai(reply, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const number of ['26277666', '2627766630', 'HT262776663']) {
      expect(() => normalizeHongtaiNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps failures, checks and malformed replies distinct', async () => {
    expect(() => parseHongtai({ code: '500', msg: '系统异常' }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHongtai({ code: '500', msg: '请求过于频繁' }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => hongtaiJson('<html><title>Just a moment...</title></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => hongtaiJson('<html>maintenance</html>')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const [status, kind] of [[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('{}', status));
      await expect(new HongtaiTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the nodes and leaves others without a stage', () => {
    expect(statusMap.stage('客户签收', '')).toBe('delivered');
    expect(statusMap.stage('整车签收', '')).toBe('in_transit');
    expect(statusMap.stage('货物异常', '')).toBeUndefined();
    const result = parseHongtai(edited(reply => {
      reply.rows.push({ ...reply.rows.at(-1)!, eventNodeValue: '货物异常', eventLog: '货物异常【长治】', eventTime: 1794648398409 + 2 * 86_400_000,
        eventTimeStr: '2026-11-16 17:26:38' });
    }), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '货物异常', description: '货物异常【长治】' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.current_stage).toBe('delivered');
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('hongtai-logistics');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'hongtai-logistics', number: DELIVERED });
    expect(tracked.source).toBe('hongtai-logistics');
    expect(tracked.result.status).toBe('delivered');
  });
});
