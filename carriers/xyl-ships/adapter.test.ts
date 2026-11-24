import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeXylShipsNumber, parseXylShips } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };
import { xylShipsStage } from './status.js';

const NUMBER = 'NUDE9999999980EX';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));
const instance = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('XYL-Ships tracker', () => {
  it('binds the whole number, keeps the stated offsets and maps the wordings', () => {
    const result = parseXylShips(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-01-12T03:15:00+08:00', expected_delivery: null });
    expect(result.events).toHaveLength(10);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', ...Array(8).fill('in_transit')]);
    expect(result.events![0]).toMatchObject({ time: '2026-01-12T03:15:00+08:00', location: 'Los Angeles, CA', stage_source: 'carrier_map' });
    expect(result.events![3]).not.toHaveProperty('location');
    expect(result.events!.every(event => event.time?.endsWith('+08:00') && !event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  });

  it('reads the explicit absence, and keeps other refusals and malformed replies apart', () => {
    expect(() => parseXylShips({ code: -1, message: { error: '未找到对应的物流订单' } }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [{ code: -1, message: { error: '系统繁忙' } }, { code: 1, data: null }]) {
      expect(() => parseXylShips(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const payload of [null, {}, { code: '0', data: {} }, { code: 0, data: [] }]) {
      expect(() => parseXylShips(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = fixture(); empty.data.events = [];
    expect(() => parseXylShips(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects another shipment and malformed scans', () => {
    for (const mutate of [
      (p: ReturnType<typeof fixture>) => { p.data.transfer_no = 'NUDE9999999981EX'; },
      (p: ReturnType<typeof fixture>) => { p.data.transfer_no = NUMBER + '1'; },
      (p: ReturnType<typeof fixture>) => { delete p.data.transfer_no; },
      (p: ReturnType<typeof fixture>) => { p.data.events = {}; },
      (p: ReturnType<typeof fixture>) => { p.data.events[0].event_time = '2026-01-12 03:15:00'; },
      (p: ReturnType<typeof fixture>) => { p.data.events[0].event_time = '2026-02-30T03:15:00+08:00'; },
      (p: ReturnType<typeof fixture>) => { p.data.events[0].content = null; },
      (p: ReturnType<typeof fixture>) => { p.data.events[0].content = '<html>Denied</html>'; },
      (p: ReturnType<typeof fixture>) => { p.data.events[0].location = 7; },
    ]) {
      const p = fixture(); mutate(p);
      expect(() => parseXylShips(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('orders scans by instant, removes exact duplicates and leaves a new wording unmapped', () => {
    const p = fixture(); p.data.events.reverse(); p.data.events.push(p.data.events[0]);
    const sorted = parseXylShips(p, NUMBER);
    expect(sorted.events).toHaveLength(10);
    expect(sorted.events![0]!.description).toBe('Delivered');
    p.data.events.push({ id: 9011, content: 'Parcel returned to the warehouse', event_time: '2026-01-13T09:00:00+08:00', location: '', order: 999001 });
    const result = parseXylShips(p, NUMBER);
    expect(result.status).toBe('unknown'); expect(result).not.toHaveProperty('current_stage');
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('uses the supplied transport and the tracker GET without a session', async () => {
    const fetcher = vi.fn(async (url, init) => {
      expect(String(url)).toBe(`https://siking-track.com/api/tracking/?transfer_no=${NUMBER}&documentCode=${NUMBER}`);
      expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('cookie')).toBeNull();
      return Response.json(fixture());
    });
    const result = await instance(fetcher).track({ number: NUMBER.toLowerCase() }, { budgetMs: 1000 });
    expect(result.events).toHaveLength(10); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429, 302, 503])('never retries an HTTP %s or turns it into absence', async status => {
    const fetcher = vi.fn(async () => new Response('refused', { status }));
    await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: status === 403 ? 'challenge' : status === 429 ? 'rate_limited' : status === 503 ? 'maintenance' : 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('maps every recorded wording, a customs hold at the border among them', () => {
    for (const entry of statuses.entries) expect(xylShipsStage(null, entry.wording), entry.wording).toBe(entry.stage);
    expect(xylShipsStage(null, 'Detained by customs officials')).toBe('customs');
  });

  it('keeps HTML challenges and malformed JSON distinct from absence', async () => {
    for (const [body, kind] of [['<title>Just a moment</title>', 'challenge'], ['<html>maintenance</html>', 'schema']]) {
      const fetcher = vi.fn(async () => new Response(body));
      await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('retries only a network failure and honors cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(Response.json(fixture()));
    expect((await instance(fetcher).track({ number: NUMBER })).events).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const controller = new AbortController(); controller.abort(); fetcher.mockClear();
    await expect(instance(fetcher).track({ number: NUMBER }, { signal: controller.signal })).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses fragments and lists without a request, and claims NUDE and XLWL numbers whole', async () => {
    expect(normalizeXylShipsNumber(' nude 9999 9999 80ex ')).toBe(NUMBER);
    for (const value of ['NUDE', NUMBER + ',NUDE9999999981EX', 'NUDE-9999999980EX/']) {
      const fetcher = vi.fn<typeof fetch>();
      await expect(instance(fetcher).track({ number: value })).rejects.toMatchObject({ kind: 'invalid_input' });
      expect(fetcher).not.toHaveBeenCalled();
    }
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'xyl-ships' });
    for (const number of ['XLWL8261937504EX', 'XLWL8261937517EXP']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'xyl-ships', confidence: 'high' });
    }
    for (const number of ['XLWL826193750EX', 'XLWL82619375040EX', 'XLWL8261937504EXPP', 'XLWL8261937504XP', 'XLWX8261937504EX']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('xyl-ships');
    }
    expect(instance(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });
});
