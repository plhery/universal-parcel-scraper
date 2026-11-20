import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { BypostTracker } from './adapter.js';
import { BYPOST_ENDPOINT, bypostJson, normalizeBypostNumber, parseBypost } from './parser.js';
import { bypostCode, statusMap } from './status.js';

const NUMBER = 'BYP000000001';
const PACKAGE = 'BYPKOLLI0000001';
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const fixture = () => read('shipment');
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code: string; wording: string; stage?: string }[] };
const scan = (code: string, at: string, city = 'Synthetic By') => ({ code, label: null, description: null, occurred_at: at, city });

describe('Bypost guest adapter', () => {
  it('asks the tracking service once for the whole number, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new BypostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${BYPOST_ENDPOINT}?number=${NUMBER}`);
    expect(String(url)).not.toContain('recipient_phone');
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(init!.method).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bypost', step: 'direct', outcome: 'ok' }));
  });

  it('reads a package\'s events newest first with their offsets, towns, wording and detail', () => {
    const result = parseBypost(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map', last_status_text: 'Klar for henting',
      last_update: '2026-03-03T11:05:00Z', expected_delivery: null, destination_country: 'NO', weight_kg: 2.4, pickup_point: 'Synthetic Hentested',
      receiver_address: '0002 Synthetic Destination' });
    expect(result.delivered_at).toBeUndefined();
    // The signatory is kept only for a delivery.
    expect(result.signed_by).toBeUndefined();
    expect(result.summary_only).toBeUndefined();
    expect(result.events).toEqual([
      { time: '2026-03-03T11:05:00Z', description: 'Klar for henting', provider_code: 'READY_FOR_PICKUP', location: 'Synthetic By C', stage: 'ready_for_pickup', stage_source: 'carrier_map' },
      { time: '2026-03-03T06:00:00+01:00', description: 'Mulig forsinkelse: Ny leveringsdag se her', provider_code: 'DELAYED' },
      { time: '2026-03-02T17:40:00+01:00', description: 'Ankommet terminal', provider_code: 'AT_TERMINAL', location: 'Synthetic By B', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-02T08:15:00+01:00', description: 'Levert til transportør', provider_code: 'HANDED_IN', location: 'Synthetic By A', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example\.invalid|dimensions|length_cm|signature/);
  });

  it('reads the same package by its own number, and one package of several', () => {
    expect(parseBypost(fixture(), PACKAGE).events).toHaveLength(4);
    const several = changed(d => {
      d.packages.push({ number: 'BYPKOLLI0000002', status: 'DELIVERED', weight_kg: 1.1, events: [scan('DELIVERED', '2026-03-03T09:00:00+01:00')] });
    });
    const one = parseBypost(several, 'BYPKOLLI0000002');
    expect(one).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-03T09:00:00+01:00', weight_kg: 1.1 });
    expect(one.events).toHaveLength(1);
    expect(one.pickup_point).toBeUndefined();
  });

  it('holds a shipment of several packages at its least advanced one until all are delivered', () => {
    const partly = changed(d => {
      d.packages.push({ number: 'BYPKOLLI0000002', status: 'DELIVERED', weight_kg: 1.1, events: [scan('DELIVERED', '2026-03-04T09:00:00+01:00')] });
    });
    const waiting = parseBypost(partly, NUMBER);
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', weight_kg: 3.5, last_status_text: 'Klar for henting' });
    expect(waiting.delivered_at).toBeUndefined();
    expect(waiting.pickup_point).toBeUndefined();
    expect(waiting.events).toHaveLength(5);
    const done = changed(d => {
      d.status = 'DELIVERED';
      d.packages[0].events.push(scan('DELIVERED', '2026-03-04T08:00:00+01:00'));
      d.packages.push({ number: 'BYPKOLLI0000002', status: 'DELIVERED', events: [scan('DELIVERED', '2026-03-04T09:00:00+01:00')] });
    });
    const delivered = parseBypost(done, NUMBER);
    expect(delivered).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-04T09:00:00+01:00' });
    expect(delivered.weight_kg).toBeUndefined();
    expect(delivered.signed_by).toBeUndefined();
    // Who signed for the newest delivery, else the single package's signature.
    const signed = changed(d => {
      d.status = 'DELIVERED';
      d.packages[0].events.push({ ...scan('DELIVERED', '2026-03-04T08:00:00+01:00'), signature: 'Synthetic Signer' });
    });
    expect(parseBypost(signed, NUMBER)).toMatchObject({ current_stage: 'delivered', signed_by: 'Synthetic Signer' });
    const detailed = changed(d => {
      d.status = 'DELIVERED';
      d.packages[0].events.push(scan('DELIVERED', '2026-03-04T08:00:00+01:00'));
      d.packages[0].detail.signature_name = 'Synthetic Detail Signer';
    });
    expect(parseBypost(detailed, NUMBER)).toMatchObject({ signed_by: 'Synthetic Detail Signer' });
  });

  it('keeps a package on its way back open and closes it once returned', () => {
    const back = (code: string) => parseBypost(changed(d => { d.packages[0].events.push(scan(code, '2026-03-05T09:00:00+01:00')); }), NUMBER);
    expect(back('RETURNING_TO_SENDER')).toMatchObject({ current_stage: 'exception', last_status_text: 'På vei tilbake til avsender' });
    expect(back('RETURNED_TO_SENDER')).toMatchObject({ current_stage: 'returned' });
  });

  it('reads a registered shipment without scans as a summary, and a cancelled one or one with an exception as stopped', () => {
    const registered = changed(d => { d.status = 'PREPARING'; d.packages[0].events = []; delete d.packages[0].detail; });
    expect(parseBypost(registered, NUMBER)).toEqual({ status: expect.any(String), current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Sendingen er registrert og gjøres klar for transport.', last_update: null, expected_delivery: null,
      destination_country: 'NO', weight_kg: 2.4, receiver_address: '0002 Synthetic Destination', summary_only: true, events: [] });
    const cancelled = parseBypost(changed(d => { d.status = 'CANCELLED'; }), NUMBER);
    expect(cancelled).toMatchObject({ current_stage: 'exception', last_status_text: 'Sendingen er kansellert.' });
    expect(cancelled.events).toHaveLength(4);
    // No event states an exception ("Avvik"), so the shipment's stands over its scans, unless they end in a delivery.
    const exception = parseBypost(changed(d => { d.status = 'EXCEPTION'; d.packages[0].status = 'EXCEPTION'; delete d.packages[0].detail; }), NUMBER);
    expect(exception).toMatchObject({ current_stage: 'exception', last_status_text: 'Det er et avvik på sendingen. Ta kontakt om du lurer på noe.' });
    expect(exception.events).toHaveLength(4);
    expect(parseBypost(changed(d => { d.status = 'EXCEPTION'; d.packages[0].events = []; delete d.packages[0].detail; }), NUMBER))
      .toMatchObject({ current_stage: 'exception', last_status_text: 'Det er et avvik på sendingen. Ta kontakt om du lurer på noe.', summary_only: true });
    const delivered = parseBypost(changed(d => { d.status = 'EXCEPTION'; d.packages[0].events.push(scan('DELIVERED', '2026-03-04T09:00:00+01:00')); }), NUMBER);
    expect(delivered).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-03-04T09:00:00+01:00', last_status_text: 'Levert' });
    expect(() => parseBypost(changed(d => { d.status = null; d.packages[0].events = []; delete d.packages[0].detail; }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a code the page does not list, without a stage', () => {
    const data = changed(d => { d.packages[0].events = [scan('SYNTHETIC_NEW_CODE', '2026-03-02T09:15:00+01:00')]; d.status = 'SYNTHETIC_STATUS'; });
    const result = parseBypost(data, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'synthetic new code' });
    expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toEqual({ time: '2026-03-02T09:15:00+01:00', description: 'synthetic new code', provider_code: 'SYNTHETIC_NEW_CODE', location: 'Synthetic By' });
  });

  it('reports the service\'s empty answer as not found', () => {
    expect(() => parseBypost(read('unknown'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBypost({ number: NUMBER, source: 'bypost', status: null, packages: [] }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBypost(changed(d => { d.source = 'none'; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
  });

  it('rejects a shipment that does not name the requested number', () => {
    for (const data of [changed(d => { d.number = 'BYP000000002'; }), changed(d => { delete d.number; }), changed(d => { d.number = `${NUMBER}1`; })]) {
      expect(() => parseBypost(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseBypost(changed(d => { d.number = ' byp 000000001 '; }), NUMBER).events).toHaveLength(4);
  });

  it('rejects a clock without an offset, a malformed event and an invalid shipment', () => {
    for (const data of [changed(d => { d.packages[0].events[0].occurred_at = '2026-03-02T08:15:00'; }),
      changed(d => { d.packages[0].events[0].occurred_at = null; }),
      changed(d => { d.packages[0].events[0].occurred_at = '2026-02-31T08:15:00+01:00'; }),
      changed(d => { d.packages[0].events[0] = { occurred_at: '2026-03-02T08:15:00+01:00' }; }),
      changed(d => { d.packages[0].events[0] = null; }), changed(d => { d.packages[0].events = {}; }),
      changed(d => { delete d.packages[0].events; }), changed(d => { d.packages[0].events = Array(501).fill(d.packages[0].events[0]); }),
      changed(d => { d.packages = [null]; }), changed(d => { delete d.packages; }), changed(d => { d.status = 7; }),
      changed(d => { delete d.source; }), null, [], 'shipment']) {
      expect(() => parseBypost(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => bypostJson('<!doctype html><title>Bypost</title>')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => bypostJson('<html><head><title>Just a moment...</title></head></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('maps every listed code to its stage and leaves the notices without', () => {
    expect(statuses.entries).toHaveLength(18);
    for (const entry of statuses.entries) {
      expect(bypostCode(entry.code)).toEqual({ wording: entry.wording, ...(entry.stage ? { stage: entry.stage } : {}) });
      expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
      if (entry.stage) expect(STAGES).toContain(entry.stage);
    }
    expect(statuses.entries.filter(entry => !entry.stage).map(entry => entry.code)).toEqual(statusMap.gaps.map(gap => gap.code));
    expect(statusMap.stage(null, 'Levert')).toBeUndefined();
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status, { 'retry-after': '60' }));
    await expect(new BypostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new BypostTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new BypostTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const result = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'bypost', number: NUMBER });
    expect(result.source).toBe('bypost');
    expect(result.result.events).toHaveLength(4);
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('bypost');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('bypost');
    for (const number of ['', 'ABCDE', 'ABC-12345', 'ABC/12345', 'A'.repeat(41)]) expect(() => normalizeBypostNumber(number)).toThrow();
    for (const number of ['ABC123', '70 7000 0000 0000 019']) expect(normalizeBypostNumber(` ${number} `)).toBe(number.replace(/ /g, ''));
  });
});
