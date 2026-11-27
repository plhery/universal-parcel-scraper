import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording, statusGapNote } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HUBO_API, HuboTracker, huboLookupUrl } from './adapter.js';
import { huboDestination, normalizeHuboNumber, parseHubo } from './parser.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const LIVE = numbers.records[1]!.number;
const UNKNOWN = 'ZD199901999999';
// After both samples' newest rows.
const READ_AT = Date.parse('2026-11-27T22:00:00Z');
type Name = 'delivered' | 'in-transit' | 'not-found';
type Reply = { code: number; msg: string; data: (Record<string, unknown> & { routeList: Record<string, unknown>[] }) | null };
const text = (name: Name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: Name) => JSON.parse(text(name)) as Reply;
const withRows = (reply: Reply, rows: (row: Record<string, unknown>, index: number) => Record<string, unknown>) =>
  ({ ...reply, data: { ...reply.data!, routeList: reply.data!.routeList.map(rows) } });
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('HUBO Logistics tracking lookup', () => {
  it('asks the service for the whole order number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const typed = `${NUMBER.slice(0, 6).toLowerCase()} ${NUMBER.slice(6)}`;
    const result = await new HuboTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(typed, { budgetMs: 5000 });
    expect(result.events).toHaveLength(12);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HUBO_API}${NUMBER}`);
    expect(huboLookupUrl(NUMBER)).toBe(`${HUBO_API}${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hubologistics', step: 'direct', outcome: 'ok' }));
  });

  it('reads the delivered sample newest first on China\'s clock, without staff, pictures or the warehouse street', () => {
    const result = parseHubo(json('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '货物已签收', last_update: '2024-04-24T14:02:39+08:00', last_update_local: '2024-04-24T14:02:39',
      expected_delivery: null, destination_country: 'US', receiver_address: 'Fontana, CA', service_name: '亚马逊直送-普船统配-LA', weight_kg: 3 });
    const events = result.events!;
    expect(events.map((event) => [event.provider_code ?? null, event.stage ?? null])).toEqual([
      ['1009', 'delivered'], [null, 'in_transit'], [null, null], [null, 'in_transit'], [null, 'in_transit'], [null, 'in_transit'],
      [null, 'in_transit'], [null, null], [null, 'in_transit'], [null, 'in_transit'], ['1001', 'accepted'], [null, 'registered'],
    ]);
    expect(events[0]).toEqual({ time: '2024-04-24T14:02:39+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2024-04-24T14:02:39', description: '货物已签收', provider_code: '1009', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[2]!.description).toBe('预约当地4.23号提柜');
    expect(events[8]!.description).toBe('国内报关已放行，ETD：4.04 ETA：4.19。船名航次：EVER FUTURE 1110-020E');
    expect(events.every((event) => event.time_zone_basis === 'carrier' && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Example|92337|aliyuncs|annex|createBy|LAX9/);
  });

  it('reads the newer rows\' places, passes over notices and keeps a partner\'s copied row on its own clock', () => {
    const result = parseHubo(json('in-transit'), LIVE, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: '此柜更新ETA：12.05，实际到港以船司官网显示为准',
      last_update: '2026-11-27T11:16:27+08:00', destination_country: 'US', receiver_address: 'Chino, CA', service_name: '海派-19日提', weight_kg: 1259 });
    const events = result.events!;
    expect(events.map((event) => [event.provider_code ?? null, event.location ?? null, event.stage ?? null])).toEqual([
      ['1990', 'Long Beach, US', null], ['1310', '深圳, CN', 'in_transit'], ['1990', '深圳, CN', null], ['1250', '深圳, CN', 'in_transit'],
      ['1210', '广州, CN', 'in_transit'], [null, null, null], ['1110', '广州市, CN', 'accepted'], [null, null, 'registered'],
    ]);
    // Staff write the arrival port's row at the time they enter it, on China's clock.
    expect(events[0]).toMatchObject({ time: '2026-11-27T11:16:27+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier' });
    expect(events[5]).toEqual({ local_time: '2026-11-14T20:50:03', description: 'United States,Label Created, Order Processed: In Transit to UPS' });
    // A copied row in a country of one zone is dated there.
    const placed = withRows(json('in-transit'), (row) => (row.routingEnContent ? { ...row, countryCode: 'GB', city: 'London' } : row));
    expect(parseHubo(placed, LIVE, READ_AT).events![5]).toMatchObject({ time: expect.stringMatching(/^2026-11-14T20:50:03(?:Z|\+00:00)$/), time_zone: 'Europe/London',
      time_zone_basis: 'place', location: 'London, GB' });
  });

  it('leaves a row the zone would date after the lookup its wall clock alone, and mobile numbers out of the text', () => {
    const early = parseHubo(json('in-transit'), LIVE, Date.parse('2026-11-27T03:00:00Z'));
    expect(early.events![0]).not.toHaveProperty('time');
    expect(early).toMatchObject({ last_update: null, last_update_local: '2026-11-27T11:16:27' });
    const phoned = withRows(json('delivered'), (row, index) => (index === 1 ? { ...row, routingCnContent: '已提柜，联系13800000000' } : row));
    expect(parseHubo(phoned, NUMBER, READ_AT).events![1]!.description).toBe('已提柜，联系');
  });

  it('refuses another order\'s reply or row', () => {
    const other = json('delivered');
    expect(() => parseHubo({ ...other, data: { ...other.data!, orderCode: 'OZ2024031835' } }, NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHubo(withRows(other, (row, index) => (index === 3 ? { ...row, orderCode: 'OZ2024031835' } : row)), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHubo({ ...other, data: { ...other.data!, orderCode: undefined } }, NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads an empty answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHubo(json('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHubo({ code: 500, msg: '系统繁忙', data: null }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHubo({ code: 401, msg: '认证失败' }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHubo({ msg: '操作成功', data: null }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const payload = json('delivered');
    expect(() => parseHubo({ ...payload, data: { ...payload.data!, routeList: [] } }, NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseHubo(withRows(payload, (row) => ({ ...row, routingTime: '2024-02-30 10:00:00' })), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new HuboTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('{"status":404,"error":"Not Found"}', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.hubologistics.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('keeps a US destination\'s town and state, not its street or ZIP code', () => {
    expect(huboDestination('11263 Oleander Ave, Fontana, CA 92337')).toEqual({ country: 'US', town: 'Fontana, CA' });
    expect(huboDestination('Chino CA 91708 6720 Kimball Ave')).toEqual({ country: 'US', town: 'Chino, CA' });
    expect(huboDestination('Long Kimball Avenue Road Chino CA 91708')).toEqual({ country: 'US', town: '' });
    expect(huboDestination('2 Example Way, Peterborough PE2 9EN')).toBeNull();
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeHuboNumber(LIVE.toLowerCase())).toBe(LIVE);
    for (const number of ['12345', 'OZABCDEFGH', `O${'1'.repeat(40)}`, 'OZ2024/031834', '../order', '']) {
      expect(() => normalizeHuboNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HuboTracker({ fetcher }).fetch('../order')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new HuboTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hubologistics', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('offers HUBO for no number shape', () => {
    for (const number of [NUMBER, LIVE]) expect(detectCarrierMatch(number).carrier, number).not.toBe('hubologistics');
  });

  it('maps a row by its code, else by the first phrase of statuses.json its text contains', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage ?? undefined);
    }
    expect(statusMap.stage(null, '已提柜，已拆柜完成，预约当地4.24号签收')).toBe('in_transit');
    expect(statusMap.stage(null, '因船晚靠，开船时间有延误，预计etd：4.06，待确认开船后更新')).toBeUndefined();
    expect(statusMap.stage('1009', '新的文字')).toBe('delivered');
    expect(statusMap.stage('9999', '货物已装柜')).toBe('in_transit');
    expect(statusMap.stage(null, '新的文字')).toBeUndefined();
    expect(statusGapNote(statusMap, '1990', '此柜更新eta：12.05')).toMatch(/notice/);
    expect(statusGapNote(statusMap, null, '预约当地4.23号提柜')).toMatch(/still to come/);
    expect(statusGapNote(statusMap, null, '货物已装柜')).toBeUndefined();
  });
});
