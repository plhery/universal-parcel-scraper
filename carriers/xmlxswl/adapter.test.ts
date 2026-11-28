import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, lxsLookupUrl, lxsPageUrl } from './adapter.js';
import { normalizeLxsNumber, parseLxs } from './parser.js';
import { lxsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const inTransit = fixture('in-transit.json');
const notFound = fixture('not-found.txt');
const number = '3101104';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('Longxinshun Logistics numbers', () => {
  it('takes a waybill number in digits', () => {
    expect(normalizeLxsNumber(' 310 1104 ')).toBe(number);
    for (const raw of ['1234', 'ABC12345', `${number}/x`, '1'.repeat(19)]) {
      expect(() => normalizeLxsNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Longxinshun Logistics tracker', () => {
  it('sends the lookup the firm\'s tracking page sends, under its company id', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(inTransit));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lxsLookupUrl(number));
    expect(String(url)).toBe(`https://www.1008656.com/index.aspx?do=waybill&id=73320&keyword=${number}`);
    expect(lxsPageUrl(number)).toBe(`https://www.1008656.com/index.aspx?id=73320&keyword=${number}`);
    expect(init?.method).toBe('POST');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '分流出库', last_update: null, last_update_local: '2023-11-06',
    });
  });

  it('reads the rows newest first, each dated by its day, at the place it starts with', () => {
    const { events = [] } = parseLxs(inTransit, number);
    expect(events).toEqual([
      { local_time: '2023-11-06', location: '厦门', description: '分流出库', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2023-11-04', location: '厦门', description: '开单入库', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
  });

  it('dates a row that gives a clock on the branches\' clock, and keeps one day\'s rows in the reply\'s order', () => {
    // Synthetic rows in the platform's shape.
    const body = JSON.stringify({ track: [
      { billdate: '2023/11/4', content: '【厦门】开单入库' },
      { billdate: '2023/11/4 9:05', content: '【厦门】分流出库，司机：张三 13900000000' },
      { billdate: '2023/11/4', content: '【厦门】开单入库' },
    ] });
    const { events = [] } = parseLxs(body, number);
    expect(events.map((event) => [event.local_time, event.time, event.time_zone_basis, event.description])).toEqual([
      ['2023-11-04T09:05:00', '2023-11-04T09:05:00+08:00', 'carrier', '分流出库'],
      ['2023-11-04', undefined, undefined, '开单入库'],
    ]);
    expect(JSON.stringify(events)).not.toMatch(/张三|13900000000/);
  });

  it('stages every recorded wording, and others by the shared rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage('', entry.wording)).toBe(entry.stage);
    // Synthetic: a wording the map does not know falls to the shared rules.
    expect(lxsStage('货物已签收')?.stage).toBe('delivered');
  });

  it('reads the platform\'s notice for an unknown number as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(notFound));
    await expect(tracker(fetcher).track({ number: '9876543' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('does not take another number\'s notice, a refusal, a changed reply or a verification page for a missing shipment', async () => {
    expect(() => parseLxs(notFound, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLxs("{status:1,msg:'访问出错。*',", number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLxs(inTransit.replace('2023/11/6', '2023/2/30'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLxs(inTransit.replace('2023/11/6', '昨天'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLxs('{"rows":[]}', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLxs('{"track":[]}', number)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseLxs('<html><head><title>500 Internal Server Error</title></head></html>', number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLxs('<html><head><title>安全验证</title></head></html>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><head><title>Just a moment...</title></head></html>', 403));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const limited = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('', 429));
    await expect(tracker(limited).track({ number })).rejects.toMatchObject({ kind: 'rate_limited' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('<html><body>Runtime Error</body></html>', 500));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
  });
});
