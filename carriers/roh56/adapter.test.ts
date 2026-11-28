import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ROH56_API, ROH56_SITE, Roh56Tracker, roh56LookupUrl } from './adapter.js';
import { normalizeRoh56Number, parseRoh56, roh56Row } from './parser.js';
import { roh56Stage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const NETWORK = numbers.records[1]!.number;
const UNKNOWN = 'RH99999999';
// After the samples' newest rows, on Shanghai's clock.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
type Fixture = 'delivered' | 'network' | 'not-found';
const bytes = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));
// The server answers in GBK.
const raw = (name: Fixture) => new TextDecoder('gb18030').decode(bytes(name));
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('Ronghui Supply Chain tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport, and reads its GBK', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 4)} ${NUMBER.slice(4, 6)}-${NUMBER.slice(6)}`;
    const result = await new Roh56Tracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '已签收' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(roh56LookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(ROH56_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: ROH56_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'roh56', step: 'direct', outcome: 'ok' }));
  });

  it('reads the test number newest first, on China\'s clock, delivered', () => {
    const result = parseRoh56(raw('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收', last_update: '2025-05-24T15:58:00+08:00', last_update_local: '2025-05-24T15:58',
      expected_delivery: null });
    // The destination is a Chinese province and town, not a country; the record gives no weight or onward number.
    for (const field of ['destination_country', 'weight_kg', 'delivery_carrier', 'delivery_tracking_number']) {
      expect(result).not.toHaveProperty(field);
    }
    const events = result.events!;
    expect(events.map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2025-05-24T15:58:00+08:00', '兰州', '已签收', 'delivered'],
      ['2025-05-24T10:58:00+08:00', '兰州', '您的货物已到达派送网点 联系收货人送货中', 'out_for_delivery'],
      ['2025-05-21T09:24:00+08:00', '深圳', '您的货物已装车发往甘肃分拨 预计27号左右到达', 'in_transit'],
      ['2025-05-20T23:23:00+08:00', '深圳', '您的货物已到达融辉物流网点', 'accepted'],
    ]);
    expect(events.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads the network\'s hub scans without the staff they name', () => {
    const result = parseRoh56(raw('network'), NETWORK, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '快件已【签收】,签收网点是【西安港务站】',
      last_update: '2026-03-27T13:54:00+08:00' });
    const events = result.events!;
    expect(events).toHaveLength(9);
    expect(events.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit',
      'in_transit', 'in_transit', 'in_transit', 'accepted']);
    expect(events[1]).toEqual({ time: '2026-03-27T13:49:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2026-03-27T13:49', location: '西安港务站,西安市', description: '【西安港务站】已做派件扫描', stage: 'out_for_delivery',
      stage_source: 'carrier_map' });
    expect(events[2]).toMatchObject({ description: '快件到达【西安港务站】,上一站是【西安分拨】' });
    expect(events.at(-1)).toMatchObject({ location: '神山文初部,广州市', description: '快件在【神山文初部】已做收件扫描', stage: 'accepted' });
    expect(JSON.stringify(result)).not.toMatch(/某某|扫描员|收件员|派件员|签收人|管理员/);
  });

  it('leaves out the staff a row names and anything after a phone', () => {
    expect(roh56Row('快件到达【广州分拨】,上一站是【广州神山站】,扫描员是【某某】')).toEqual({ description: '快件到达【广州分拨】,上一站是【广州神山站】' });
    expect(roh56Row('【西安港务站】已做派件扫描，扫描员是【某某】,派件员是【某某】')).toEqual({ description: '【西安港务站】已做派件扫描' });
    expect(roh56Row('快件已【签收】,签收网点是【西安港务站】签收人是【某某】')).toEqual({ description: '快件已【签收】,签收网点是【西安港务站】' });
    expect(roh56Row('您的货物已到达派送网点，联系电话13800000000')).toEqual({ description: '您的货物已到达派送网点' });
    expect(roh56Row('已签收')).toEqual({ description: '已签收' });
  });

  it('reads the record\'s delivered state, and leaves out a row dated after the lookup', () => {
    const withoutDelivery = changed(/<DATETIME>2025-05-24 15:58<\/DATETIME>.*\r?\n/, '');
    expect(parseRoh56(withoutDelivery, NUMBER, READ_AT)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_status_text: '您的货物已到达派送网点 联系收货人送货中' });
    expect(parseRoh56(withoutDelivery.replace('<STATE>3', '<STATE>1'), NUMBER, READ_AT))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(parseRoh56(raw('delivered'), NUMBER, Date.parse('2025-05-24T12:00:00+08:00')).last_update_local).toBe('2025-05-24T10:58');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseRoh56(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseRoh56(raw('delivered'), NETWORK, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRoh56(changed(/^100/, '-1'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRoh56(changed('<DATETIME>2025-05-21 ', '<DATETIME>2025-05-32 '), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRoh56(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: BodyInit, init?: ResponseInit) => new Roh56Tracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(new Roh56Tracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(bytes('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(bytes('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.roh56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeRoh56Number(` ${NUMBER} `)).toBe(NUMBER);
    expect(normalizeRoh56Number('rh-1234 5678')).toBe('RH12345678');
    for (const number of ['1234567', 'ABCDEFGHIJ', '1'.repeat(31), '7348/9114', '']) {
      expect(() => normalizeRoh56Number(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new Roh56Tracker({ fetcher }).fetch('1234567')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new Roh56Tracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'roh56', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the rows by their sentence, whatever facility the brackets name', () => {
    expect(roh56Stage('快件在【成都分拨】完成装车,正发往【成都港务站】')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(roh56Stage('您的货物已装车发往四川分拨')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(roh56Stage('【成都港务站】已做派件扫描')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(statusMap.stage(null, '快件已【签收】,签收网点是【成都港务站】')).toBe('delivered');
    expect(statusMap.stage(null, '快件到达')).toBeUndefined();
    expect(statusMap.stage('1', '已签收')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});
