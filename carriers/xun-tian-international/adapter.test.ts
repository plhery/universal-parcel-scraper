import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusGapNote, normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { itdidaLookupUrl } from '../whwdt/itdida.js';
import { adapter, XunTianTracker } from './adapter.js';
import { normalizeXunTianNumber, parseXunTian, XUN_TIAN_HOST } from './parser.js';
import { statusMap, xunTianStage } from './status.js';

const NUMBER = '481736539745';
const UNKNOWN = '481799999917';
const UPDATE = '目的地派送状态更新';
const fixture = (name: 'delivered' | 'not-found') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const changed = (change: (reply: ReturnType<typeof fixture>) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' }, ...init });

describe('Xun Tian International ITDIDA tenant', () => {
  it('asks the xtl tenant for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new XunTianTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 4817-3653-9745 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://xtl.itdida.com/itdida-api/queryTracks?no=${NUMBER}`);
    expect(String(url)).toBe(itdidaLookupUrl(XUN_TIAN_HOST, NUMBER));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'xun-tian-international', step: 'direct', outcome: 'ok' }));
  });

  it('reads the delivered sample from Guangzhou to Japan on wall clocks', () => {
    const result = parseXunTian(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '签收记录', last_update: null, last_update_local: '2022-11-30T18:51:00', expected_delivery: null,
      destination_country: 'JP' });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.events).toHaveLength(12);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events!.map((event) => [event.stage ?? null, event.location ?? null])).toEqual([
      ['delivered', null], [null, null], [null, null], ['in_transit', 'KASHIWA / JAPAN'], ['in_transit', 'KASHIWA / JAPAN'],
      ['in_transit', 'KASHIWA / JAPAN'], ['in_transit', null], ['customs', null], ['in_transit', 'GUANGZHOU GATEWAY / CHINA'],
      ['in_transit', null], ['in_transit', 'GUANGZHOU GATEWAY / CHINA'], ['registered', null],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2022-11-24T14:39:12', description: '已预报' });
  });

  it('leaves each row on the clock of its place, or of the leg it sits on, for a consumer', () => {
    const events = dateLocalClocks('xun-tian-international', parseXunTian(fixture('delivered'), NUMBER)).events!;
    const zones = events.map((event) => `${event.time_zone} ${event.time_zone_basis}`);
    expect(zones).toEqual([...Array(3).fill('Asia/Tokyo neighbour'), ...Array(3).fill('Asia/Tokyo place'),
      ...Array(2).fill('Asia/Tokyo neighbour'), 'Asia/Shanghai place', 'Asia/Shanghai neighbour', 'Asia/Shanghai place',
      'Asia/Shanghai neighbour']);
    // Japan's customs release comes before the arrival at the depot in Kashiwa, as on the tracker.
    expect(events.slice(5, 7).map((event) => event.time)).toEqual(['2022-11-29T14:12:00+09:00', '2022-11-29T14:02:00+09:00']);
    expect(events[8]).toMatchObject({ time: '2022-11-26T20:41:00+08:00' });
  });

  it('keeps the stage it had through the delivering carrier\'s bare status updates', () => {
    expect(xunTianStage(UPDATE)).toBeNull();
    expect(statusGapNote(statusMap, null, normalizeStatusWording(UPDATE))).toMatch(/keeps the stage it had/);
    const result = parseXunTian(changed((r) => { r.data[0].trackList.shift(); }), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: UPDATE });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseXunTian(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseXunTian(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXunTian(changed((r) => { r.data[0].errorMsg = '查询过于频繁'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXunTian(changed((r) => { r.data[0].trackList = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: unknown, init?: ResponseInit) => new XunTianTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(fixture('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ data: 'too busy', statusCode: 503, success: false }, { status: 503 })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts the numbers the lookup takes, without a request for anything else', async () => {
    expect(normalizeXunTianNumber('4817 3653 9745')).toBe(NUMBER);
    for (const number of ['48173', 'ABCDEFGHIJ', '4'.repeat(41), '4817/3653']) {
      expect(() => normalizeXunTianNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new XunTianTracker({ fetcher }).fetch('48173')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'xun-tian-international', steps: ['direct', 'retry'], recordsSteps: true });
  });
});
