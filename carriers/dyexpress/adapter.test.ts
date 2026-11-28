import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DYEXPRESS_LOOKUP, DyexpressTracker } from './adapter.js';
import { dyexpressText, normalizeDyexpressNumber, parseDyexpress, placeOf } from './parser.js';
import { dyexpressStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = '5930264817';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Name = 'delivered' | 'not-found' | 'empty-form';
const page = (name: Name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Dayi Express tracking lookup', () => {
  it('posts the query form for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new DyexpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${NUMBER} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(DYEXPRESS_LOOKUP);
    expect(String(init!.body)).toBe(`keyword=${NUMBER}`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dyexpress', step: 'direct', outcome: 'ok' }));
  });

  it('reads the record for the number, newest first, each row on its station\'s clock', () => {
    const result = parseDyexpress(page('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收，感谢您体验深圳大亿快递！', last_update: '2021-11-29T03:22:18+08:00',
      last_update_local: '2021-11-29T03:22:18', delivered_at: '2021-11-29T03:22:18+08:00', expected_delivery: null,
      origin_country: 'CN', destination_country: 'TW' });
    const events = result.events!;
    expect(events.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2021-11-29T03:22:18', '已签收，感谢您体验深圳大亿快递！', 'delivered'],
      ['2021-11-29T01:43:54', '正在派件，请耐心等待...', 'out_for_delivery'],
      ['2021-11-29T01:31:19', '已完成清关作业，发往目的地站点', 'in_transit'],
      ['2021-11-29T01:23:08', '出口作业中...', 'in_transit'],
      ['2021-11-26T09:19:10', '已经离开始发地站点', 'in_transit'],
      ['2021-11-26T07:18:39', '已经收到寄件信息', 'registered'],
    ]);
    expect(events[5]).toEqual({ time: '2021-11-26T07:18:39+08:00', time_zone: 'Asia/Taipei', time_zone_basis: 'place',
      local_time: '2021-11-26T07:18:39', location: '博宇-台北', description: '已经收到寄件信息',
      stage: 'registered', stage_source: 'carrier_map' });
  });

  it('dates a row on the clock of the place it names, and leaves a place it does not know its wall clock', () => {
    const body = page('delivered')
      .replace('<span style="">博宇-台北</span>', '<span style="">深圳</span>')
      .replace('<span style="">博宇-台北</span>', '<span style="">某站-孟买</span>')
      .replace('<span style="">博宇-台北</span>', '<span style="">某站-东京</span>');
    const events = parseDyexpress(body, NUMBER, READ_AT).events!;
    expect(events[1]).toMatchObject({ location: '深圳', time: '2021-11-29T01:43:54+08:00', time_zone: 'Asia/Shanghai' });
    expect(events[2]).toMatchObject({ location: '某站-孟买', time: '2021-11-29T01:31:19+05:30', time_zone: 'Asia/Kolkata' });
    expect(events[3]).toMatchObject({ location: '某站-东京', local_time: '2021-11-29T01:23:08' });
    expect(events[3]).not.toHaveProperty('time');
    expect(placeOf('香港')).toEqual({ country: 'HK', zone: 'Asia/Hong_Kong' });
    expect(placeOf('深圳出口')).toEqual({ country: 'CN', zone: 'Asia/Shanghai' });
    expect(placeOf('')).toBeUndefined();
  });

  it('leaves a row its station\'s clock would date after the lookup its wall clock alone', () => {
    const result = parseDyexpress(page('delivered'), NUMBER, Date.parse('2021-11-28T18:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2021-11-29T01:43:54+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2021-11-29T03:22:18' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps who signed and phones out of the result', () => {
    const body = page('delivered').replace('<td width="25%" bgcolor="#FFFFFF">未知</td>', '<td width="25%" bgcolor="#FFFFFF">某某</td>')
      .replace('正在派件，请耐心等待...', '正在派件，派件员电话13800000000');
    const result = parseDyexpress(body, NUMBER, READ_AT);
    expect(JSON.stringify(result)).not.toMatch(/某某|13800000000/u);
    expect(result.events![1]!.description).toBe('正在派件，派件员电话');
    expect(dyexpressText('已签收，签收人：某某')).toBe('已签收');
  });

  it('reads the not-found notice for the number as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseDyexpress(page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The notice for another number in the search box, or no answer at all, is not the answer for this one.
    expect(() => parseDyexpress(page('not-found'), '5930264818', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDyexpress(page('empty-form'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDyexpress(page('delivered'), '8100012343', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDyexpress('<html><body>维护中</body></html>', NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const rows = page('delivered').replace(/<tr bgcolor="#FFFFFF">\s*<td width="10%" align="center">\d<\/td>[\s\S]*?<\/tr>/gu, '');
    expect(() => parseDyexpress(rows, NUMBER, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const clock = page('delivered').replace('2021-11-29 01:43:54', '2021-02-30 01:43:54');
    expect(() => parseDyexpress(clock, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new DyexpressTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('not-found'), { status: 500 })).rejects.not.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.dy-express.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"error":"busy"}', { headers: { 'content-type': 'application/json' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeDyexpressNumber(` ${NUMBER} `)).toBe(NUMBER);
    for (const number of ['12345', 'ABCDEFGH', `8${'1'.repeat(30)}`, '81000/12342', '']) {
      expect(() => normalizeDyexpressNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new DyexpressTracker({ fetcher }).fetch('81000&keyword=1')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new DyexpressTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'dyexpress', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps each text in statuses.json, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(dyexpressStage('已签收')).toMatchObject({ stage: 'delivered' });
    expect(dyexpressStage('新的状态')).toBeNull();
  });
});
