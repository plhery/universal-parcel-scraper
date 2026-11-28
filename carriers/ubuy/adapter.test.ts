import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, UbuyTracker, ubuyUrl } from './adapter.js';
import { normalizeUbuyNumber, parseUbuy, ubuyText } from './parser.js';
import { statusMap, ubuyStage, ubuyWording } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const TEST_NUMBER = numbers.records[1]!.number;
const UNKNOWN = '107358204619';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Name = 'delivered' | 'not-found';
const page = (name: Name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' }, ...init });
// The SF Express waybill the warehouse's first row names, as the fixture has it.
const WAYBILL = /国际运单已生成 单号(SF\d+)/u.exec(page('delivered'))![1]!;

describe('UBUYLOGI tracking lookup', () => {
  it('asks the tracking page for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new UbuyTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${NUMBER} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(24);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.ubuylogi.com/track/?num=${NUMBER}`);
    expect(String(url)).toBe(ubuyUrl(NUMBER));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ubuy', step: 'direct', outcome: 'ok' }));
  });

  it('dates the warehouse\'s rows on Germany\'s clock and the rows from China\'s airport on on China\'s', () => {
    const result = parseUbuy(page('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已由本人签收。您的体验对于我们', last_update: '2025-04-03T18:22:54+08:00',
      last_update_local: '2025-04-03T18:22:54', delivered_at: '2025-04-03T18:22:54+08:00', expected_delivery: null,
      origin_country: 'DE', destination_country: 'CN', delivery_carrier: 'sf-express', delivery_tracking_number: WAYBILL });
    const events = result.events!;
    const zones = events.map((event) => [event.description, event.time, event.time_zone_basis]);
    expect(zones.slice(17, 20)).toEqual([
      ['包裹已到达中国机场', '2025-03-30T02:10:00+08:00', 'destination'],
      ['包裹已发往中国', '2025-03-29T22:40:00+01:00', 'carrier'],
      ['包裹已到达法兰克福机场', '2025-03-28T19:16:00+01:00', 'carrier'],
    ]);
    expect(events.slice(0, 18).every((event) => event.time_zone === 'Asia/Shanghai')).toBe(true);
    expect(events.slice(18).every((event) => event.time_zone === 'Europe/Berlin')).toBe(true);
    expect(events.at(-1)).toEqual({ time: '2025-03-17T08:52:02+01:00', time_zone: 'Europe/Berlin', time_zone_basis: 'carrier',
      local_time: '2025-03-17T08:52:02', description: `【德国仓】 国际运单已生成 单号${WAYBILL}`,
      stage: 'registered', stage_source: 'carrier_map' });
    expect(events.map((event) => event.stage)).not.toContain(undefined);
  });

  it('keeps the SF courier\'s name and mobile and the outlet\'s street out of the result', () => {
    const result = parseUbuy(page('delivered'), NUMBER, READ_AT);
    expect(JSON.stringify(result)).not.toMatch(/\*\*\*|13800000000|地址|某区/u);
    expect(result.events!.map((event) => event.description)).toContain('快件到达【杭州某某店】');
    expect(ubuyText('正在派送途中，快递员：某某，电话：13800000000')).toBe('正在派送途中');
    expect(ubuyText('已签收，签收人是：某某。')).toBe('已签收。');
    expect(ubuyText('正在派送途中(派件人：某某)')).toBe('正在派送途中');
  });

  it('names SF Express only for a waybill its own rules take', () => {
    const other = page('delivered').replace(`单号${WAYBILL}`, '单号AB12345678');
    expect(parseUbuy(other, NUMBER, READ_AT)).not.toHaveProperty('delivery_carrier');
    expect(parseUbuy(other, NUMBER, READ_AT)).toMatchObject({ destination_country: 'CN' });
  });

  it('dates every row on Germany\'s clock until one has the parcel in China', () => {
    const rows = page('delivered').split('<tr>');
    // The page and its header row, then the rows from the warehouse's first to the departure for China.
    const body = [rows[0], rows[1], ...rows.slice(-6)].join('<tr>');
    const result = parseUbuy(body, NUMBER, READ_AT);
    expect(result.events!.map((event) => event.description)[0]).toBe('包裹已发往中国');
    expect(result.events!.every((event) => event.time_zone === 'Europe/Berlin')).toBe(true);
    // SF Express's waybill still says where the parcel goes.
    expect(result).toMatchObject({ status: 'in_transit', destination_country: 'CN', delivery_carrier: 'sf-express' });
  });

  it('leaves a row its clock would date after the lookup its wall clock alone', () => {
    const result = parseUbuy(page('delivered'), NUMBER, Date.parse('2025-04-03T10:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events!.find((event) => event.local_time === '2025-04-03T17:40:06')).toMatchObject({ time: '2025-04-03T17:40:06+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2025-04-03T18:22:54' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads the header row alone under the number\'s heading as not found and anything else as a failure', async () => {
    expect(() => parseUbuy(page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Kuaidi100's test number gets the same answer.
    const tested = page('not-found').replace(`运单号${UNKNOWN}的物流信息`, `运单号${TEST_NUMBER}的物流信息`);
    expect(() => parseUbuy(tested, TEST_NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseUbuy(page('not-found'), '107358204618', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = page('not-found').replace(`运单号${UNKNOWN}的物流信息`, '运单号的物流信息').replace('以下是来自转运中心转运记录', '运单号不能为空');
    expect(() => parseUbuy(empty, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUbuy(page('not-found').replace('以下是来自转运中心转运记录', '系统繁忙'), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUbuy('<html><body>维护中</body></html>', NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const clock = page('delivered').replace('2025-04-03 17:56:30', '2025-02-30 17:56:30');
    expect(() => parseUbuy(clock, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new UbuyTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('not-found'), { status: 500 })).rejects.not.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.ubuylogi.com/track/?num=107358204618' } }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"error":"busy"}', { headers: { 'content-type': 'application/json' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeUbuyNumber(` ${NUMBER} `)).toBe(NUMBER);
    expect(normalizeUbuyNumber(TEST_NUMBER)).toBe(TEST_NUMBER);
    for (const number of ['12345', 'ABCDEFGH', `4${'1'.repeat(30)}`, '4937/47265227', '']) {
      expect(() => normalizeUbuyNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new UbuyTracker({ fetcher }).fetch('49374&num=1')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new UbuyTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'ubuy', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps each text in statuses.json, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(ubuyWording(`【德国仓】 国际运单已生成 单号${WAYBILL}`)).toBe('【德国仓】 国际运单已生成 单号…');
    expect(ubuyWording('快件到达【杭州某某店】')).toBe('快件到达【…】');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(ubuyStage('已签收')).toMatchObject({ stage: 'delivered' });
    expect(ubuyStage('新的状态')).toBeNull();
  });
});
