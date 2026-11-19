import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { ApdTracker } from './adapter.js';
import { apdItem, normalizeApdNumber, parseApdPage, parseApdTracking } from './parser.js';
import { apdStage, statusMap } from './status.js';

// TrackShip's APD example, and the tracker's reply to it.
const NUMBER = 'R4864731P';
const fixture = (name = 'tracking') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
type Row = { '@attributes': Record<string, string> };
const changed = (edit: (query: { '@attributes': Record<string, string>; track: Row[] }) => void) => { const data = fixture(); edit(data.query); return data; };
// The tracker's page around its tracking data, as it renders it.
const page = (data: unknown) => `<html><body><h1>Tracking</h1>\n<script type="text/javascript">\nvar  trackingData = ${JSON.stringify(data)};\naddLoadEvent(function() {displaySimplifiedTrackingData('trackingAnchor', null);});\n</script>\n</body></html>`;
const response = (body: string, status = 200, headers: HeadersInit = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8', ...headers } });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code: string; stage: string }[] };
// One more scan on top of the fixture's, after its newest.
const then = (action: string, extra: Record<string, string> = {}) => changed(query => {
  query.track.push({ '@attributes': { item: 'R4864731', action, actionDescription: `Synthetic ${action}`, count: '1', stamp: '20250424090000', ...extra } });
});

describe('APD guest adapter', () => {
  it('posts the page\'s form once with the whole label, the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page(fixture())));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new ApdTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(' r4864731p ', { budgetMs: 4000 });
    expect(result.events).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://online.apdparcel.com.au/track');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1' } });
    expect(String(init!.body)).toBe('fn=goto&page=tracking%2Fbrief&label=R4864731P');
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'apd-parcel', step: 'direct', outcome: 'ok' }));
  });

  it('reads the public reply newest first on Adelaide\'s clock, without drivers, coordinates or the signature image', () => {
    const result = parseApdTracking(fixture(), NUMBER);
    expect(result).toEqual({ status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2025-04-23T16:09:28+09:30', last_update_local: '2025-04-23T16:09:28', expected_delivery: null,
      delivered_at: '2025-04-23T16:09:28+09:30', signed_by: 'Received',
      events: [
        { local_time: '2025-04-23T16:09:28', time: '2025-04-23T16:09:28+09:30', time_zone: 'Australia/Adelaide', time_zone_basis: 'carrier', description: 'Delivered', provider_code: 'deliver', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2025-04-23T12:20:34', time: '2025-04-23T12:20:34+09:30', time_zone: 'Australia/Adelaide', time_zone_basis: 'carrier', description: 'Loaded for Delivery', provider_code: 'accept', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2025-04-23T12:04:58', time: '2025-04-23T12:04:58+09:30', time_zone: 'Australia/Adelaide', time_zone_basis: 'carrier', description: 'Arrived In Depot', provider_code: 'indepot', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-04-23T11:18:20', time: '2025-04-23T11:18:20+09:30', time_zone: 'Australia/Adelaide', time_zone_basis: 'carrier', description: 'Picked Up', provider_code: 'pickup', stage: 'accepted', stage_source: 'carrier_map' },
      ] });
    const text = JSON.stringify(result);
    for (const left of ['PATEL', 'ARORA', '138.63', '-34.81', 'iVBOR', '15157080']) expect(text).not.toContain(left);
    // Summer scans read on Adelaide's daylight saving clock.
    const summer = parseApdTracking(changed(query => { for (const row of query.track) row['@attributes'].stamp = row['@attributes'].stamp!.replace(/^202504/, '202501'); }), NUMBER);
    expect(summer.events!.at(-1)!.time).toBe('2025-01-23T11:18:20+10:30');
  });

  it('binds the reply to the label without its check letter, and a label given without it', () => {
    expect(apdItem(NUMBER)).toBe('R4864731');
    expect(parseApdTracking(fixture(), 'R4864731').events).toHaveLength(4);
    for (const own of ['R4864732', 'R4864731P', '4864731', '', undefined]) {
      expect(() => parseApdTracking(changed(query => { query['@attributes'].item = own as string; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
      expect(() => parseApdTracking(changed(query => { query.track[2]!['@attributes'].item = own as string; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads one scan given as an object, orders scans by clock and keeps equal clocks in the tracker\'s order', () => {
    const single = parseApdTracking(changed(query => { (query as { track: unknown }).track = query.track[0]; }), NUMBER);
    expect(single).toMatchObject({ current_stage: 'accepted', last_status_text: 'Picked Up', events: [expect.objectContaining({ provider_code: 'pickup' })] });
    expect(parseApdTracking(changed(query => { query.track.reverse(); }), NUMBER).events!.map(event => event.provider_code)).toEqual(['deliver', 'accept', 'indepot', 'pickup']);
    const tied = parseApdTracking(changed(query => { query.track[2]!['@attributes'].stamp = '20250423120458'; }), NUMBER);
    expect(tied.events!.slice(1).map(event => event.provider_code)).toEqual(['accept', 'indepot', 'pickup']);
  });

  it('names an attempt and a transshipment, and keeps an action the page does not name without a stage', () => {
    const open = (data: ReturnType<typeof fixture>) => { data.query.track.splice(3, 1); return data; };
    const failed = open(then('failed', { comment: 'Card left' }));
    expect(parseApdTracking(failed, NUMBER)).toMatchObject({ status: languageStageStatus('failed_attempt'), current_stage: 'failed_attempt',
      last_status_text: 'Attempted Delivery', last_update: '2025-04-24T09:00:00+09:30' });
    expect(parseApdTracking(failed, NUMBER).delivered_at).toBeUndefined();
    expect(parseApdTracking(open(then('carriermanifest')), NUMBER)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Transshipped' });
    const unnamed = parseApdTracking(then('hold'), NUMBER);
    expect(unnamed.events![0]).toEqual({ local_time: '2025-04-24T09:00:00', time: '2025-04-24T09:00:00+09:30', time_zone: 'Australia/Adelaide', time_zone_basis: 'carrier',
      description: 'Synthetic hold', provider_code: 'hold' });
    // A newer action without a stage may have undone the delivery.
    expect(parseApdTracking(then('hold'), NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic hold' });
    expect(parseApdTracking(then('hold'), NUMBER).delivered_at).toBeUndefined();
    const long = changed(query => { query.track = Array.from({ length: 120 }, (_, index) => ({ '@attributes': { item: 'R4864731', action: 'indepot', stamp: `20250423${10 + Math.floor(index / 60)}${String(index % 60).padStart(2, '0')}00` } })); });
    expect(parseApdTracking(long, NUMBER)).toMatchObject({ history_truncated: true, events: expect.objectContaining({ length: 100 }) });
  });

  it('rejects a scan without an action or a readable clock, and a malformed reply', () => {
    for (const data of [changed(query => { query.track[0]!['@attributes'].stamp = '2025-04-23 11:18:20'; }), changed(query => { query.track[0]!['@attributes'].stamp = '20250231111820'; }),
      changed(query => { query.track[0]!['@attributes'].stamp = '20250423241820'; }), changed(query => { delete query.track[0]!['@attributes'].stamp; }),
      changed(query => { delete query.track[0]!['@attributes'].action; }), changed(query => { (query.track as unknown[])[0] = null; }),
      changed(query => { (query.track as unknown) = 'scan'; }), changed(query => { query['@attributes'].status = 'pending'; }),
      changed(query => { query['@attributes'].style = 'job'; }), changed(query => { query.track = Array(501).fill(query.track[0]); }),
      { query: [fixture().query, fixture().query] }, { query: {} }, null, [], 'trackingData']) {
      expect(() => parseApdTracking(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseApdTracking(changed(query => { query.track = []; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('tells an unknown label from a failed read, a page and a verification page', () => {
    // The tracker's reply to a synthetic label: the item without its check letter, or the key as given when the letter is wrong.
    expect(() => parseApdTracking(fixture('unknown'), 'R0000000P')).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const unknown = (item: string, reason = 'no history found') => ({ query: { '@attributes': { item, status: 'failed', style: 'item', count: '0', reason } } });
    expect(() => parseApdTracking(unknown('R4864731Q'), 'R4864731Q')).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseApdTracking(unknown('R4864732'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseApdTracking(unknown('R4864731', 'database unavailable'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseApdPage(page(fixture('unknown')), 'R0000000P')).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseApdPage('<html><h1>Enter Login Information</h1></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseApdPage('<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseApdPage('<script>\nvar trackingData = {"query":;\n</script>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(parseApdPage(page(fixture()), NUMBER).last_status_text).toBe('Delivered');
  });

  it('stages each action the page\'s script names', () => {
    expect(statuses.entries).toHaveLength(6);
    for (const entry of statuses.entries) {
      expect(STAGES).toContain(entry.stage);
      expect(statusMap.stage(entry.code, '')).toBe(entry.stage);
    }
    expect(apdStage('hold')).toBeUndefined();
    expect(apdStage(null)).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [404, 'transport'], [302, 'transport']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status, { 'retry-after': '60', ...(status === 302 ? { location: 'https://example.test/' } : {}) }));
    await expect(new ApdTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports an unknown label as not found without another request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page(fixture('unknown'))));
    await expect(new ApdTracker({ fetcher }).fetch('R0000000P')).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    await expect(new ApdTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new ApdTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('takes only R labels and offers no number rule', () => {
    for (const number of ['', 'R486473', 'R48647311P', 'R4864731PP', '4864731P', 'X4864731P', 'R4864731-P', 'R486473IP']) expect(() => normalizeApdNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    for (const number of [NUMBER, 'R4864731', 'R 486 4731 P']) expect(normalizeApdNumber(number)).toBe(number.replace(/\s/g, ''));
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('apd-parcel');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('apd-parcel');
  });
});
