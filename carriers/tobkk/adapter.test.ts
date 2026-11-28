import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TOBKK_TRACKING } from './adapter.js';
import { normalizeTobkkNumber, parseTobkk } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const delivered = fixture('delivered.html');
const notFound = fixture('not-found.html');
const number = 'THATXW10000000ABC';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const page = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('Thai Bear waybill numbers', () => {
  it('takes one waybill in letters and digits', () => {
    expect(normalizeTobkkNumber(' thatxw 10000000abc ')).toBe(number);
    for (const raw of ['THATXWABC', 'TH12', `${number};THATXW10000000ABD`]) {
      expect(() => normalizeTobkkNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Thai Bear tracking page', () => {
  it('asks the tracking form with the number alone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(delivered));
    const result = await tracker(fetcher).track({ number });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TOBKK_TRACKING}?order_num=${number}`);
    expect(init?.method).toBe('GET');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: '已完成',
      last_update: null, last_update_local: '2023-08-18T20:44:05',
      delivery_tracking_number: 'TH105569T28DEDW', delivery_carrier: 'flash-express',
    });
  });

  it('reads the scans newest first on their wall clock, staged by their wording', () => {
    const { events = [] } = parseTobkk(delivered, number);
    expect(events.map((event) => [event.local_time, event.provider_code, event.location, event.stage])).toEqual([
      ['2023-08-18T20:44:05', '已完成', undefined, 'delivered'],
      ['2023-08-18T20:44:01', '已完成', '曼谷仓SE', 'in_transit'],
      ['2023-08-18T20:43:52', '分拣', '曼谷仓SE', 'in_transit'],
      ['2023-08-18T20:43:45', '运输中', '广州仓', 'in_transit'],
      ['2023-08-18T20:43:39', '待出库', '广州仓', 'accepted'],
      ['2023-08-18T20:43:32', '待验货', '广州仓', 'registered'],
    ]);
    expect(events[1]?.description).toBe('货物在【曼谷仓SE】安排【FLASH快递】配送，请注意查收');
    expect(events.some((event) => event.time)).toBe(false);
  });

  it('stages every recorded wording by the map, for any warehouse, and a label only where it means one stage', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording.replaceAll('{station}', '曼谷仓'))).toBe(entry.stage);
    expect(statusMap.stage('运输中', '货物已到达口岸')).toBe('in_transit');
    expect(statusMap.stage('已完成', '货物已转交')).toBeUndefined();
  });

  it('names no delivery partner for a courier the map does not know', () => {
    // Synthetic: another Thai courier.
    const result = parseTobkk(delivered.replace('FLASH快递', 'BEST快递'), number);
    expect(result).toMatchObject({ delivery_tracking_number: 'TH105569T28DEDW' });
    expect(result).not.toHaveProperty('delivery_carrier');
  });

  it('reports a number the tracker holds nothing for as not found, only when its form keeps that number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(notFound));
    await expect(tracker(fetcher).track({ number: 'THATXW00000000ABC' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseTobkk(notFound, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTobkk(delivered, 'THATXW10000000ABD')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not take a failure, a changed page or a verification page for a missing order', async () => {
    expect(() => parseTobkk('<html><body><form><input name="order_num" value=""></form></body></html>', number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTobkk(delivered.replace('2023-08-18 20:44:05', '18/08/2023 20:44'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><head><title>Just a moment...</title></head></html>', 403));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><body>请输入验证码</body></html>'));
    await expect(tracker(blocked).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><body>Service Unavailable</body></html>', 503));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
    const other = vi.fn<typeof fetch>().mockResolvedValueOnce(page('<html><head><title>泰熊物流</title></head><body></body></html>'));
    await expect(tracker(other).track({ number })).rejects.toMatchObject({ kind: 'schema' });
  });
});
