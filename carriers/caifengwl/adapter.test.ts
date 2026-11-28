import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, caifengLookupUrl } from './adapter.js';
import { caifengWording, normalizeCaifengNumber, parseCaifeng } from './parser.js';
import { caifengStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.json');
const notFound = fixture('not-found.txt');
const number = '0062205239744';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const reply = (body: string, status = 200, type = 'text/plain; charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const edited = (edit: (reply: Record<string, unknown> & { result: Record<string, unknown>[] }) => void) => {
  const parsed = JSON.parse(delivered) as Record<string, unknown> & { result: Record<string, unknown>[] };
  edit(parsed);
  return JSON.stringify(parsed);
};

describe('Caifeng Logistics waybill numbers', () => {
  it('takes thirteen to twenty digits', () => {
    expect(normalizeCaifengNumber(' 006 2205 2397 44 ')).toBe(number);
    for (const raw of ['006220523974', 'CF00000000000001', `${number}/x`, '1'.repeat(21)]) {
      expect(() => normalizeCaifengNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Caifeng Logistics tracker', () => {
  it('asks the platform\'s lookup under the firm\'s database, as the tracking page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(delivered));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(caifengLookupUrl(number));
    expect(String(url)).toBe(`https://tms.gdonetrue.com/weixin/LogisticTrace.ashx?database=ausoft_caifeng&no=${number}`);
    expect(init?.method).toBe('GET');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '客户已签收，订单完成', last_update: '2022-05-28T13:26:26+08:00', last_update_local: '2022-05-28T13:26:26',
    });
  });

  it('reads the rows newest first on the branches\' wall clock, each at its branch', () => {
    const { events = [] } = parseCaifeng(delivered, number);
    expect(events.map((event) => [event.local_time, event.time, event.time_zone_basis, event.provider_code, event.location, event.stage])).toEqual([
      ['2022-05-28T13:26:26', '2022-05-28T13:26:26+08:00', 'carrier', '客户自提-完成', '彩塘分公司', 'delivered'],
      ['2022-05-28T13:24:56', '2022-05-28T13:24:56+08:00', 'carrier', '客户自提-完成', '彩塘分公司', 'delivered'],
      ['2022-05-26T13:11:40', '2022-05-26T13:11:40+08:00', 'carrier', '短驳', '彩塘分公司', 'in_transit'],
      ['2022-05-26T13:11:40', '2022-05-26T13:11:40+08:00', 'carrier', '短驳', '彩塘分公司', 'in_transit'],
      ['2022-05-25T12:22:54', '2022-05-25T12:22:54+08:00', 'carrier', '短驳', '潮安庵埠总公司', 'in_transit'],
      ['2022-05-25T10:04:27', '2022-05-25T10:04:27+08:00', 'carrier', '长途配载-分部完成', '潮安庵埠总公司', 'in_transit'],
      ['2022-05-25T10:04:27', '2022-05-25T10:04:27+08:00', 'carrier', '长途配载-分部完成', '潮安庵埠总公司', 'in_transit'],
      ['2022-05-24T13:36:38', '2022-05-24T13:36:38+08:00', 'carrier', '长途配载-分部完成', '南昌分公司', 'in_transit'],
      ['2022-05-23T18:43:20', '2022-05-23T18:43:20+08:00', 'carrier', '托运开单', '南昌分公司', 'accepted'],
    ]);
  });

  it('keeps the branches\' names but no phone, plate, driver or staff', () => {
    const { events = [] } = parseCaifeng(delivered, number);
    expect(events.map((event) => event.description)).toEqual([
      '客户已签收，订单完成',
      '客户在彩塘分公司提货',
      '货物已由彩塘分公司卸货入库',
      '车辆已到达彩塘分公司',
      '运输中，离开潮安庵埠总公司，发往彩塘分公司',
      '货物已由潮安庵埠总公司卸货入库',
      '车辆已到达潮安庵埠总公司',
      '在南昌分公司完成配载，发往潮安庵埠总公司',
      '货物已由南昌分公司揽收',
    ]);
    const text = JSON.stringify(parseCaifeng(delivered, number));
    for (const leak of ['0768', '0791', '13800000000', '粤A00000', '测试司机', '操作员', '开单员', '发货人', '收货单位']) expect(text).not.toContain(leak);
    // Synthetic: a mobile number without a label goes too.
    expect(caifengWording('货物已到达深圳分公司 13900000000，司机：李四')).toBe('货物已到达深圳分公司');
  });

  it('stages every recorded operation whatever its sentence, and others by their wording', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, '')).toBe(entry.stage);
    // Synthetic: an operation the map does not know falls to the shared rules on its sentence.
    expect(caifengStage('送货上门', '货物已签收')?.stage).toBe('delivered');
    const unknown = edited((parsed) => { parsed.result[0]!.type = '其他'; parsed.result[0]!.content = '已处理'; parsed.result[1]!.type = '其他'; });
    expect(parseCaifeng(unknown, number)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('reads the platform\'s bare answer for an unknown number as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(notFound));
    await expect(tracker(fetcher).track({ number: '0062205239799' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('does not take another waybill, another firm or a waybill without rows for this one', () => {
    expect(() => parseCaifeng(delivered, '0062205239745')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCaifeng(edited((parsed) => { parsed.dbname = '其他物流'; }), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCaifeng(edited((parsed) => { parsed.result[3]!.bookingnoteno = '0062205239745'; }), number))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCaifeng(edited((parsed) => { parsed.result = []; }), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The platform's page reads `result` through eval, so it may come as a JSON string.
    const stringRows = edited((parsed) => { (parsed as Record<string, unknown>).result = JSON.stringify(parsed.result); });
    expect(parseCaifeng(stringRows, number).events).toHaveLength(9);
  });

  it('does not take a refusal, a changed reply or a verification page for a missing shipment', async () => {
    expect(() => parseCaifeng('数据库【ausoft_caifeng】尚未开通启用。', number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCaifeng('传入的参数不正常。', number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCaifeng('{"bookingnoteno_vchr":"0062205239744","result":[]}', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCaifeng(edited((parsed) => { delete (parsed as Record<string, unknown>).result; }), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCaifeng(edited((parsed) => { parsed.result[0]!.operatetime = '2022-02-30 10:00:00'; }), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCaifeng('<html><head><title>502 Bad Gateway</title></head></html>', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><head><title>Just a moment...</title></head></html>', 403, 'text/html'));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><head><title>安全验证</title></head></html>', 200, 'text/html'));
    await expect(tracker(blocked).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const limited = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('', 429));
    await expect(tracker(limited).track({ number })).rejects.toMatchObject({ kind: 'rate_limited' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><body>Service Unavailable</body></html>', 503, 'text/html'));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
  });
});
