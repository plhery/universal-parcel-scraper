import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HGD_API, HGD_SITE, HgdTracker, hgdLookupUrl } from './adapter.js';
import { normalizeHgdNumber, parseHgd } from './parser.js';
import { hgdStage, statusMap } from './status.js';

const NUMBER = 'HGDGY1910830544YQ';
const UNKNOWN = 'HGDZZ0000000000YQ';
// After the sample's newest row, on Shenzhen's clock.
const READ_AT = Date.parse('2026-11-20T18:00:00+08:00');
const raw = (name: 'in-transit' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const changed = (from: string | RegExp, to: string) => raw('in-transit').replace(from, to);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('HGD tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new HgdTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' hgdgy 1910-8305-44yq ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(hgdLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(HGD_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: HGD_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hgd', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, with wall clocks, the destination and the weight', () => {
    const result = parseHgd(raw('in-transit'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'wording:language',
      last_status_text: 'Package in transit to destination country', last_update: null, last_update_local: '2026-11-20T09:05',
      expected_delivery: null, destination_country: 'GB', weight_kg: 0.78 });
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-11-20T09:05', '2026-11-19T21:05', '2026-11-18T21:05',
      '2026-11-16T09:14', '2026-11-14T17:35']);
    expect(result.events!.every((event) => !event.time)).toBe(true);
    expect(result.events![2]).toMatchObject({ location: '深圳市', description: 'Customs export clearance completed' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-11-14T17:35', description: '已入库，到达收货点', stage: 'accepted',
      stage_source: 'carrier_map' });
    expect(result.events![3]).toMatchObject({ description: '快件出仓', stage: 'in_transit', stage_source: 'carrier_map' });
    // The sender's address and the inner number stay out.
    expect(JSON.stringify(result)).not.toMatch(/xihelu|三水|FC2610231607539/);
  });

  it('leaves out a row dated after the lookup on the forwarder\'s clock', () => {
    const result = parseHgd(raw('in-transit'), NUMBER, Date.parse('2026-11-20T09:00:00+08:00'));
    expect(result.last_update_local).toBe('2026-11-19T21:05');
    expect(result.events).toHaveLength(4);
    expect(() => parseHgd(raw('in-transit'), NUMBER, Date.parse('2026-11-14T17:00:00+08:00'))).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHgd(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHgd(raw('in-transit'), 'HGDGY1910830545YQ', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHgd(changed('<TRCKING_NBR>HGDGY1910830544YQ', '<TRCKING_NBR>'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHgd(changed(/^100/, '-1'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHgd(`${raw('in-transit')}\r\n<EMS_INFO></EMS_INFO>`, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHgd(changed('2026-11-14 17:35', '2026-11-31 17:35'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHgd(changed('<PLACE></PLACE><INFO>快件出仓</INFO>', '<INFO>快件出仓</INFO>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHgd(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(parseHgd(changed('<WEIGHT>0.780', '<WEIGHT>n/a'), NUMBER, READ_AT)).not.toHaveProperty('weight_kg');
    expect(parseHgd(changed('<DES>英国', '<DES>'), NUMBER, READ_AT)).not.toHaveProperty('destination_country');
    const lookup = (body: string, init?: ResponseInit) => new HgdTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(raw('in-transit'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.365igo.com.cn/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the server', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('in-transit')));
    await expect(new HgdTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ destination_country: 'GB' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeHgdNumber('hgdgy1910856105yq')).toBe('HGDGY1910856105YQ');
    for (const number of ['GY1910830544YQ', 'HGD1234567', 'HGDGY1910830544YQXX', 'HGXGY1910830544YQ', 'LA123456789CN', '']) {
      expect(() => normalizeHgdNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HgdTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new HgdTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hgd', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the warehouse wordings', () => {
    expect(hgdStage('已入库，到达收货点')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(hgdStage('快件出仓')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(hgdStage('Package handed over to airline')).toMatchObject({ stage: 'in_transit' });
    expect(hgdStage('仓库作业')).toBeNull();
    expect(statusMap.stage(null, '快件出仓')).toBe('in_transit');
  });
});
