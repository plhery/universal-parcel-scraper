import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { STATUS_MAPS, statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DaraiiTracker } from './adapter.js';
import { DARAII_LOOKUP, normalizeDaraiiNumber, parseDaraii, parseDaraiiReply } from './parser.js';
import { daraiiStatus, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic order of `fixtures/synthetic-delivered.json`.
const NUMBER = 'DAR000000001';
type Row = Record<string, unknown>;
const fixture = (): Row[] => JSON.parse(readFileSync(new URL('./fixtures/synthetic-delivered.json', import.meta.url), 'utf8'));
const changed = (edit: (rows: Row[]) => void) => { const rows = fixture(); edit(rows); return rows; };
const newest = (edit: (row: Row) => void) => changed(rows => edit(rows[3]!));
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Daraii guest adapter', () => {
  it('posts the whole number once, as the page does, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new DaraiiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://www.kynitha.com/getOrder');
    expect(DARAII_LOOKUP).toBe(url);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `orderNo=${NUMBER}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'daraii', step: 'direct', outcome: 'ok' }));
  });

  it('reads the scans newest first, under the status the page gives the order', () => {
    expect(parseDaraii(fixture(), NUMBER)).toEqual({
      status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', provider_code: '2', last_update: '2026-03-09T19:30:00Z', expected_delivery: null,
      delivered_at: '2026-03-09T19:30:00Z', destination_country: 'US',
      events: [
        { time: '2026-03-09T19:30:00Z', description: 'Delivered, in or at mailbox' },
        { time: '2026-03-06T16:05:00Z', description: 'Arrived at the destination country' },
        { time: '2026-03-03T09:40:00Z', description: 'Departed from the origin facility' },
        { time: '2026-03-02T02:10:00Z', description: 'Shipment information received' },
      ] });
  });

  it('reads the order in transit under any other status of its newest scan, whatever the older scans say', () => {
    for (const code of [0, 1, 3, '1', ' 4 ', 12]) {
      const result = parseDaraii(newest(row => { row.status = code; }), NUMBER);
      expect(result).toMatchObject({ status: languageStageStatus('in_transit'), current_stage: 'in_transit', last_status_text: 'In Transit', provider_code: String(code).trim() });
      expect(result.delivered_at).toBeUndefined();
    }
    // Only the newest scan's status counts, wherever it stands in the reply.
    const reordered = changed(rows => { rows.reverse(); rows[0]!.status = 1; });
    expect(parseDaraii(reordered, NUMBER)).toMatchObject({ current_stage: 'in_transit', events: expect.objectContaining({ length: 4 }) });
    expect(parseDaraii(changed(rows => { rows[0]!.status = 1; }), NUMBER)).toMatchObject({ current_stage: 'delivered', provider_code: '2' });
    expect(parseDaraii(newest(row => { row.status = '2'; }), NUMBER)).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-09T19:30:00Z' });
    // Scans on one clock keep the reply's order.
    const tied = parseDaraii(changed(rows => { rows[2]!.trackTime = rows[3]!.trackTime; }), NUMBER);
    expect(tied.events!.slice(0, 2).map(event => event.description)).toEqual(['Arrived at the destination country', 'Delivered, in or at mailbox']);
  });

  it('reads a clock only with the offset written after it', () => {
    const clock = (trackTime: unknown) => parseDaraii(newest(row => { row.trackTime = trackTime; }), NUMBER).events![0]!.time;
    expect(clock('2026-03-10T03:30:00+08:00')).toBe('2026-03-10T03:30:00+08:00');
    expect(clock('2026-03-10 03:30:00 +0800')).toBe('2026-03-10T03:30:00+08:00');
    expect(clock('2026-03-09T19:30:00Z')).toBe('2026-03-09T19:30:00Z');
    expect(clock('2026-03-09T19:30:00.5-0500')).toBe('2026-03-09T19:30:00.500-05:00');
    for (const unread of ['2026-03-09 19:30:00', '2026-03-09T19:30:00', '2026-03-09T25:30:00Z', '2026-03-09', '09/03/2026 19:30:00 +08:00',
      1773084600000, null, '', `2026-03-09T19:30:00Z${' '.repeat(40)}x`]) {
      expect(() => parseDaraii(newest(row => { row.trackTime = unread; }), NUMBER), String(unread)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a message as the page shows it, and the destination by its name or its code', () => {
    const marked = parseDaraii(newest(row => { row.trackMessage = '<b>Delivered</b>&nbsp;to <br/>the front door'; }), NUMBER);
    expect(marked.events![0]!.description).toBe('Delivered to the front door');
    expect(parseDaraii(changed(rows => { for (const row of rows) row.endCountry = 'GB'; }), NUMBER).destination_country).toBe('GB');
    const named = parseDaraii(changed(rows => { for (const row of rows) row.endCountry = '美国'; }), NUMBER);
    expect(named).toMatchObject({ destination_country_name: '美国' });
    expect(named.destination_country).toBeUndefined();
    const none = parseDaraii(changed(rows => { for (const row of rows) delete row.endCountry; }), NUMBER);
    expect(none).not.toHaveProperty('destination_country');
    expect(none).not.toHaveProperty('destination_country_name');
  });

  it('keeps the newest hundred scans of a longer history', () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ ...fixture()[0], trackTime: new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString(), status: 1 }));
    const result = parseDaraii(rows, NUMBER);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update: '2026-03-01T01:59:00Z' });
  });

  it('rejects a scan of another order, and reads the order\'s own in any case and separators', () => {
    for (const own of ['DAR000000002', `${NUMBER}1`, `1${NUMBER}`, '', null, 42, {}, [NUMBER]]) {
      expect(() => parseDaraii(changed(rows => { rows[1]!.trackNo = own; }), NUMBER), String(own)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const own of [NUMBER.toLowerCase(), ' DAR 000000001 ', 'DAR-000000001']) {
      expect(parseDaraii(changed(rows => { for (const row of rows) row.trackNo = own; }), NUMBER).events).toHaveLength(4);
    }
    expect(parseDaraii(changed(rows => { for (const row of rows) row.trackNo = 1234567; }), '1234567').events).toHaveLength(4);
  });

  it('rejects a reply that is not a list of complete scans', () => {
    for (const data of [newest(row => { delete row.trackMessage; }), newest(row => { row.trackMessage = '<br/>'; }), newest(row => { row.trackMessage = 7; }),
      newest(row => { delete row.status; }), newest(row => { row.status = null; }), newest(row => { row.status = 'delivered'; }), newest(row => { row.status = -2; }),
      newest(row => { row.status = 2.5; }), newest(row => { row.status = '1234'; }), changed(rows => { rows.push(null as unknown as Row); }),
      changed(rows => { rows.push('scan' as unknown as Row); }), Array(501).fill(fixture()[0]),
      null, {}, { data: fixture() }, 'scans', 2, [[]]]) {
      expect(() => parseDaraii(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads an empty list as the tracker holding no scan under the number, never as a missing order', () => {
    const empty = readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8');
    expect(() => parseDaraiiReply(200, empty, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseDaraii([], '000000000000')).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
  });

  it('tells a moved service, a verification page and another page apart', () => {
    expect(() => parseDaraiiReply(404, '[]', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseDaraiiReply(404, '<!doctype html><title>404</title>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseDaraiiReply(200, CLOUDFLARE, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDaraiiReply(200, '<!DOCTYPE html><html><head><title>物流轨迹查询</title></head><body></body></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDaraiiReply(200, '', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(parseDaraiiReply(200, JSON.stringify(fixture()), NUMBER).current_stage).toBe('delivered');
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('[]', status, { 'retry-after': '60' }));
    await expect(new DaraiiTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports the empty list and a redirect without reading either as a missing order', async () => {
    const empty = vi.fn<typeof fetch>().mockResolvedValue(response('[]', 200, { 'content-type': 'application/json;charset=UTF-8' }));
    await expect(new DaraiiTracker({ fetcher: empty }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    const moved = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/login' } }));
    await expect(new DaraiiTracker({ fetcher: moved }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a number of no shape the tracker takes before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'DAR1', '-DAR000001', 'DAR 000001', 'DAR/000001', 'DAR000001?', 'D'.repeat(41)]) {
      expect(() => normalizeDaraiiNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(() => new DaraiiTracker({ fetcher }).fetch('DAR1')).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of [NUMBER, 'dar000000001', '12345', 'DAR_0000-1']) expect(normalizeDaraiiNumber(` ${number} `)).toBe(number);
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new DaraiiTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new DaraiiTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()));
    const tracker = createTracker({ fetcher, env: {}, providers: [] });
    const result = await tracker.track({ carrier: 'daraii', number: NUMBER });
    expect(result.source).toBe('daraii');
    expect(result.result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
    expect(result.result.events).toHaveLength(4);
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('daraii');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('daraii');
    const registered = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    expect(registered).toMatchObject({ id: 'daraii', steps: ['direct'] });
  });

  it('maps the two statuses of the page and registers its map', () => {
    expect(STATUS_MAPS.daraii).toBe(statusMap);
    expect(daraiiStatus('2')).toEqual({ wording: 'Delivered', stage: 'delivered' });
    for (const code of ['0', '1', '3', '99']) expect(daraiiStatus(code)).toEqual({ wording: 'In Transit', stage: 'in_transit' });
    for (const code of [null, '', 'A', '2.0', '1234']) expect(daraiiStatus(code)).toBeUndefined();
    for (const entry of statuses.entries) {
      // The page's label for any status but 2 stands for all of them; 1 is one.
      const code = 'code' in entry && entry.code ? entry.code : '1';
      expect(daraiiStatus(code)).toEqual({ wording: entry.wording, stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'daraii', providerCode: '2', description: 'Delivered' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'daraii', providerCode: '0', description: 'In Transit' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
  });
});
