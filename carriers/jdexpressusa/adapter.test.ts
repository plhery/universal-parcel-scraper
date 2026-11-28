import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JDEXPRESSUSA_API, JDEXPRESSUSA_SITE, JdExpressUsaTracker, jdExpressUsaLookupUrl } from './adapter.js';
import { jdExpressUsaZone, normalizeJdExpressUsaNumber, parseJdExpressUsa } from './parser.js';
import { jdExpressUsaStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = numbers.records[0]!.number;
const UNKNOWN = 'ZZ999999990US';
// After the sample's newest row, on Shanghai's clock.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
type Fixture = 'in-transit' | 'not-found';
const bytes = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));
// The server answers in GBK.
const raw = (name: Fixture) => new TextDecoder('gb18030').decode(bytes(name));
const changed = (from: string | RegExp, to: string) => raw('in-transit').replace(from, to);
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('JD Express USA tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport, and reads its GBK', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${SAMPLE.slice(0, 2).toLowerCase()} ${SAMPLE.slice(2, 7)}-${SAMPLE.slice(7)}`;
    const result = await new JdExpressUsaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'customs', last_status_text: '已到达清关口岸，等待海关查验' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(jdExpressUsaLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(JDEXPRESSUSA_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: SAMPLE });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: JDEXPRESSUSA_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jdexpressusa', step: 'direct', outcome: 'ok' }));
  });

  it('reads the space-padded clocks: US rows on Pacific time until the flight, rows in China on China\'s clock', () => {
    const result = parseJdExpressUsa(raw('in-transit'), SAMPLE, READ_AT);
    expect(result).toMatchObject({ current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: '已到达清关口岸，等待海关查验', last_update: '2016-09-19T09:00:00+08:00', last_update_local: '2016-09-19T09:00',
      expected_delivery: null, weight_kg: 2 });
    // The destination is a Chinese province and town, and China Post's number is the waybill itself.
    expect(result).not.toHaveProperty('destination_country');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.time, event.time_zone_basis, event.local_time, event.description, event.stage])).toEqual([
      ['2016-09-19T09:00:00+08:00', 'destination', '2016-09-19T09:00', '已到达清关口岸，等待海关查验', 'customs'],
      ['2016-09-17T01:46:00+08:00', 'place', '2016-09-17T01:46', '已抵达中国中转口岸，等待发往清关口岸', 'in_transit'],
      ['2016-09-15T09:46:00-07:00', 'carrier', '2016-09-15T09:46', '在飞往中国途中', 'in_transit'],
      ['2016-09-14T14:00:00-07:00', 'place', '2016-09-14T14:00', '已到达洛杉矶国际机场仓储', 'in_transit'],
      ['2016-09-13T18:00:00-07:00', 'carrier', '2016-09-13T18:00', '已到达本快递公司仓储', 'accepted'],
    ]);
    expect(result.events!.every((event) => !('location' in event) && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('pads a one-digit hour whatever the spaces before it, and refuses a clock that is not one', () => {
    const padded = parseJdExpressUsa(changed('2016-09-14  14:00', '2016-09-14 4:00'), SAMPLE, READ_AT).events!
      .find((event) => event.description === '已到达洛杉矶国际机场仓储');
    expect(padded).toMatchObject({ local_time: '2016-09-14T04:00', time: '2016-09-14T04:00:00-07:00' });
    for (const clock of ['2016-09-14  4:0', '2016-09-14  24:00', '2016-09-14 14:00:6']) {
      expect(() => parseJdExpressUsa(changed('2016-09-14  14:00', clock), SAMPLE, READ_AT), clock)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('dates a row on Pacific time or China\'s clock by what it says, and leaves one that says neither on its wall clock', () => {
    expect(jdExpressUsaZone('', '已到达本快递公司仓储')).toEqual({ zone: 'America/Los_Angeles', basis: 'carrier' });
    expect(jdExpressUsaZone('', '已到达洛杉矶国际机场仓储')).toEqual({ zone: 'America/Los_Angeles', basis: 'place' });
    expect(jdExpressUsaZone('', '在飞往中国途中')).toEqual({ zone: 'America/Los_Angeles', basis: 'carrier' });
    expect(jdExpressUsaZone('', '已抵达中国中转口岸，等待发往清关口岸')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(jdExpressUsaZone('', '已到达清关口岸，等待海关查验')).toEqual({ zone: 'Asia/Shanghai', basis: 'destination' });
    expect(jdExpressUsaZone('', '已收货')).toBeNull();
    const undated = parseJdExpressUsa(changed('<INFO>在飞往中国途中', '<INFO>已收货'), SAMPLE, READ_AT).events!
      .find((event) => event.description === '已收货');
    expect(undated).toEqual({ local_time: '2016-09-15T09:46', description: '已收货' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseJdExpressUsa(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJdExpressUsa(raw('in-transit'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJdExpressUsa(changed(/^100/, '-1'), SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJdExpressUsa(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), SAMPLE, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: BodyInit, init?: ResponseInit) => new JdExpressUsaTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(SAMPLE, { budgetMs: 5000 });
    await expect(new JdExpressUsaTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(bytes('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(bytes('in-transit'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.jdexpressusa.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeJdExpressUsaNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const number of ['DG0500', 'ABCDEFGHIJ', '1'.repeat(31), 'DG050020042US/1', '']) {
      expect(() => normalizeJdExpressUsaNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new JdExpressUsaTracker({ fetcher }).fetch('DG0500')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new JdExpressUsaTracker({ fetcher }).fetch(SAMPLE, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'jdexpressusa', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps every wording in statuses.json', () => {
    for (const entry of statuses.entries) expect(jdExpressUsaStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    expect(statusMap.stage('1', '在飞往中国途中')).toBeUndefined();
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});
