import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ZTCCE } from './adapter.js';
import { KDFEI_API, kdfeiStage, kdfeiText, KdfeiTracker, normalizeKdfeiNumber, parseKdfei, type KdfeiSite } from './kdfei.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const LAS_VEGAS = numbers.records[0]!.number;
const AUSTIN = numbers.records[1]!.number;
const UNKNOWN = 'SYS999000000';
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
type Name = 'austin' | 'las-vegas';
type Row = { context: string; createtime: string; state: string; expresscode: string };
type Reply = Record<string, unknown> & { state: number; pkval: string; startcity: string; expresscom: string; expressid: string; list: Row[] };
const text = (name: Name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: Name) => JSON.parse(text(name)) as Reply;
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('ZTCCE tracking lookup', () => {
  it('posts the tenant code and the whole number to the kdfei service through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('las-vegas')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new KdfeiTracker(ZTCCE, { fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${LAS_VEGAS.toLowerCase()} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(7);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(KDFEI_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: 'https://www.ztcce.com',
      Referer: `https://www.ztcce.com/waybill.html?order=${LAS_VEGAS}`, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ param: 'ao', searchkey: LAS_VEGAS });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ztcce', step: 'direct', outcome: 'ok' }));
  });

  it('reads a Las Vegas waybill on Pacific time until it reaches China and on China\'s after, with SF Express as the courier', () => {
    const result = parseKdfei(ZTCCE, text('las-vegas'), LAS_VEGAS, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '包裹清关完成,进入国内物流环节，请耐心等待派送', last_update: '2025-08-07T05:00:12+08:00',
      last_update_local: '2025-08-07T05:00:12', expected_delivery: null, destination_country: 'CN',
      delivery_carrier: 'sf-express', delivery_tracking_number: json('las-vegas').expressid });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.stage])).toEqual([
      ['2025-08-07T05:00:12+08:00', '清关放行', '包裹清关完成,进入国内物流环节，请耐心等待派送', 'in_transit'],
      ['2025-08-06T05:00:02+08:00', '到达国内', '包裹到达中国口岸，正在办理清关手续', 'customs'],
      ['2025-07-31T07:43:40-07:00', '发往中国途中', '国际运输环节中', 'in_transit'],
      ['2025-07-30T07:43:17-07:00', '运往机场', '已装载完成，发往机场', 'in_transit'],
      ['2025-07-28T17:23:44-07:00', '仓库已出库', '仓库已出库', 'in_transit'],
      ['2025-07-27T17:22:42-07:00', '仓库已入库', '仓库已入库', 'accepted'],
      ['2025-07-27T15:21:19-07:00', '已揽收', '拉斯维加斯仓库已揽收', 'accepted'],
    ]);
    expect(result.events![1]).toEqual({ time: '2025-08-06T05:00:02+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'destination',
      local_time: '2025-08-06T05:00:02', description: '包裹到达中国口岸，正在办理清关手续', provider_code: '到达国内',
      stage: 'customs', stage_source: 'carrier_map' });
    expect(result.events![6]).toMatchObject({ time_zone: 'America/Los_Angeles', time_zone_basis: 'place', local_time: '2025-07-27T15:21:19' });
  });

  it('dates an Austin waybill on Central time, and a warehouse the tenant does not place on its wall clock alone', () => {
    const result = parseKdfei(ZTCCE, text('austin'), AUSTIN, READ_AT);
    expect(result).toMatchObject({ delivery_carrier: 'sf-express', delivery_tracking_number: 'SF1038259217766', destination_country: 'CN' });
    expect(result.events!.map((event) => [event.time, event.time_zone])).toEqual([
      ['2021-01-06T13:20:04+08:00', 'Asia/Shanghai'], ['2021-01-05T11:19:54+08:00', 'Asia/Shanghai'],
      ['2021-01-04T13:31:26+08:00', 'Asia/Shanghai'], ['2020-12-20T10:36:45-06:00', 'America/Chicago'],
      ['2020-12-18T18:42:01-06:00', 'America/Chicago'], ['2020-12-18T16:36:59-06:00', 'America/Chicago'],
      ['2020-12-16T17:13:08-06:00', 'America/Chicago'],
    ]);
    const elsewhere = parseKdfei(ZTCCE, JSON.stringify({ ...json('austin'), startcity: 'Seattle' }), AUSTIN, READ_AT);
    expect(elsewhere.events![3]).toEqual({ local_time: '2020-12-20T10:36:45', description: '正在发往中国途中', provider_code: '发往中国途中',
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(elsewhere.events![2]).toMatchObject({ time: '2021-01-04T13:31:26+08:00' });
  });

  it('hands off only to a courier the reply names whose rules offer the number', () => {
    const handed = (change: Partial<Reply>) => parseKdfei(ZTCCE, JSON.stringify({ ...json('austin'), ...change }), AUSTIN, READ_AT);
    expect(handed({ expresscom: '', expressid: 'SF1038259217766' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ expresscom: '顺丰北', expressid: '' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ expresscom: '顺丰北', expressid: '1234' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ expresscom: '顺丰北', expressid: AUSTIN })).not.toHaveProperty('delivery_carrier');
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parseKdfei(ZTCCE, text('las-vegas'), LAS_VEGAS, Date.parse('2025-08-06T20:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2025-08-06T05:00:02+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2025-08-07T05:00:12' });
  });

  it('takes couriers, signers and phones out of a text', () => {
    expect(kdfeiText('已签收,他人代收：某小区门卫,快递员:某人,电话:13800000000')).toBe('已签收,他人代收');
    expect(kdfeiText('包裹清关完成,进入国内物流环节，请耐心等待派送')).toBe('包裹清关完成,进入国内物流环节，请耐心等待派送');
    expect(kdfeiText('派件员 某人 13800000000')).toBe('');
  });

  it('reads an empty answer with HTTP 200 as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseKdfei(ZTCCE, '', UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseKdfei(ZTCCE, ' \r\n', UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseKdfei(ZTCCE, '{"state":0,"message":"查询失败"}', UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKdfei(ZTCCE, text('austin'), 'SYS000000288', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKdfei(ZTCCE, JSON.stringify({ ...json('austin'), list: [] }), AUSTIN, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const clock = { ...json('austin'), list: [{ ...json('austin').list[0]!, createtime: '2021-02-30 10:00:00' }] };
    expect(() => parseKdfei(ZTCCE, JSON.stringify(clock), AUSTIN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKdfei(ZTCCE, '[]', AUSTIN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKdfei(ZTCCE, '<html>Runtime Error</html>', AUSTIN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new KdfeiTracker(ZTCCE, { fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 400 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.kdfei.cn/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, one number, without a request', async () => {
    expect(normalizeKdfeiNumber(ZTCCE, AUSTIN.toLowerCase())).toBe(AUSTIN);
    for (const number of ['T2026', 'ZTCCEZTCCE', `T${'1'.repeat(30)}`, `${AUSTIN},${LAS_VEGAS}`, '']) {
      expect(() => normalizeKdfeiNumber(ZTCCE, number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new KdfeiTracker(ZTCCE, { fetcher }).fetch('SYS000&param=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new KdfeiTracker(ZTCCE, { fetcher }).fetch(AUSTIN, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'ztcce', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('sends another tenant\'s code for a site that brings its own', async () => {
    const other: KdfeiSite = { ...ZTCCE, carrier: 'other', provider: 'Other', tenant: 'zz', page: 'https://example.com/track.html' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(''));
    await expect(new KdfeiTracker(other, { fetcher }).fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    expect(Object.fromEntries(new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body)))).toEqual({ param: 'zz', searchkey: UNKNOWN });
  });

  it('offers ZTCCE for no number shape', () => {
    for (const record of numbers.records) expect(detectCarrierMatch(record.number).candidates).not.toContain('ztcce');
  });

  it('maps each state and text in statuses.json, a state of one stage without its text, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage('已揽收', normalizeStatusWording('奥斯汀仓库已揽收'))).toBe('accepted');
    expect(statusMap.stage('到达国内', '新的状态')).toBeUndefined();
    expect(kdfeiStage(ZTCCE, '新的状态', '清关中')).toMatchObject({ stage: 'customs' });
    expect(kdfeiStage(ZTCCE, '新的状态', '新的')).toBeNull();
  });
});
