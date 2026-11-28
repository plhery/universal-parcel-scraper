import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, NANBEI_ROUTES } from './adapter.js';
import { nanbeiWording, normalizeNanbeiNumber, parseNanbei } from './parser.js';
import { nanbeiStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.json');
const notFound = fixture('not-found.json');
const number = '21542037706';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const reply = (body: string, status = 200, type = 'application/json;charset=UTF-8') => new Response(body, { status, headers: { 'Content-Type': type } });
const withRows = (edit: (rows: Record<string, unknown>[]) => void) => {
  const parsed = JSON.parse(delivered) as { rows: Record<string, unknown>[] };
  edit(parsed.rows);
  return JSON.stringify(parsed);
};

describe('Nanbei Express waybill numbers', () => {
  it('takes one waybill in letters and digits', () => {
    expect(normalizeNanbeiNumber(' 2154 2037 706 ')).toBe(number);
    for (const raw of ['12345', 'ABCDEFGH', `${number}/x`]) {
      expect(() => normalizeNanbeiNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Nanbei Express tracker', () => {
  it('posts the number to the route service the home page\'s form asks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(delivered));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(NANBEI_ROUTES);
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toBe(`orderNo=${number}`);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '货物已签收', last_update: '2025-04-11T09:37:39+08:00',
    });
  });

  it('reads the rows newest first on China\'s clock, with the station that recorded each', () => {
    const { events = [] } = parseNanbei(delivered, number);
    expect(events.map((event) => [event.time, event.provider_code, event.location, event.stage])).toEqual([
      ['2025-04-11T09:37:39+08:00', '16118', '佛山驻地营业部NB', 'delivered'],
      ['2025-04-10T09:55:51+08:00', '16113', '南北广州分拨中心', 'in_transit'],
      ['2025-04-08T17:55:10+08:00', '16110', '芜湖分拨中心', 'in_transit'],
      ['2025-04-08T12:28:49+08:00', '16113', '芜湖分拨中心', 'in_transit'],
      ['2025-04-08T12:28:13+08:00', '16109', '芜湖分公司', 'in_transit'],
      ['2025-04-08T10:57:14+08:00', '16101', '芜湖分公司', 'accepted'],
    ]);
  });

  it('keeps the stations\' names but no phone, plate, driver or signer', () => {
    const { events = [] } = parseNanbei(delivered, number);
    expect(events.map((event) => event.description)).toEqual([
      '货物已签收',
      '货物已由【佛山市】【南北广州分拨】卸货入库',
      '货物已由【芜湖分拨中心】发往【南北广州分拨】',
      '货物已由【芜湖市】【芜湖分拨中心】卸货入库',
      '货物已由【芜湖分公司】发往【芜湖分拨中心】',
      `货物已由【芜湖分公司】揽收，信息已录入系统，运单号【${number}】`,
    ]);
    const text = JSON.stringify(parseNanbei(delivered, number));
    for (const leak of ['0553', '0757', '皖A', '测试司机', '司机123', '张三', 'NB测试员', 'NB0000']) expect(text).not.toContain(leak);
    // Synthetic: a waybill shaped like a mobile number stays; a courier's mobile does not.
    expect(nanbeiWording('货物已由【合肥分公司】揽收，运单号【13800000000】，派送员【李四】，电话：13900000000', '13800000000'))
      .toBe('货物已由【合肥分公司】揽收，运单号【13800000000】');
  });

  it('stages every recorded code whatever its sentence, and others by their wording', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, '')).toBe(entry.stage);
    // Synthetic: a code the map does not know falls to the shared rules on its name.
    expect(nanbeiStage('16199', '派送签收', '货物已签收')?.stage).toBe('delivered');
    const unknown = withRows((rows) => { rows[5]!.eventNode = '16199'; rows[5]!.eventNodeValue = '其他'; rows[5]!.eventLog = '已处理'; });
    expect(parseNanbei(unknown, number)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('reports a number without rows as not found, and rows of another waybill as indeterminate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(notFound));
    await expect(tracker(fetcher).track({ number: '00000000000' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseNanbei(delivered, '21542037707')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not take a failure, a changed reply or a verification page for a missing shipment', async () => {
    expect(() => parseNanbei('{"code":"5030","msg":"[运单编号]不能为空","rows":[]}', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseNanbei('{"code":"200","msg":"操作成功!"}', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseNanbei(withRows((rows) => { rows[0]!.eventTime = '2025-04-08 10:57'; }), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseNanbei(withRows((rows) => { rows[0]!.eventLog = ''; rows[0]!.eventNodeValue = ''; }), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><head><title>Just a moment...</title></head></html>', 403, 'text/html'));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><body>请输入验证码</body></html>', 200, 'text/html'));
    await expect(tracker(blocked).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><body>Service Unavailable</body></html>', 503, 'text/html'));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
    const other = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><head><title>502 Bad Gateway</title></head></html>', 200, 'text/html'));
    await expect(tracker(other).track({ number })).rejects.toMatchObject({ kind: 'schema' });
  });
});
