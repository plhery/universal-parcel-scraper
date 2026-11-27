import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, yuemaTraceUrl } from './adapter.js';
import { normalizeYuemaNumber, parseYuema, yuemaPayload } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and the invented number fixtures/not-found.txt answers.
const SAMPLE = '912001556933';
const UNKNOWN = '912998877665';
const OTHER = 'ZZ998877001';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const SAMPLE_REPLY = () => yuemaPayload(fixture('delivered')) as { data: Record<string, unknown>[]; status: number; message: string };
const SAMPLE_ITEM = () => SAMPLE_REPLY().data[0]!;
const script = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/x-javascript; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The sample's reply under another number, with its item's fields changed. */
const reply = (changes: Record<string, unknown> = {}, bill = OTHER) => ({ ...SAMPLE_REPLY(), data: [{ ...SAMPLE_ITEM(), bill, ...changes }] });
const row = (code: string, time: string, remark: string, state = '') => ({ code, time, state, remark });

describe('Yuema Express numbers', () => {
  it('takes letters and digits, as the tracker does', () => {
    expect(normalizeYuemaNumber(` ${SAMPLE.slice(0, 6)} ${SAMPLE.slice(6)} `)).toBe(SAMPLE);
    expect(normalizeYuemaNumber(OTHER.toLowerCase())).toBe(OTHER);
    for (const other of ['', '12345', 'ABCDEFGH', `${SAMPLE},${UNKNOWN}`, `${SAMPLE}!`, '9'.repeat(31), 'X'.repeat(70)]) {
      expect(() => normalizeYuemaNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Yuema Express tracking adapter', () => {
  it('asks the lookup the tracking page’s script asks, with its callback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => script(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: ` ${SAMPLE} ` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://oa.yue777.com/Weixin/Hg/trace?bill=912001556933&callback=ehandle');
    expect(yuemaTraceUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({
      Referer: 'https://www.yue777.com/genzong.php', 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'yuema-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number the tracker cannot take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: `${SAMPLE},${UNKNOWN}` })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the "快递单号不存在!" item as not found', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => script(fixture('not-found')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, verification pages, error pages and redirects apart from a missing waybill', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => script('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => script('', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>',
      { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<title>Runtime Error</title>', { status: 500, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<html><body>moved</body></html>', { headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.yue777.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => script('ehandle({"data":[{"bill":'))).toMatchObject({ kind: 'schema' });
    // The lookup refuses a request without a number in its own words.
    expect(await answer(() => script('ehandle({"data":"","message":"没有快递单号","status":0})'))).toMatchObject({ kind: 'indeterminate' });
  });
});

describe('Yuema Express replies', () => {
  it('reads the public sample: Yuema’s rows from San Diego to Chinese customs, then SF Express’s to the delivery', () => {
    const result = parseYuema(SAMPLE_REPLY(), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已签收，感谢您使用顺丰，期待再次为您服务。（主单总件数：1件）', last_update: '2023-02-23T10:27:00+08:00',
      expected_delivery: null, delivery_carrier: 'sf-express', delivery_tracking_number: '194912213745',
    });
    const events = result.events!;
    // The row that only named the courier and their phone number is gone.
    expect(events).toHaveLength(30);
    expect(events[0]).toEqual({ local_time: '2023-02-23T10:27:00', time: '2023-02-23T10:27:00+08:00', time_zone: 'Asia/Shanghai',
      time_zone_basis: 'carrier', description: '您的快件已签收，感谢您使用顺丰，期待再次为您服务。（主单总件数：1件）', provider_code: 'QS',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[1]).toMatchObject({ description: '快件正在派送途中（主单总件数：1件）', provider_code: 'ZT', stage: 'out_for_delivery' });
    // Yuema's rows in the United States are on China's clock too: the flight's take-off and landing are a day apart.
    expect(events.filter((event) => ['QF', 'DD'].includes(event.provider_code!)).map(({ local_time, time, location }) => ({ local_time, time, location })))
      .toEqual([
        { local_time: '2023-02-08T01:18:00', time: '2023-02-08T01:18:00+08:00', location: '中国转运中心' },
        { local_time: '2023-02-07T02:18:00', time: '2023-02-07T02:18:00+08:00', location: '美国转运中心' },
      ]);
    // The store took the order and the parcel in one minute: the order comes first, so last when newest first.
    expect(events.slice(-2)).toEqual([
      { local_time: '2022-12-21T08:00:00', time: '2022-12-21T08:00:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
        description: '【San Diego】门店已收货', provider_code: 'LJ', location: 'San Diego', stage: 'accepted', stage_source: 'carrier_map' },
      { local_time: '2022-12-21T08:00:00', time: '2022-12-21T08:00:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
        description: '订单已受理', provider_code: 'LD', location: 'San Diego', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(events.find((event) => event.provider_code === 'RK')).toMatchObject({ location: 'Los Angeles', description: '到达【Los Angele】仓库' });
    expect(events.find((event) => event.provider_code === 'QG')).toMatchObject({ stage: 'customs' });
    // SF's forecast keeps the stage of the row before.
    expect(events.find((event) => event.description!.startsWith('预计'))).not.toHaveProperty('stage');
    // Newest first, and every row on China's clock.
    expect(events.every((event, index) => index === 0 || event.local_time! <= events[index - 1]!.local_time!)).toBe(true);
    expect(events.every((event) => event.time === `${event.local_time}+08:00`)).toBe(true);
    // The courier's name and phone number, and the destination district, stay behind.
    expect(JSON.stringify(result)).not.toMatch(/张三|13800138000|派件人|电话|广西省|quantity/);
    expect(JSON.stringify(result)).not.toContain('发往广西');
  });

  it('names SF Express only for a number SF Express’s own rules take, and no other courier', () => {
    expect(parseYuema(reply({ delivery_no: 'SF1234' }), OTHER)).not.toHaveProperty('delivery_carrier');
    expect(parseYuema(reply({ delivery_no: 'SF1234' }), OTHER)).not.toHaveProperty('delivery_tracking_number');
    expect(parseYuema(reply({ delivery_co: '中通快递' }), OTHER)).not.toHaveProperty('delivery_tracking_number');
    expect(parseYuema(reply({ delivery_co: '', delivery_no: '' }), OTHER)).not.toHaveProperty('delivery_carrier');
    expect(parseYuema(reply({ delivery_co: '顺丰速运' }), OTHER)).toMatchObject({ delivery_carrier: 'sf-express', delivery_tracking_number: '194912213745' });
  });

  it('takes the courier’s name and phone number out of its rows, and drops a row left with nothing', () => {
    const result = parseYuema(reply({ list: [
      row('LJ', '2024-03-01 09:00', '【San Diego】门店已收货', 'San Diego'),
      row('ZT', '2024-03-08 07:43', '(派件人：李四，电话：13900001111)'),
      row('ZT', '2024-03-08 08:12', '快件交给李四，正在派送途中（联系电话：13900001111，顺丰已开启“安全呼叫”保护您的电话隐私,请放心接听！）（主单总件数：1件）'),
      row('ZT', '2024-03-08 11:00', '快件派送不成功(因电话无人接听/关机/无信号，暂无法联系到收方客户),正在处理中,待再次派送'),
    ] }), OTHER);
    expect(result.events!.map(({ description, stage }) => ({ description, stage }))).toEqual([
      { description: '快件派送不成功(因电话无人接听/关机/无信号，暂无法联系到收方客户),正在处理中,待再次派送', stage: 'failed_attempt' },
      { description: '快件正在派送途中（主单总件数：1件）', stage: 'out_for_delivery' },
      { description: '【San Diego】门店已收货', stage: 'accepted' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/李四|13900001111/);
  });

  it('keeps the newest staged row ahead of a newer row the map does not know', () => {
    const result = parseYuema(reply({ list: [row('QG', '2024-03-05 01:30', '清关中', '中国转运中心'), row('XX', '2024-03-06 01:30', '待处理', '中国转运中心')] }), OTHER);
    expect(result).toMatchObject({ current_stage: 'customs', last_status_text: '待处理', events: [{ provider_code: 'XX' }, { provider_code: 'QG' }] });
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('answers only for the whole number asked', () => {
    expect(() => parseYuema(SAMPLE_REPLY(), SAMPLE.slice(0, -1))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYuema(reply(), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYuema({ ...SAMPLE_REPLY(), data: [SAMPLE_ITEM(), SAMPLE_ITEM()] }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The tracker answers several numbers at once; only the item for the number asked counts.
    const both = { ...SAMPLE_REPLY(), data: [(yuemaPayload(fixture('not-found')) as { data: unknown[] }).data[0], SAMPLE_ITEM()] };
    expect(parseYuema(both, SAMPLE)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseYuema(both, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('reads a listed waybill without rows as no history, and another refusal as inconclusive', () => {
    expect(() => parseYuema(reply({ list: [] }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed',
      deliveryCarrier: 'sf-express', deliveryTrackingNumber: '194912213745' }));
    expect(() => parseYuema(reply({ status: 0, topic: '查询失败', list: [] }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYuema(reply({ status: 0, topic: '快递单号不存在!' }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYuema({ data: '', message: '没有快递单号', status: 0 }, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, [], {}, { status: 1, data: {} }, reply({ list: {} }), reply({ list: [null] }), reply({ list: [row('', '2024-03-01 09:00', '清关中')] }),
      reply({ list: [row('QG', '2024-02-30 09:00', '清关中')] }), reply({ list: [row('QG', '01/03/2024 09:00', '清关中')] }),
      reply({ list: [row('QG', '2024-03-01 09:00', '')] }), reply({ list: [{ ...row('QG', '2024-03-01 09:00', '清关中'), remark: { text: '清关中' } }] }),
      reply({ list: [row('ZT', '2024-03-01 09:00', '(派件人：李四，电话：13900001111)')] }), reply({ list: Array.from({ length: 301 }, () => row('ZT', '2024-03-01 09:00', '快件已发车')) })]) {
      expect(() => parseYuema(changed, OTHER), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Yuema Express statuses', () => {
  it('maps each code and courier wording recorded, and leaves SF’s forecast without a stage on purpose', () => {
    for (const entry of statuses.entries) {
      const answer = statusMapAnswer({ carrier: 'yuema-express', providerCode: entry.code, description: entry.wording });
      expect(answer, `${entry.code} ${entry.wording}`).toEqual(entry.stage
        ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage of the row before/) });
    }
    // Yuema's own codes stage a row whatever store, warehouse or courier it names.
    expect(statusMapAnswer({ carrier: 'yuema-express', providerCode: 'LJ', description: '【San Jose】门店已收货' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'yuema-express', providerCode: 'ZT', description: normalizeStatusWording('快件到达 【北京顺航中转场】') }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'yuema-express', providerCode: null, description: '清关中' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'yuema-express', providerCode: 'ZZ', description: '清关中' })).toEqual({ kind: 'unknown' });
  });
});
