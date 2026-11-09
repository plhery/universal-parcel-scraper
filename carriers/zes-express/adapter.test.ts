import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ZesExpressTracker, ZES_API, ZES_CALLBACK, ZES_PAGE } from './adapter.js';
import { normalizeZesExpressNumber, parseZesExpress } from './parser.js';
import { statusMap, zesExpressStage } from './status.js';

const NUMBER = 'ZESZE7312064859YQ';
const UNKNOWN = 'ZESZE9472063815YQ';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const jsonp = (data: unknown) => `${ZES_CALLBACK}(${JSON.stringify(data)})`;
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(jsonp(data), { status,
  headers: { 'content-type': 'text/javascript; charset=utf-8', ...headers } });
const changed = (change: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); change(data); return data; };

describe('ZES Express guest RTB56 adapter', () => {
  it('uses the whole forwarding identifier and query-derived key through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new ZesExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zesze 7312064859 yq ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    const requested = new URL(String(url));
    expect(requested.origin + requested.pathname).toBe(ZES_API);
    expect(JSON.parse(requested.searchParams.get('param')!)).toEqual({ sp: '', nums: [NUMBER] });
    expect(requested.searchParams.get('callbackparam')).toBe(ZES_CALLBACK);
    expect(requested.searchParams.get('method')).toBe('track');
    expect(requested.searchParams.get('key')).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: `${ZES_PAGE}?track_number=${NUMBER}`, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'zes-express', step: 'direct', outcome: 'ok' }));
  });

  it('requires the primary identity, never accepting a merchant echo or another shipment', () => {
    expect(normalizeZesExpressNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['7312064859', 'ZESZE731206485YQ', 'ZESZE73120648590YQ', 'CDEK7312064859']) {
      expect(() => normalizeZesExpressNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
    for (const value of [
      changed(d => { d.data[0].server_hawbcode = UNKNOWN; d.data[0].shipper_hawbcode = NUMBER; }),
      changed(d => { delete d.data[0].server_hawbcode; d.data[0].shipper_hawbcode = NUMBER; }),
      changed(d => { d.data.push(d.data[0]); }),
    ]) expect(() => parseZesExpress(value, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZesExpress(changed(d => { d.data[0].destination_country = 'US'; }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('preserves stated offsets separately from unlabelled clocks and does not infer a Moscow offset', () => {
    const result = parseZesExpress(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2031-01-04T11:58:49', destination_country: 'RU', delivery_tracking_number: '71000000000139' });
    expect(result.events).toHaveLength(4);
    expect(result.events![0]).toMatchObject({ local_time: '2031-01-04T11:58:49', stage: 'delivered', provider_code: 'O010' });
    expect(result.events![1]).toMatchObject({ stage: 'in_transit', provider_code: 'AADO' });
    expect(result.events![2]).toMatchObject({ time: '2031-01-02T09:41:07+08:00', location: 'МОСКВА', stage: 'in_transit' });
    expect(result.events![3]).toMatchObject({ time: '2031-01-02T09:34:01+08:00', stage: 'accepted' });
    expect(result.events!.every(event => !event.time_zone && !event.time_zone_basis)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private\.invalid|signatory|pod_url|MERCHANT/);
  });

  it('reads an explicit onward identifier without inventing a CDEK mapping or claiming closure is delivery', () => {
    const reply = changed(d => { d.data[0].track_status = 'CC'; d.data[0].details = [d.data[0].details[3]]; });
    expect(parseZesExpress(reply, NUMBER).current_stage).toBe('accepted');
    for (const onward of ['', NUMBER, 'https://private.invalid/doc', 'ABC&D']) {
      expect(parseZesExpress(changed(d => { d.data[0].channel_hawbcode = onward; }), NUMBER).delivery_tracking_number).toBeUndefined();
    }
    expect(zesExpressStage('Принят на склад доставки', 'AADO')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(zesExpressStage('Партионный', '')).toBeNull();
    expect(statusMap.stage(null, 'партионный')).toBeUndefined();
    expect(statusMap.gaps).toContainEqual(expect.objectContaining({ wording: 'партионный' }));
  });

  it('omits explicitly labelled recipient and signature suffixes in Russian scan wording', () => {
    for (const label of ['Получатель', 'Подпись', 'ФИО получателя']) {
      const result = parseZesExpress(changed(d => {
        d.data[0].details[0].track_description_en = `Вручение адресату; ${label}: PRIVATE PERSON +79000000000`;
      }), NUMBER);
      expect(result.events![0]!.description).toBe('Вручение адресату');
      expect(result.current_stage).toBe('delivered');
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|79000000000/);
    }
  });

  it('distinguishes exact missing from empty history, changed schema and a challenged page', async () => {
    const missing = { success: 0, enmessage: 'No query to track information' };
    await expect(new ZesExpressTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(missing)) }).fetch(UNKNOWN))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseZesExpress(changed(d => { d.data[0].details = []; }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseZesExpress({ success: 0, enmessage: 'Try again later' }, NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseZesExpress(changed(d => { d.data[0].details[0].track_occur_date = '2031-02-30 11:58:49'; }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(new Response('<title>Just a moment</title><script>_cf_chl_opt</script>'));
    await expect(new ZesExpressTracker({ fetcher: blocked }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(blocked).toHaveBeenCalledOnce();
  });

  it('keeps endpoint and rate-limit failures separate and retries only an unreachable transport', async () => {
    for (const status of [301, 404, 410]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status));
      await expect(new ZesExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const limited = vi.fn<typeof fetch>().mockResolvedValue(response({}, 429, { 'retry-after': '7' }));
    await expect(new ZesExpressTracker({ fetcher: limited }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    expect(limited).toHaveBeenCalledOnce();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network')).mockResolvedValueOnce(response(fixture()));
    await expect(new ZesExpressTracker({ fetcher: flaky }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('preserves cancellation and supplied budget without invoking a browser', async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn<typeof fetch>();
    await expect(new ZesExpressTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    expect(instance.recognizeWithBrowser).toBeUndefined();
    expect(instance.steps).toEqual(['direct', 'retry']);
  });

  it('confirms its existing candidate over HTTP before the ordinary native lookup', async () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).toContain('zes-express');
    expect(hasDirectHandoffAdapter('zes-express', NUMBER)).toBe(true);
    expect(hasDirectHandoffAdapter('zes-express', '7312064859')).toBe(false);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()));
    const answer = await createTracker({ providers: [], env: {}, fetcher }).track({ number: NUMBER });
    expect(answer).toMatchObject({ carrier: 'zes-express', source: 'zes-express', result: { current_stage: 'delivered' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    expect(await instance.recognize!('7312064859')).toMatchObject({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
