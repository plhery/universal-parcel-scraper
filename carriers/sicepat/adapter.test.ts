import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AdapterEnvironment } from '../../core/adapter/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { SicepatTracker } from './adapter.js';
import { API, normalizeSicepatNumber, PAGE, parseSicepat, sicepatJson, VERIFICATION } from './parser.js';
import { sicepatStage } from './status.js';

const NUMBER = '003179246085', TOKEN = 'fresh_synthetic_token_'.repeat(8);
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/returned.json', import.meta.url), 'utf8'));
const envelope = (token = TOKEN) => JSON.stringify({ kind: 'sicepat-app-verification', version: 1, origin: PAGE, action: 'checkAwb', token });
const changed = (edit: (p: ReturnType<typeof fixture>) => void) => { const p = fixture(); edit(p); return p; };
function setup(options: { browserHtml?: string; status?: number; payload?: unknown; fetcher?: typeof fetch; configured?: boolean } = {}) {
  const browserFetch = vi.fn<typeof fetch>(async () => Response.json({ statusCode: 200, tier: 3, html: options.browserHtml ?? envelope() }));
  const fetcher = vi.fn<typeof fetch>(options.fetcher ?? (async () => Response.json(options.payload ?? fixture(), { status: options.status ?? 200 })));
  const trawl = new TrawlClient('http://browser.test', browserFetch);
  const environment: AdapterEnvironment = { env: {}, fetcher, trawl: options.configured === false ? null : trawl,
    browserExecutablePath: null, recorder: NOOP_RECORDER };
  return { environment, tracker: new SicepatTracker(environment), fetcher, browserFetch, trawl };
}

