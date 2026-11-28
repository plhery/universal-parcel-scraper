import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BUYER1688_LOOKUP, BUYER1688_PAGE, Buyer1688Tracker, buyer1688Text, normalizeBuyer1688Number, parseBuyer1688 } from './adapter.js';
import { buyer1688Stage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = numbers.records[0]!.number;
const UNKNOWN = 'ZQX5073198QQ';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Row = { Action: string; AcceptStation: string; AcceptTime: string; Location: string };
type Reply = { flag: string; retCompany: string; packid: string; exressno1: string; list: { Traces: Row[] } };
const text = () => readFileSync(new URL('./fixtures/customs.json', import.meta.url), 'utf8');
const json = () => JSON.parse(text()) as Reply;
const reply = (change: Partial<Reply>) => JSON.stringify({ ...json(), ...change });
const rows = (traces: Row[]) => reply({ list: { Traces: traces } });
// The platform's answer for a number it holds nothing under, as it gave it for an invented number.
const notFound = (number: string) => JSON.stringify({ flag: '1', retCompany: '', packid: number, exressno1: number, list: { Traces: [] } });
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' }, ...init });

describe('1688 International Logistics tracking lookup', () => {
  it('posts the whole number as the page\'s form through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new Buyer1688Tracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${SAMPLE.toLowerCase()} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(BUYER1688_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', body: `postid=${SAMPLE}`, redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: 'https://www.buyer1688.ca', Referer: BUYER1688_PAGE,
      'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'buyer1688', step: 'direct', outcome: 'ok' }));
  });

  it('reads the Toronto rows on Toronto\'s clock and the rows from the arrival in China on China\'s, newest first', () => {
    const result = parseBuyer1688(text(), SAMPLE, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: '已到达口岸，国际运输环节中，正在办理清关手续', last_update: '2025-04-11T09:17:42+08:00',
      last_update_local: '2025-04-11T09:17:42', expected_delivery: null, destination_country: 'CN',
      delivery_carrier: 'jd-logistics', delivery_tracking_number: json().exressno1 });
    expect(result.events!.map((event) => [event.time, event.time_zone, event.time_zone_basis, event.description, event.stage])).toEqual([
      ['2025-04-11T09:17:42+08:00', 'Asia/Shanghai', 'destination', '已到达口岸，国际运输环节中，正在办理清关手续', 'customs'],
      ['2025-04-08T14:11:02+08:00', 'Asia/Shanghai', 'destination', '已到达国内等待转关', 'customs'],
      ['2025-04-05T15:25:30-04:00', 'America/Toronto', 'carrier', '包裹已从国际干线运输启程离境', 'in_transit'],
      ['2025-04-02T15:49:43-04:00', 'America/Toronto', 'carrier', '包裹已分拣出库，等待干线运输', 'in_transit'],
      ['2025-03-24T19:14:49-04:00', 'America/Toronto', 'carrier', '到达加拿大多伦多总仓', 'accepted'],
      ['2025-03-24T19:14:49-04:00', 'America/Toronto', 'carrier', 'Canada多伦多总仓 已揽收', 'accepted'],
    ]);
    expect(result.events!.at(-1)).toEqual({ time: '2025-03-24T19:14:49-04:00', time_zone: 'America/Toronto', time_zone_basis: 'carrier',
      local_time: '2025-03-24T19:14:49', description: 'Canada多伦多总仓 已揽收', stage: 'accepted', stage_source: 'carrier_map' });
  });

  it('keeps every row on Toronto\'s clock until a row says the parcel is in China', () => {
    const result = parseBuyer1688(rows(json().list.Traces.slice(0, 4)), SAMPLE, READ_AT);
    expect(result.events!.every((event) => event.time_zone === 'America/Toronto')).toBe(true);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2025-04-05T15:25:30-04:00' });
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parseBuyer1688(text(), SAMPLE, Date.parse('2025-04-10T12:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2025-04-08T14:11:02+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2025-04-11T09:17:42' });
  });

  it('hands off to JD Logistics only under a waybill its rules take', () => {
    const handed = (exressno1: string) => parseBuyer1688(reply({ exressno1 }), SAMPLE, READ_AT);
    for (const exressno1 of ['', SAMPLE, '1234', 'SF1234567890123']) expect(handed(exressno1)).not.toHaveProperty('delivery_carrier');
    const toronto = parseBuyer1688(reply({ exressno1: SAMPLE, list: { Traces: json().list.Traces.slice(0, 4) } }), SAMPLE, READ_AT);
    expect(toronto).not.toHaveProperty('destination_country');
  });

  it('reads a row\'s text as the page renders it and cuts it at a courier or a phone', () => {
    expect(buyer1688Text('<b>到达</b>&nbsp;加拿大多伦多总仓')).toBe('到达 加拿大多伦多总仓');
    expect(buyer1688Text('【某站】派件中，派送人：张三，电话:13800000000')).toBe('【某站】派件中');
    expect(buyer1688Text('您的快件正在派送中，请您准备签收（快递员：张三，联系电话：13800000000）')).toBe('您的快件正在派送中');
    expect(buyer1688Text('已签收，签收人凭取货码签收')).toBe('已签收，签收人凭取货码签收');
    expect(buyer1688Text('请拨打13800000000')).toBe('');
  });

  it('reads an empty history for the number asked as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseBuyer1688(notFound(UNKNOWN), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBuyer1688(notFound('ZQX5073199QQ'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBuyer1688(text(), 'J900000001CA', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBuyer1688(JSON.stringify({ ...JSON.parse(notFound(UNKNOWN)), flag: '0' }), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBuyer1688(JSON.stringify({ packid: UNKNOWN, list: { Traces: [] } }), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBuyer1688(reply({ list: {} as never }), SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const clock = rows([{ ...json().list.Traces[0]!, AcceptTime: '2025-02-30 10:00:00.0' }]);
    expect(() => parseBuyer1688(clock, SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBuyer1688(rows([{ ...json().list.Traces[0]!, AcceptStation: '' }]), SAMPLE, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseBuyer1688('<html>Error 500</html>', SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new Buyer1688Tracker({
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) }).fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(notFound(UNKNOWN))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(notFound(UNKNOWN), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.buyer1688.ca/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, one number, without a request', async () => {
    expect(normalizeBuyer1688Number(SAMPLE.toLowerCase())).toBe(SAMPLE);
    for (const number of ['J900', 'BUYERONE', `J${'1'.repeat(30)}`, `${SAMPLE},${UNKNOWN}`, '']) {
      expect(() => normalizeBuyer1688Number(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new Buyer1688Tracker({ fetcher }).fetch('J900&postid=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new Buyer1688Tracker({ fetcher }).fetch(SAMPLE, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'buyer1688', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('leaves its numbers to explicit selection', () => {
    expect(detectCarrierMatch(SAMPLE).candidates).not.toContain('buyer1688');
  });

  it('maps each text in statuses.json, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(buyer1688Stage('新的状态')).toBeNull();
    expect(buyer1688Stage('已签收')).toMatchObject({ stage: 'delivered' });
  });
});
