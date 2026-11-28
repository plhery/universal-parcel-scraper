import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ZSDA56_LOOKUP, Zsda56Tracker, zsda56Form } from './adapter.js';
import { normalizeZsda56Number, parseZsda56 } from './parser.js';
import { statusMap, zsda56Stage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'ZSD830416295';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Name = 'payment' | 'not-found';
const page = (name: Name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Zhuanshunda tracking lookup', () => {
  it('posts the home page\'s form for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('payment')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new Zsda56Tracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(7);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(ZSDA56_LOOKUP);
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ keyword: NUMBER, prid: '2', act: 'searchs' });
    expect(init!.body).toBe(zsda56Form(NUMBER));
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'zsda56', step: 'direct', outcome: 'ok' }));
  });

  it('reads the rows newest first on China\'s clock, and passes over the payment notice', () => {
    const result = parseZsda56(page('payment'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: '包裹付款Package payment', last_update: '2020-01-10T12:10:47+08:00',
      last_update_local: '2020-01-10T12:10:47', expected_delivery: null, destination_country: 'TW' });
    const events = result.events!;
    expect(events.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2020-01-10T12:10:47', '包裹付款Package payment', 'pending'],
      ['2019-03-15T15:14:00', '目的港通关中', 'customs'],
      ['2019-03-05T17:49:29', '包裹出仓Package out warehouse', 'in_transit'],
      ['2019-03-05T17:49:00', '深圳集运仓库已出库', 'in_transit'],
      ['2019-03-05T17:49:00', '转运起始港', 'in_transit'],
      ['2019-03-05T15:26:03', '包裹打包Parcel packing', 'accepted'],
      ['2019-03-05T12:52:25', '包裹申请打包Package application', 'registered'],
    ]);
    expect(events[1]).toEqual({ time: '2019-03-15T15:14:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2019-03-15T15:14:00', description: '目的港通关中', stage: 'customs', stage_source: 'carrier_map' });
  });

  it('names the destination only when the list item names a country', () => {
    const swap = (text: string) => page('payment').replace('<span>TaiWan 台灣</span>', `<span>${text}</span>`);
    expect(parseZsda56(swap('Canada 加拿大'), NUMBER, READ_AT)).toMatchObject({ destination_country: 'CA' });
    expect(parseZsda56(swap('欧洲'), NUMBER, READ_AT)).not.toHaveProperty('destination_country');
  });

  it('leaves a row China\'s clock would date after the lookup its wall clock alone', () => {
    const result = parseZsda56(page('payment'), NUMBER, Date.parse('2019-03-15T07:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).not.toHaveProperty('time');
    expect(result.events![2]).toMatchObject({ time: '2019-03-05T17:49:29+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2020-01-10T12:10:47' });
  });

  it('reads the not-found row for the number in the title as not found and anything else as a failure', async () => {
    expect(() => parseZsda56(page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The not-found row under another number's title, or the parcel of another number, is not this number's answer.
    expect(() => parseZsda56(page('not-found'), 'ZSD830416296', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZsda56(page('payment'), 'ZSD946081', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZsda56('<html><body>维护中</body></html>', NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const rows = page('payment').replace(/<tr class="logistics_floor_6tr0\d">[\s\S]*?<\/tr>/gu, '');
    expect(() => parseZsda56(rows, NUMBER, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const clock = page('payment').replace('2019-03-15 15:14', '2019-02-30 15:14');
    expect(() => parseZsda56(clock, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new Zsda56Tracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('not-found'), { status: 500 })).rejects.not.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.zsda56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"error":"busy"}', { headers: { 'content-type': 'application/json' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeZsda56Number('zsd-946080')).toBe(NUMBER);
    for (const number of ['12345', 'ZSDABCDEF', `Z${'1'.repeat(30)}`, 'ZSD94/6080', '']) {
      expect(() => normalizeZsda56Number(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new Zsda56Tracker({ fetcher }).fetch('ZSD1&act=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new Zsda56Tracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'zsda56', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('offers Zhuanshunda for ZSD and six digits only', () => {
    expect(detectCarrierMatch(NUMBER).candidates).toEqual(['zsda56']);
    expect(detectCarrierMatch(UNKNOWN).candidates).not.toContain('zsda56');
  });

  it('maps each text in statuses.json, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(zsda56Stage('已签收')).toMatchObject({ stage: 'delivered' });
    expect(zsda56Stage('新的状态')).toBeNull();
  });
});