describe('SiCepat app history', () => {
  it('binds the complete waybill and keeps every dated scan with local minute precision', () => {
    const result = parseSicepat(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'returned', status: 'exception', last_update: null,
      last_update_local: '2026-11-10T21:31', expected_delivery: null });
    expect(result.events).toHaveLength(24);
    expect(result.events![0]).toMatchObject({ provider_code: 'RETURN TO SHIPPER', stage: 'returned', local_time: '2026-11-10T21:31', location: 'Tangerang Kosambi FM' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: 'PICKREQ', stage: 'registered', local_time: '2026-10-30T07:17' });
    expect(result.events!.every(e => !e.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic Courier|receiver|address|sigesit_img|POD_/);
    expect(result.events!.find(e => e.provider_code === 'ANT')!.description).toBe('Paket dibawa [SIGESIT]');
    expect(result.events!.find(e => e.provider_code === 'ANT')!.location).toBeUndefined();
    expect(result.events!.find(event => event.description?.includes('pick up oleh'))).not.toHaveProperty('location');
    expect(result.events!.at(-1)!.location).toBeUndefined();
  });

  it('keeps the return open until the shipper receives it', () => {
    const history = (p: ReturnType<typeof fixture>) => p.data.sicepat.result.track_history as { status: string }[];
    const carried = parseSicepat(changed(p => { history(p).pop(); }), NUMBER);
    expect(carried).toMatchObject({ current_stage: 'exception', last_update_local: '2026-11-10T11:10' });
    expect(carried.events![0]).toMatchObject({ provider_code: 'ANT_RETUR', stage: 'exception' });
    const hub = parseSicepat(changed(p => { history(p).pop(); history(p).at(-1)!.status = 'RETUR PUSAT'; }), NUMBER);
    expect(hub).toMatchObject({ current_stage: 'exception' });
  });

  it('rejects shortened, numeric, other and absent response identities', () => {
    for (const id of [undefined, NUMBER.slice(1), Number(NUMBER), '003179246086']) {
      expect(() => parseSicepat(changed(p => { p.data.sicepat.result.waybill_number = id; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const input of ['', 'TKP01003179246085', '00317924608', '0031792460850', '003 179246085']) expect(() => normalizeSicepatNumber(input)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('distinguishes explicit database absence from verification, rate limits and ambiguous replies', () => {
    const missing = { code: '400000', statusCode: 400, message: "Invalid AWB number: Can't get waybill from database" };
    expect(() => parseSicepat(missing, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSicepat({ ...missing, message: 'Invalid AWB number' }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSicepat({ ...missing, message: 'Invalid Re-Captcha token' }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSicepat({ message: 'Too many requests' }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseSicepat(changed(p => { p.data.sicepat.status = { code: 404, description: 'Not Found' }; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSicepat(changed(p => { p.data.sicepat.result.track_history = []; }), NUMBER)).toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
    for (const data of [null, {}, [], { code: '200000', statusCode: 200 }]) expect(() => parseSicepat(data, NUMBER)).toThrow();
    expect(() => sicepatJson('<html>Just a moment</html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => sicepatJson('{broken')).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects invalid clocks and rows, keeps unknown actions and deduplicates exact repeats', () => {
    for (const value of ['2026-02-30 10:00', '2026-11-01 24:00', '2026-11-01 10:00+07:00', null]) {
      expect(() => parseSicepat(changed(p => { p.data.sicepat.result.track_history[0].date_time = value; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    const unknown = parseSicepat(changed(p => { p.data.sicepat.result.track_history.at(-1).status = 'NEW_ACTION'; }), NUMBER);
    expect(unknown.events![0]).toMatchObject({ provider_code: 'NEW_ACTION' });
    expect(unknown.events![0]!.stage).toBeUndefined();
    expect(parseSicepat(changed(p => { p.data.sicepat.result.track_history.push(p.data.sicepat.result.track_history[0]); }), NUMBER).events).toHaveLength(24);
    expect(sicepatStage('IN', 'Paket telah di input (manifested)')).toBe('accepted');
    expect(sicepatStage('IN', 'Paket telah di terima di Hub')).toBe('in_transit');
    const delivered = parseSicepat(changed(p => { const scan = p.data.sicepat.result.track_history.at(-1); scan.status = 'DLV'; scan.city = 'Paket diterima oleh [Synthetic Recipient]'; }), NUMBER);
    expect(delivered.current_stage).toBe('delivered');
    expect(delivered.events![0]).toMatchObject({ provider_code: 'DLV', description: 'Delivered' });
    expect(JSON.stringify(delivered)).not.toContain('Synthetic Recipient');
  });
});

describe('SiCepat supplied transports and routing', () => {
  it('bootstraps without a number and uses the token once on the whole-number HTTP request', async () => {
    const { tracker, browserFetch, fetcher } = setup();
    expect((await tracker.fetch(NUMBER)).events).toHaveLength(24);
    expect(browserFetch).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(browserFetch.mock.calls[0]![1]!.body));
    expect(request).toMatchObject({ url: PAGE, skipHttp: true, maxTier: 3, captureResponses: [VERIFICATION] });
    expect(JSON.stringify(request)).not.toContain(NUMBER);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(API + NUMBER); expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init!.headers).get('x-recaptcha')).toBe(TOKEN);
    expect(new Headers(init!.headers).get('authorization')).toBeNull();
    expect(new Headers(init!.headers).get('auth')).toBe(new Headers(init!.headers).get('x-api-key'));
  });

  it('requires a fresh tagged app bootstrap and makes no data call on a malformed one', async () => {
    for (const html of ['<html>Website</html>', '{}', envelope('short'), envelope().replace('checkAwb', 'login'), envelope().replace(PAGE, 'https://other.test/')]) {
      const s = setup({ browserHtml: html }); await expect(s.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' }); expect(s.fetcher).not.toHaveBeenCalled();
    }
    const s = setup({ configured: false }); await expect(s.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' }); expect(s.fetcher).not.toHaveBeenCalled(); expect(s.browserFetch).not.toHaveBeenCalled();
  });

  it('keeps HTTP refusal, missing and endpoint failures separate', async () => {
    for (const status of [401, 403]) await expect(setup({ status }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    for (const status of [404, 410, 302]) await expect(setup({ status }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(setup({ status: 400, payload: { code: '400000', statusCode: 400, message: "Invalid AWB number: Can't get waybill from database" } }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(setup({ status: 400 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('preserves caller cancellation before bootstrap and during native HTTP, with no retry', async () => {
    const c = new AbortController(), reason = new Error('caller stopped'); c.abort(reason);
    const first = setup(); expect(() => first.tracker.fetch(NUMBER, { signal: c.signal })).toThrow(reason); expect(first.browserFetch).not.toHaveBeenCalled();
    const live = new AbortController(); const second = setup({ fetcher: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); live.abort(reason);
    }) }); await expect(second.tracker.fetch(NUMBER, { signal: live.signal })).rejects.toBe(reason); expect(second.fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses the registry for explicit selection, bounds named handoffs, and offers no HTTP recognition or broad number rule', async () => {
    const s = setup(); const fetcher: typeof fetch = (url, init) => String(url).startsWith('http://browser.test') ? s.browserFetch(url, init) : s.fetcher(url, init);
    const result = await createTracker({ providers: [], env: {}, trawlUrl: 'http://browser.test', fetcher }).track({ carrier: 'sicepat', number: NUMBER });
    expect(result.source).toBe('sicepat'); expect(result.result.events).toHaveLength(24);
    expect(CARRIER_DEFINITIONS.sicepat.tracking.browser).toBe(true);
    expect(hasDirectHandoffAdapter('sicepat', NUMBER)).toBe(true);
    expect(hasDirectHandoffAdapter('sicepat', 'RR123456785ID')).toBe(false);
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('sicepat');
    expect(recognitionCandidates(NUMBER).map(c => c.carrier)).not.toContain('sicepat');
  });
});

it('places delivery after a departure in the same minute', () => {
  const result = parseSicepat(changed(p => {
    p.data.sicepat.result.track_history = ['ANT', 'DLV'].map(status => ({ status, city: 'Synthetic scan', date_time: '2026-11-10 12:00' }));
  }), NUMBER);
  expect(result.current_stage).toBe('delivered');
  expect(result.last_status_text).toBe('Delivered');
  expect(result.events?.map(event => event.provider_code)).toEqual(['DLV', 'ANT']);
});
