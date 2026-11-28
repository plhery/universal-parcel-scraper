import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, normalizeParcel100Number, PARCEL100_TRACK, Parcel100Tracker, parcel100LookupUrl, parcel100Text, parseParcel100 } from './adapter.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const RELAYED = numbers.records[1]!.number;
const UNKNOWN = 'PK00099999';
type Fixture = 'delivered' | 'relayed' | 'not-found';
const text = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: Fixture) => JSON.parse(text(name)) as Record<string, unknown>;
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('Parcel100 tracking lookup', () => {
  it('asks the tracking service for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 2)} ${NUMBER.slice(2, 6)}-${NUMBER.slice(6)}`.toLowerCase();
    const result = await new Parcel100Tracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '签收成功' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(parcel100LookupUrl(NUMBER));
    expect(String(url)).toBe(`${PARCEL100_TRACK}?numbers[]=${NUMBER}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'parcel100', step: 'direct', outcome: 'ok' }));
  });

  it('reads the test number newest first by its codes, on wall clocks alone', () => {
    const result = parseParcel100(json('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '签收成功', last_update: null, last_update_local: '2024-04-06T08:12:32', expected_delivery: null });
    const events = result.events!;
    expect(events.map((event) => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2024-04-06T08:12:32', '90', 'delivered'],
      ['2024-03-13T11:46:01', '80', 'in_transit'],
      ['2024-03-13T11:46:01', '78', 'in_transit'],
      ['2024-03-12T03:30:35', '70', 'customs'],
      ['2024-03-09T05:35:53', '68', 'in_transit'],
      ['2024-03-06T04:32:15', '60', 'in_transit'],
      ['2024-03-06T04:31:43', '55', 'in_transit'],
      ['2024-03-05T10:08:20', '50', 'in_transit'],
      ['2024-03-05T06:44:30', '45', 'in_transit'],
      ['2024-03-05T06:43:58', '30', 'accepted'],
      ['2024-03-05T06:35:30', '10', 'registered'],
    ]);
    expect(events.every((event) => event.time === undefined && event.time_zone === undefined && event.location === undefined)).toBe(true);
    expect(events[5]).toEqual({ local_time: '2024-03-06T04:32:15', description: '包裹已经送达荷兰阿姆斯特丹机场，航班即将飞行中',
      provider_code: '60', stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('reads the courier\'s relayed rows by their wording and place, without contacts', () => {
    const result = parseParcel100(json('relayed'), RELAYED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '签收成功',
      last_update_local: '2025-03-29T21:24:30' });
    const events = result.events!;
    expect(events).toHaveLength(30);
    expect(events[1]).toEqual({ local_time: '2025-01-27T10:36:16', location: '南口孝柱便利店中邮驿站',
      description: '您的快件已签收【南口孝柱便利店中邮驿站】，连接美好，无处不在，感谢您使用中国邮政，期待再次为您服务',
      stage: 'delivered', stage_source: 'wording:language' });
    expect(events[2]).toMatchObject({ description: '您的快件已派送至【南口孝柱便利店中邮驿站】，请您凭取件码领取快件', stage: 'ready_for_pickup' });
    expect(events[4]).toEqual({ local_time: '2025-01-25T11:20:22', location: '瑞安市陶山第四揽投部', description: '快件到达【瑞安市陶山第四揽投部】' });
    expect(events.find((event) => event.provider_code === '11')).toMatchObject({ description: '已下载1次面单' });
    expect(events.find((event) => event.provider_code === '11')).not.toHaveProperty('stage');
    expect(events.at(-1)).toMatchObject({ local_time: '2025-01-08T18:05:23', provider_code: '10', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/某某|13800000000|0577-|11183|电话/);
  });

  it('leaves out a bracket or clause that gives a contact', () => {
    expect(parcel100Text('快件已在【广州市国际快件营业部】完成分拣，准备发出')).toBe('快件已在【广州市国际快件营业部】完成分拣，准备发出');
    expect(parcel100Text('您的快件已签收【某驿站】，如有疑问请电联快递员【某某，电话:13800000000】。'))
      .toBe('您的快件已签收【某驿站】');
    expect(parcel100Text('快件到达【某站，二部】，自提点电话:13800000000，请您凭取件码领取快件')).toBe('快件到达【某站，二部】，请您凭取件码领取快件');
    expect(parcel100Text('电话:13800000000')).toBe('');
  });

  it('passes over a notice and keeps the delivery under it', () => {
    const payload = json('delivered');
    const parcel = (payload.data as { logs: unknown[] }[])[0]!;
    parcel.logs.unshift({ created_at: '2024-04-07 09:00:00', status_name: '包裹支付', status_code: 25, is_sys_time: true });
    const result = parseParcel100(payload, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '包裹支付', last_update_local: '2024-04-07T09:00:00' });
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseParcel100(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseParcel100(json('delivered'), RELAYED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseParcel100({ status: false, code: 4290, msg: '请求过于频繁', data: [] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseParcel100({ status: true, code: 1000, msg: '操作成功', data: [{ parcel_number: NUMBER, logs: [] }] }, NUMBER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const badClock = text('delivered').replace('2024-04-06 08:12:32', '2024-04-31 08:12:32');
    expect(() => parseParcel100(JSON.parse(badClock), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseParcel100({ status: true, data: 'none' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseParcel100([], NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: BodyInit, init?: ResponseInit) => new Parcel100Tracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(new Parcel100Tracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(text('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.parcel100.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a parcel number shape only, without a request', async () => {
    expect(normalizeParcel100Number(` ${NUMBER} `)).toBe(NUMBER);
    expect(normalizeParcel100Number('pk-0007 3381')).toBe('PK00073381');
    for (const number of ['PK001', 'ABCDEFGHIJ', '1'.repeat(31), 'PK0007/3381', '']) {
      expect(() => normalizeParcel100Number(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new Parcel100Tracker({ fetcher }).fetch('PK001')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new Parcel100Tracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'parcel100', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps its own codes and leaves the notices without a stage', () => {
    expect(statusMap.stage('90', '签收成功')).toBe('delivered');
    expect(statusMap.stage('80', '派送中')).toBe('in_transit');
    expect(statusMap.stage('11', '已下载1次面单')).toBeUndefined();
    expect(statusMap.stage(null, '签收成功')).toBeUndefined();
    expect(statusMap.gaps.map((gap) => gap.code)).toEqual(['11', '25']);
  });
});
