import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CYXFX_API, CyxfxTracker } from './adapter.js';
import { cyxfxText, normalizeCyxfxNumber, parseCyxfx, sfRoute } from './parser.js';
import { cyxfxStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = '7099000000';
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
type Name = 'delivered' | 'not-found';
type Row = Record<string, unknown> & { Status: string; Remark: string; Thrd_trace: string };
type Reply = { ErrorCode: string; Msg: string; Data: ({ sn: string; rows: Row[] } & Record<string, unknown>)[] | null };
const text = (name: Name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: Name) => JSON.parse(text(name)) as Reply;
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });
// SF Express's route for the hand-off number, as the page draws it: synthetic scans with a courier and a phone.
const route = (mailno: string) => JSON.stringify({ '?xml': { _version: '1.0' }, Response: { _service: 'RouteService', Head: 'OK', Body: {
  RouteResponse: { _mailno: mailno, Route: [
    { _accept_time: '2026-01-23 20:10:00', _accept_address: '上海市', _remark: '顺丰速运 已收取快件', _opcode: '50' },
    { _accept_time: '2026-01-24 09:30:00', _accept_address: '上海市', _remark: '快件交给张三，正在派送途中（联系电话：13800000000）', _opcode: '44' },
  ] },
} } });

describe('C&Y Global Logistics tracking lookup', () => {
  it('posts the whole number to the service through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new CyxfxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${NUMBER.slice(0, 4)}-${NUMBER.slice(4)} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(11);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(CYXFX_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ sns: NUMBER });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cyxfx', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, Aurora\'s clock until the flight lands and China\'s after, with SF Express as the courier', () => {
    const result = parseCyxfx(json('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收', last_update: '2026-01-24T20:13:33+08:00', last_update_local: '2026-01-24T20:13:33',
      expected_delivery: null, destination_country: 'CN', delivery_carrier: 'sf-express', delivery_tracking_number: '329250071839' });
    expect(result.events!.map((event) => [event.provider_code, event.description, event.stage, event.time_zone])).toEqual([
      ['110', '已签收', 'delivered', 'Asia/Shanghai'],
      ['110', '国内开始派送,快递公司:顺丰速运,单号:329250071839', 'in_transit', 'Asia/Shanghai'],
      ['9500', '清关完成，进入国内物流环节，请您耐心等待派送', 'in_transit', 'Asia/Shanghai'],
      ['9000', '已运抵 待申报', 'customs', 'Asia/Shanghai'],
      ['8100', '航班到达', 'in_transit', 'Asia/Shanghai'],
      ['8000', '国际运输环节中', 'in_transit', 'America/Chicago'],
      ['7000', '包裹已出库 送往机场', 'in_transit', 'America/Chicago'],
      ['5000', '组批次', 'in_transit', 'America/Chicago'],
      ['4000', '仓库已收款', 'accepted', 'America/Chicago'],
      ['3000', '集散仓已收货', 'accepted', 'America/Chicago'],
      ['10', '运单创建', 'registered', 'America/Chicago'],
    ]);
    expect(result.events![4]).toEqual({ time: '2026-01-22T09:00:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'destination',
      local_time: '2026-01-22T09:00:00', description: '航班到达', provider_code: '8100', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![9]).toMatchObject({ time: '2026-01-12T09:04:13-06:00', time_zone: 'America/Chicago', time_zone_basis: 'carrier',
      local_time: '2026-01-12T09:04:13' });
    expect(JSON.stringify(result)).not.toMatch(/\*|13800000000|联系人|手机|addr|天津|上海市/);
  });

  it('adds SF Express\'s route for the hand-off number, without the courier or a phone, and no route for another number', () => {
    const payload = json('delivered');
    const rows = payload.Data![0]!.rows;
    const handoff = rows.find((entry) => entry.Remark.startsWith('国内开始派送'))!;
    const withRoute = (trace: string) => ({ ...payload, Data: [{ ...payload.Data![0]!, rows: rows.map((entry) => entry === handoff
      ? { ...entry, Thrd_trace: trace } : entry) }] });
    const result = parseCyxfx(withRoute(route('329250071839')), NUMBER, READ_AT);
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null])).toEqual(expect.arrayContaining([
      ['2026-01-24T09:30:00', '正在派送途中', '上海市'], ['2026-01-23T20:10:00', '顺丰速运 已收取快件', '上海市'],
    ]));
    expect(result.events!.slice(0, 3).map((event) => event.local_time)).toEqual(['2026-01-24T20:13:33', '2026-01-24T09:30:00', '2026-01-23T20:10:00']);
    expect(result.events![1]).toEqual({ time: '2026-01-24T09:30:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'destination',
      local_time: '2026-01-24T09:30:00', location: '上海市', description: '正在派送途中', stage: 'out_for_delivery', stage_source: 'carrier_map' });
    expect(result.events![2]).toMatchObject({ stage: 'accepted' });
    expect(JSON.stringify(result)).not.toMatch(/张三|13800000000/);
    expect(parseCyxfx(withRoute(route('329250071840')), NUMBER, READ_AT).events).toHaveLength(11);
    expect(parseCyxfx(withRoute('{"Response":'), NUMBER, READ_AT).events).toHaveLength(11);
    expect(sfRoute(route('329250071839'), '329250071840')).toEqual([]);
  });

  it('takes the agents, couriers, signers and phones out of a remark', () => {
    expect(cyxfxText('已运抵 待申报，客服咨询联系人：*女士 手机号：13800000000')).toBe('已运抵 待申报');
    expect(cyxfxText('国内开始派送,快递公司:顺丰速运,单号:329250071839')).toBe('国内开始派送,快递公司:顺丰速运,单号:329250071839');
    expect(cyxfxText('已签收,他人代收：某小区门卫,投递员:某人,电话:13800000000')).toBe('已签收,他人代收');
    expect(cyxfxText('【罗源城关营业部】安排投递,投递员:某人,电话:13800000000,揽投部电话:13800000001')).toBe('【罗源城关营业部】安排投递');
    expect(cyxfxText('派件员 某人 13800000000')).toBe('');
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parseCyxfx(json('delivered'), NUMBER, Date.parse('2026-01-24T10:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2026-01-23T16:01:41+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-01-24T20:13:33' });
  });

  it('reads the tracker\'s wrong-number answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseCyxfx(json('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCyxfx({ ...json('not-found'), Msg: '请求过于频繁' }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCyxfx({ ErrorCode: '0', Msg: '', Data: [] }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const payload = json('delivered');
    expect(() => parseCyxfx(payload, '7013052115', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCyxfx({ ...payload, Data: [{ ...payload.Data![0]!, rows: [] }] }, NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const clock = { ...payload, Data: [{ ...payload.Data![0]!, rows: [{ ...payload.Data![0]!.rows[0]!, Adddate: '2026/02/30 10:00:00' }] }] };
    expect(() => parseCyxfx(clock, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCyxfx({ Data: [] }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new CyxfxTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.cyxfx.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>Runtime Error</html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, one number, without a request', async () => {
    expect(normalizeCyxfxNumber(NUMBER)).toBe(NUMBER);
    for (const number of ['7013052', 'ABCDEFGHIJ', `7${'1'.repeat(30)}`, `${NUMBER},${UNKNOWN}`, '']) {
      expect(() => normalizeCyxfxNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new CyxfxTracker({ fetcher }).fetch('7013"}')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new CyxfxTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'cyxfx', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('offers C&Y for no number shape', () => {
    for (const record of numbers.records) expect(detectCarrierMatch(record.number).candidates).not.toContain('cyxfx');
  });

  it('maps each code and remark in statuses.json, a code of one stage without its remark, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage('110', normalizeStatusWording('国内开始派送,快递公司:顺丰速运,单号:SF1234567890123'))).toBe('in_transit');
    expect(statusMap.stage('9000', '已运抵')).toBe('customs');
    expect(statusMap.stage('110', '新的状态')).toBeUndefined();
    expect(cyxfxStage('新的状态', '110', '已签收')).toMatchObject({ stage: 'delivered' });
    expect(cyxfxStage('新的状态', '12345')).toBeNull();
  });
});
