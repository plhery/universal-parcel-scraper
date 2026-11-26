import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, YLEXP_API, YLEXP_SITE, YlexpTracker, ylexpLookupUrl } from './adapter.js';
import { normalizeYlexpNumber, parseYlexp } from './parser.js';
import { statusMap, ylexpStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'PQ5J999999999999999999P';
const READ_AT = Date.parse('2026-11-26T12:00:00+08:00');
const raw = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('Yi Long Express tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new YlexpTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${NUMBER.slice(0, 8).toLowerCase()} ${NUMBER.slice(8)} `, { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(ylexpLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(YLEXP_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: YLEXP_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ylexp', step: 'direct', outcome: 'ok' }));
  });

  it('reads the record\'s delivered state over rows that stop at the sort facility', () => {
    const result = parseYlexp(raw('delivered'), NUMBER, READ_AT);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Departed from sort facility', last_update: null, last_update_local: '2023-12-13T16:05',
      expected_delivery: null, destination_country: 'ES', weight_kg: 0.984, events: [
        { local_time: '2023-12-13T16:05', description: 'Departed from sort facility', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-12-13T16:04', description: 'PickUp Scan', stage: 'accepted', stage_source: 'carrier_map' },
      ] });
    // Without that state the rows decide.
    expect(parseYlexp(changed('<STATE>3', '<STATE>1'), NUMBER, READ_AT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map' });
    // The free-text reference, the inner number and the origin are not kept.
    expect(JSON.stringify(result)).not.toMatch(/XIANXIA|GO902379825ET|中国/);
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseYlexp(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYlexp(raw('delivered'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYlexp(changed(/^100/, '-3'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYlexp(changed('<INFO>PickUp Scan</INFO>', '<INFO>PickUp Scan'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new YlexpTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(raw('delivered'), { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(raw('delivered'), { status: 410 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>验证码</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{}')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('retries only a request that fails to reach the server', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('delivered')));
    await expect(new YlexpTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ destination_country: 'ES' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts a waybill shape only, without a request', async () => {
    for (const number of ['PQ5J96', 'PQJPQJPQJPQJ', `PQ${'5'.repeat(30)}`, 'PQ5J/960718954380108015P', '']) {
      expect(() => normalizeYlexpNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new YlexpTracker({ fetcher }).fetch('PQ5J96')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'ylexp', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the wordings seen', () => {
    expect(ylexpStage('PickUp Scan')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(ylexpStage('Arrived at destination country')).toMatchObject({ stage: 'in_transit' });
    expect(statusMap.stage(null, 'departed from sort facility')).toBe('in_transit');
    expect(statusMap.stage('3', '送达！')).toBe('delivered');
  });
});
