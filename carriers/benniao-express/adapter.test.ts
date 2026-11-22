import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { BenniaoTracker, benniaoSignature } from './adapter.js';
import { BENNIAO_ENDPOINT, BENNIAO_ORIGIN, benniaoJson, normalizeBenniaoNumber, parseBenniao } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = 'BN55400024097008';
const INTERCEPTED = 'BN55100094737324';
const PROBLEM = 'BN55400024779801';
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
type Reply = { success: boolean; code: number; msg: string; result: { waybillNum: string; waybillStateInfo: Record<string, unknown>[] | null }[] };
const fixture = (name: string) => JSON.parse(raw(name)) as Reply;
const edited = (edit: (reply: Reply) => void) => { const reply = fixture('delivered.json'); edit(reply); return reply; };
const response = (body: string, status = 200) => new Response(body, { status });

describe('Benniao Express guest adapter', () => {
  it('posts the waybill signed as the search page does, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const result = await new BenniaoTracker({ fetcher, userAgent: 'SyntheticHost/1', now: () => 1795339996000 }).fetch(' bn 5540 0024 0970 08 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(BENNIAO_ENDPOINT);
    const body = JSON.stringify({ nums: [DELIVERED] });
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body, headers: { 'Content-Type': 'application/json',
      'X-Signature': benniaoSignature(body, 1795339996000), 'X-Timestamp': '1795339996000', Origin: BENNIAO_ORIGIN, 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '已签收', last_update: null,
      last_update_local: '2026-11-10T16:40:00' });
  });

  it('signs with the MD5 of the body and the clock, as the page script does', () => {
    // MD5 of '{"nums":["BN55400024097008"]}&timestamp=1795339996000'.
    expect(benniaoSignature('{"nums":["BN55400024097008"]}', 1795339996000)).toBe('b24d4425ccf21e5cf2fbd7a5f8afb941');
  });

  it('keeps local clocks, scans and cities without branch phones, the courier, the signatory or the notice', () => {
    const result = parseBenniao(fixture('delivered.json'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.location, event.stage, event.description]).slice(0, 4)).toEqual([
      ['2026-11-10T16:40:00', '已签收', '平顶山市', 'delivered', '已签收'],
      ['2026-11-08T11:03:31', '已派件', '平顶山市', 'out_for_delivery', '【河南平顶山郏县分部】已派件'],
      ['2026-11-06T18:06:19', '已到达', '平顶山市', 'in_transit', '已到达【河南平顶山郏县分部】，上一站是【漯河分拨中心】'],
      ['2026-11-03T06:10:01', '已发件', '漯河市', 'in_transit', '【漯河分拨中心】已发件，发往下一站【河南平顶山郏县分部】'],
    ]);
    expect(result.events).toHaveLength(11);
    expect(result.events!.find(event => event.local_time === '2026-11-03T06:10:00')!.description).toBe('已到达【漯河分拨中心】');
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-11-02T15:57:31', description: '【安徽阜阳颍上分部】已揽收', stage: 'accepted' });
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/王丽丹|本人|派件员|签收人|客服|物流问题|\d{7,}/);
  });

  it('marks an interception and a problem scan as exceptions and keeps the later scans', () => {
    const intercepted = parseBenniao(fixture('returned.json'), INTERCEPTED);
    expect(intercepted.events!.find(event => event.provider_code === '已操作拦截扫描')).toMatchObject({
      local_time: '2026-08-25T16:09:15', description: '【广东东莞市场一部】已操作拦截扫描，原因【拦截】', location: '东莞市', stage: 'exception' });
    expect(intercepted).toMatchObject({ status: 'delivered', last_update_local: '2026-09-15T02:44:17' });
    expect(JSON.stringify(intercepted)).not.toMatch(/王文强|李冠新|前台|0769|\d{7,}/);
    const problem = parseBenniao(fixture('problem.json'), PROBLEM);
    expect(problem.events!.find(event => event.provider_code === '已操作问题件扫描')).toMatchObject({
      description: '【广州分拨中心】已操作问题件扫描，原因【干线车辆晚点】', location: '广州市', stage: 'exception' });
    expect(problem.events!.find(event => event.description?.startsWith('已到达【揭阳分拨中心】'))!.description).toBe('已到达【揭阳分拨中心】，上一站是【广州分拨中心】');
  });

  it('reports an unknown waybill as not found and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found.json')));
    await expect(new BenniaoTracker({ fetcher }).fetch('BN99999999999990')).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseBenniao(edited(reply => { reply.result[0]!.waybillStateInfo = []; }), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const reply of [edited(reply => { reply.result[0]!.waybillNum = '55400024097009'; }),
      edited(reply => { reply.result[0]!.waybillNum = DELIVERED; }),
      edited(reply => { reply.result.push(reply.result[0]!); }),
      edited(reply => { reply.result[0]!.waybillStateInfo![2]!.date = '2026-02-30 17:21:39'; }),
      edited(reply => { reply.result[0]!.waybillStateInfo![2]!.date = '2026-11-02'; }),
      edited(reply => { (reply as Record<string, unknown>).result = {}; })]) {
      expect(() => parseBenniao(reply, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(normalizeBenniaoNumber('55400024097008')).toBe(DELIVERED);
    for (const number of ['BN5540002409700', 'BN554000240970080', 'BX55400024097008', '5540002409700']) {
      expect(() => normalizeBenniaoNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps refusals, failures, checks and malformed replies distinct', async () => {
    const failure = (msg: string) => ({ success: false, code: 500, msg, result: null });
    expect(() => parseBenniao(failure('官网验签失败'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseBenniao(failure('网络异常..'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBenniao(failure('请求过于频繁'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => benniaoJson('<html><title>Just a moment...</title></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => benniaoJson('<html>maintenance</html>')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const [status, kind] of [[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('{}', status));
      await expect(new BenniaoTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the scans and leaves others without a stage', () => {
    expect(statusMap.stage('已签收', '')).toBe('delivered');
    expect(statusMap.stage('已操作拦截扫描', '')).toBe('exception');
    expect(statusMap.stage('已操作退回扫描', '')).toBeUndefined();
    const result = parseBenniao(edited(reply => {
      reply.result[0]!.waybillStateInfo!.push({ date: '2026-11-11 09:00:00', location: '平顶山市', msg: '【河南平顶山郏县分部(16638679179)】已操作退回扫描' });
    }), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '已操作退回扫描', description: '【河南平顶山郏县分部】已操作退回扫描' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: '【河南平顶山郏县分部】已操作退回扫描' });
  });

  it('detects BN waybills and tracks them', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'benniao-express', confidence: 'high' });
    expect(detectCarrierMatch('55400024097008').candidates ?? []).not.toContain('benniao-express');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ number: DELIVERED });
    expect(tracked.source).toBe('benniao-express');
    expect(tracked.result.status).toBe('delivered');
  });
});
