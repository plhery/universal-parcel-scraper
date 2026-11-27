import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HJWL_API, HJWL_SITE, HjwlTracker, hjwlLookupUrl } from './adapter.js';
import { hjwlWording, normalizeHjwlNumber, parseHjwl } from './parser.js';
import { hjwlStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'HJWL99999999999999';
// After the sample's newest node.
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
type Node = { number: string; status: string; message: string; createTime: string };
type Reply = { code: number; success: boolean; data: Node[]; msg: string };
const text = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: 'delivered' | 'not-found') => JSON.parse(text(name)) as Reply;
const withNodes = (map: (node: Node, index: number) => Node) => {
  const payload = json('delivered');
  return { ...payload, data: payload.data.map(map) };
};
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' }, ...init });

describe('HJWL tracking lookup', () => {
  it('asks the service for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 4).toLowerCase()} ${NUMBER.slice(4, 12)}-${NUMBER.slice(12)}`;
    const result = await new HjwlTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(hjwlLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(HJWL_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ number: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: HJWL_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(init!.headers).not.toHaveProperty('Authorization');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hjwl', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, each node on China\'s clock, staged by its status', () => {
    const result = parseHjwl(json('delivered'), NUMBER, READ_AT);
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '快件已签收', last_update: '2023-06-14T17:22:11+08:00', last_update_local: '2023-06-14T17:22:11', expected_delivery: null }));
    const events = result.events!;
    expect(events.map((event) => [event.provider_code, event.stage])).toEqual([
      ['已签收', 'delivered'], ['配送中', 'out_for_delivery'], ['已发货', 'in_transit'], ['已发货', 'in_transit'], ['已揽收', 'accepted'],
      ['已下单', 'registered'],
    ]);
    expect(events[0]).toEqual({ time: '2023-06-14T17:22:11+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2023-06-14T17:22:11', description: '快件已签收', provider_code: '已签收', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[3]).toMatchObject({ local_time: '2023-06-14T06:29:47', description: '快件从上海黄浦区出发' });
    expect(events[5]).toMatchObject({ time: '2023-06-13T18:23:46+08:00', description: '2023-06-13 18:23:46快递已下单', stage: 'registered' });
    expect(events.every((event) => !('location' in event))).toBe(true);
  });

  it('keeps nodes entered at one clock in the reply\'s order, the later one newer, and leaves a clock after the lookup its wall clock alone', () => {
    const same = withNodes((node, index) => (index === 3 ? { ...node, createTime: '2023-06-14 06:29:47' } : node));
    expect(parseHjwl(same, NUMBER, READ_AT).events!.slice(2, 4).map((event) => event.description))
      .toEqual(['快件在上海浦东新区张江高科技园区中转', '快件从上海黄浦区出发']);
    const early = parseHjwl(json('delivered'), NUMBER, Date.parse('2023-06-14T09:00:00Z'));
    expect(early.events![0]).toEqual({ local_time: '2023-06-14T17:22:11', description: '快件已签收', provider_code: '已签收',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(early).toMatchObject({ last_update: null, last_update_local: '2023-06-14T17:22:11' });
  });

  it('keeps no courier\'s name or phone, signatory or other contact from a message', () => {
    expect(hjwlWording('快件已被快递员张三，联系电话13800000000揽收')).toBe('快件已被快递员揽收');
    expect(hjwlWording('快件已签收，签收人：本人')).toBe('快件已签收');
    expect(hjwlWording('快件正在派送中，电话 0311-87654321')).toBe('快件正在派送中');
    expect(hjwlWording('快件已由王五签收')).toBe('快件已签收');
    expect(hjwlWording('2023-06-13 18:23:46快递已下单')).toBe('2023-06-13 18:23:46快递已下单');
    const phone = withNodes((node, index) => (index === 4 ? { ...node, message: '13800000000' } : node));
    expect(parseHjwl(phone, NUMBER, READ_AT).events![1]).toMatchObject({ description: '配送中', provider_code: '配送中' });
  });

  it('reads the empty answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHjwl(json('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A node of another number: the service no longer reads the number alone.
    const mixed = withNodes((node, index) => (index === 2 ? { ...node, number: 'HJWL20230613182347' } : node));
    expect(() => parseHjwl(mixed, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHjwl(json('delivered'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHjwl({ ...json('not-found'), msg: '暂无承载数据' }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHjwl({ code: 401, success: false, data: null, msg: '请求未授权' }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHjwl({ code: 200, success: true, data: { records: [] }, msg: '操作成功' }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHjwl(withNodes((node) => ({ ...node, createTime: '2023-06-31 18:23:46' })), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHjwl(withNodes((node) => ({ ...node, status: '', message: ' ' })), NUMBER, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => new HjwlTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(new HjwlTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(text('not-found'))) }).fetch(UNKNOWN, { budgetMs: 5000 }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('{"code":401,"success":false,"msg":"请求未授权"}', { status: 401 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>404 Not Found</title></html>', { status: 404, headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><title>汇捷物流官网</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, never an empty number, without a request', async () => {
    expect(normalizeHjwlNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['', ' ', 'HJWL', 'HJWL1', 'HJWLABCDEFGH', `HJWL${'1'.repeat(40)}`, 'HJWL2023&size=100']) {
      expect(() => normalizeHjwlNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HjwlTracker({ fetcher }).fetch('')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new HjwlTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hjwl', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('detects HJWL and fourteen digits only', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'hjwl', confidence: 'high' });
    for (const number of ['HJWL2023061318234', 'HJWL202306131823461', 'HJW20230613182346', 'HJWX20230613182346']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('hjwl');
    }
  });

  it('maps the nodes by their status, else by the shared wording rules', () => {
    expect(hjwlStage('已揽收')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(statusMap.stage('配送中', '快件正在配送中')).toBe('out_for_delivery');
    expect(statusMap.stage(null, '已签收')).toBeUndefined();
    expect(hjwlStage('', '快件已签收')).toMatchObject({ stage: 'delivered' });
    expect(hjwlStage('其他', '快件已签收')).toMatchObject({ stage: 'delivered' });
  });
});
