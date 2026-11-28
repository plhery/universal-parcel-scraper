import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ks2homeQueryUrl, parseKs2home } from './adapter.js';
import { ks2homeStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const WAYBILL = numbers.records[0]!.number;
const UNKNOWN = 'DE2602049901';
const page = (name: 'customs' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('Ks2Home', () => {
  it('asks the waybill page through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(page('customs'), { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' } as never);
    expect(instance).toMatchObject({ id: 'ks2home', steps: ['direct', 'retry'], recordsSteps: true });
    await expect(instance.track({ number: WAYBILL.toLowerCase() }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'customs' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`http://www.ks2home.de/express/query/?code=${WAYBILL}`);
    expect(ks2homeQueryUrl(WAYBILL)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('reads the example newest first, keeping each wall clock', () => {
    const result = parseKs2home(page('customs'), WAYBILL);
    expect(result).toEqual(expect.objectContaining({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: '清关中 - 包裹清关中，请耐心等待', last_update: null, last_update_local: '2026-02-14T03:24:40', expected_delivery: null }));
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-02-14T03:24:40', '中国', '清关中 - 包裹清关中，请耐心等待', 'customs'],
      ['2026-02-11T23:51:48', '中国', '已抵达 - 货物抵达中国 / Arrive in China', 'in_transit'],
      ['2026-02-09T22:49:38', '德国-法兰克福', '航班已起飞 - 货物已发往中国 / Deliver to China', 'in_transit'],
      ['2026-02-08T20:13:21', '德国-法兰克福', '货物已到达机场 - 货物已到达机场，等待起飞 / Deliver to the Airport, Awaiting Departure', 'in_transit'],
      ['2026-02-07T18:22:53', '德国-法兰克福', '货物已发往机场 - 货物已发往机场 / To the Airport', 'in_transit'],
      ['2026-02-05T19:13:47', '德国-法兰克福', '快递已揽收 - 已打包完成交付快递 / Packaged and delivered express', 'in_transit'],
      ['2026-02-05T04:13:58', '德国-法兰克福', '仓库处理中 - 分拣打包中 / Packaging at munich', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.time_zone === undefined
      && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('answers only for the number asked', () => {
    expect(() => parseKs2home(page('customs'), 'DE2602041058')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKs2home(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const empty = page('customs').replace(/<ul id="express-list-0">[\s\S]*?<\/ul>/u, '<ul id="express-list-0"></ul>');
    expect(() => parseKs2home(empty, WAYBILL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKs2home(page('customs').replace('2026-02-14 03:24:40', '2026-02-30 03:24:40'), WAYBILL))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKs2home('<html><body>Service unavailable</body></html>', WAYBILL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKs2home(page('customs'), 'DE-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads a browser check or a refusal as a challenge', async () => {
    const check = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    for (const [body, status] of [[check, 200], ['Forbidden', 403]] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
      const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
      await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'challenge' });
    }
  });

  it('reads the waybill page\'s links', () => {
    expect(parseTrackingInput(`http://www.ks2home.de/express/query/?code=${WAYBILL}`)).toMatchObject({ trackingNumber: WAYBILL, carrier: 'ks2home' });
  });

  it('maps the firm\'s wordings', () => {
    expect(ks2homeStage('航班已起飞 - 货物已发往中国 / Deliver to China')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage(null, '清关中 - 包裹清关中，请耐心等待')).toBe('customs');
    expect(statusMap.gaps).toEqual([]);
  });
});
