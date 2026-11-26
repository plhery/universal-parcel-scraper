import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, uniconTrackerUrl } from './adapter.js';
import { normalizeUniconNumber, parseUnicon, uniconText } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and the invented number fixtures/not-found.html answers.
const SAMPLE = 'LH2300315428';
const UNKNOWN = 'LH9999999999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (day: string, time: string, text: string) =>
  `<tr><td class="row1"><span class="day">${day}</span> <span class="time"> ${time}</span></td><td class="status"></td><td class="context">${text}</td></tr>`;
/** The public sample's page with only these rows. */
const withRows = (...rows: string[]) => fixture('delivered').replace(/(<tbody>)[\s\S]*?(<\/tbody>)/, `$1${rows.join('')}$2`);

describe('UNICON Express USA numbers', () => {
  it('takes LH and ten digits', () => {
    expect(normalizeUniconNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const other of ['', 'LH230031542', 'LH23003154280', 'LX2300315428', '2300315428', 'X'.repeat(70)]) {
      expect(() => normalizeUniconNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('UNICON Express USA tracking adapter', () => {
  it('asks the tracker’s result page for the waybill over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://www.lianhesudi.com/index.php?s=/Index/chaxun&sn=LH2300315428');
    expect(uniconTrackerUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'unicon-express-us', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number UNICON does not issue without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'LH123' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the tracker’s "未找到 … 相关信息!" row as not found', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('not-found')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, verification pages, error pages and redirects apart from a missing waybill', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Runtime Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Service Unavailable</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/index.php' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('UNICON Express USA pages', () => {
  it('reads the public sample: wall clocks newest first, SF’s cities as places, the courier in China', () => {
    const result = parseUnicon(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已签收，感谢您使用顺丰，期待再次为您服务。（主单总件数：1件）',
      last_update: null, last_update_local: '2023-07-06T12:44:00', expected_delivery: null,
      delivery_carrier: 'sf-express', delivery_tracking_number: 'SF1669655531324',
    });
    expect(result.events).toHaveLength(25);
    expect(result.events![0]).toEqual({ local_time: '2023-07-06T12:44:00', location: '北京市', stage: 'delivered', stage_source: 'carrier_map',
      description: '您的快件已签收，感谢您使用顺丰，期待再次为您服务。（主单总件数：1件）' });
    expect(result.events![2]).toEqual({ local_time: '2023-07-06T07:27:00', location: '北京市', stage: 'out_for_delivery', stage_source: 'carrier_map',
      description: '快件正在派送途中（主单总件数：1件）' });
    expect(result.events!.find((event) => event.description!.startsWith('包裹派送中'))).toEqual({ local_time: '2023-07-03T17:30:00',
      description: '包裹派送中，已转顺丰速运快递，快递单号为SF1669655531324', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2023-06-20T17:38:00', description: '您的运单创建成功 准备发出', stage: 'registered', stage_source: 'carrier_map' });
    // The identity card moves nothing; every other row has a stage from the map.
    expect(result.events!.at(-2)).toEqual({ local_time: '2023-06-20T17:38:00', description: '系统已收到客户身份证信息' });
    expect(result.events!.filter((event) => event.stage_source !== 'carrier_map')).toHaveLength(1);
    // No courier's name or phone number is kept.
    expect(JSON.stringify(result)).not.toMatch(/15701173897|李文峰|电联快递员/);
  });

  it('takes the courier’s name and phone number out of SF’s rows', () => {
    expect(uniconText('您的快件已签收，如有疑问请电联快递员【示例，电话：13800000000】，感谢您使用顺丰，期待再次为您服务。'))
      .toBe('您的快件已签收，感谢您使用顺丰，期待再次为您服务。');
    expect(uniconText('快件交给示例，正在派送途中（联系电话：13800000000，顺丰已开启“安全呼叫”保护您的电话隐私,请放心接听！）'))
      .toBe('快件正在派送途中');
    expect(uniconText('快件已签收，签收人是：示例，投递员：示例员，电话 138 0000 0000')).toBe('快件已签收');
    // A reason that only mentions a phone, a depot and a waybill stay.
    expect(uniconText('快件派送不成功(因电话无人接听/关机/无信号，暂无法联系到收方客户),正在处理中,待再次派送'))
      .toBe('快件派送不成功(因电话无人接听/关机/无信号，暂无法联系到收方客户),正在处理中,待再次派送');
    expect(uniconText('快件到达 【军事博物馆店】')).toBe('快件到达 【军事博物馆店】');
    expect(uniconText('包裹派送中，已转顺丰速运快递，快递单号为587056104998')).toBe('包裹派送中，已转顺丰速运快递，快递单号为587056104998');
  });

  it('names the courier in China only when its rules offer the number', () => {
    const handoff = (courier: string, number: string) => withRows(row('2026-11-20', '17:30', `包裹派送中，已转${courier}快递，快递单号为${number}`));
    expect(parseUnicon(handoff('中国邮政', 'EX000000017CN'), SAMPLE)).toMatchObject({ delivery_tracking_number: 'EX000000017CN', current_stage: 'in_transit' });
    expect(parseUnicon(handoff('中国邮政', 'EX000000017CN'), SAMPLE)).not.toHaveProperty('delivery_carrier');
    expect(parseUnicon(handoff('顺丰速运', 'AB1234567'), SAMPLE)).not.toHaveProperty('delivery_carrier');
    expect(parseUnicon(withRows(row('2026-11-20', '17:30', '包裹到达美国集货仓')), SAMPLE)).not.toHaveProperty('delivery_tracking_number');
  });

  it('refuses a page for another waybill, and a changed page', () => {
    expect(() => parseUnicon(fixture('delivered'), 'LH2300315429')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUnicon(fixture('not-found'), 'LH2300315429')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const page of [
      withRows(row('2026-13-22', '04:25', '快件到达 【军事博物馆店】')),
      withRows(row('2026-11-22', '24:25', '快件到达 【军事博物馆店】')),
      withRows(row('22/11/2026', '04:25', '快件到达 【军事博物馆店】')),
      withRows(row('2026-11-22', '04:25', '')),
      withRows(row('2026-11-22', '04:25', '快件到达'), '<tr><td>2026-11-21 04:25</td><td>快件到达</td></tr>'),
      fixture('delivered').replace('id="order_sn"', 'id="sn"'),
      fixture('delivered').replace('class="result-info"', 'class="result"'),
      '',
    ]) expect(() => parseUnicon(page, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUnicon(withRows(), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
  });

  it('answers each wording statuses.json records by its stage, or as a gap', () => {
    for (const { wording, stage } of statuses.entries as { wording: string; stage?: string }[]) {
      expect(statusMapAnswer({ carrier: 'unicon-express-us', providerCode: null, description: wording }), wording)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage/) });
    }
    // SF's rows name other depots, UNICON's other warehouses, and the hand-off other couriers and numbers.
    for (const wording of ['快件到达 【北京顺义集散中心】', '仓库已称重入库 LAX分拨中心', '包裹派送中，已转中国邮政快递，快递单号为EX000000017CN']) {
      expect(statusMapAnswer({ carrier: 'unicon-express-us', providerCode: null, description: normalizeStatusWording(wording) }), wording)
        .toEqual({ kind: 'mapped', stage: wording.startsWith('仓库') ? 'accepted' : 'in_transit' });
    }
  });
});
