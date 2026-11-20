import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { QtExpressTracker } from './adapter.js';
import { normalizeQtNumber, parseQt, parseQtReply, qtExpressUrl } from './parser.js';
import { qtFailureReason, qtStatus, statusMap } from './status.js';

const NUMBER = 'QTX0000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code: string; wording: string; stage: string; language: 'en' | 'hu' }[] };
const MISSING = { error: 'not found' };
// One more event on top of the fixture's, an hour after its newest.
const then = (title: string, more: Record<string, unknown> = {}) => changed(d => {
  d.events.unshift({ title, description: '', date: '2026-03-04T08:30:00+01:00', failureReasonCode: null, ...more });
});

describe('QT Express guest adapter', () => {
  it('asks for the whole number once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new QtExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://tracking.qtlogistics.eu/api/v1/trackings/${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(init!.method).toBeUndefined();
    expect(init!.body).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'qt-express', step: 'direct', outcome: 'ok' }));
    expect(qtExpressUrl('QTX_0000-1')).toBe('https://tracking.qtlogistics.eu/api/v1/trackings/QTX_0000-1');
  });

  it('reads the events newest first with the page\'s wording for each status', () => {
    expect(parseQt(fixture(), NUMBER)).toEqual({ status: languageStageStatus('out_for_delivery'), current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Last mile delivery processing', last_update: '2026-03-04T07:30:00+01:00', expected_delivery: null,
      events: [
        { time: '2026-03-04T07:30:00+01:00', description: 'Last mile delivery processing', provider_code: 'LAST MILE DELIVERY PROCESSING', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-03-03T18:20:00+01:00', description: 'Arrived to final depot', provider_code: 'ARRIVED TO FINAL DEPOT', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-03T09:10:00Z', description: 'Transfer to final depot', provider_code: 'TRANSFER TO FINAL DEPOT', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-02T15:05:00Z', description: 'Arrived to regional depot', provider_code: 'ARRIVED TO REGIONAL DEPOT', stage: 'in_transit', stage_source: 'carrier_map' },
      ] });
    const magyar = parseQt(fixture(), NUMBER, 'hu');
    expect(magyar.last_status_text).toBe('Kézbesítés folyamatban');
    expect(magyar.events!.map(event => event.description)).toEqual(['Kézbesítés folyamatban', 'Megérkezett a kiszállító raktárba', 'Átszállítva a kiszállító raktárba', 'Megérkezett a regionális raktárba']);
    // The service's own description of a step is not read.
    const noted = parseQt(changed(d => { for (const event of d.events) event.description = 'PRIVATE NOTE'; }), NUMBER);
    expect(JSON.stringify(noted)).not.toContain('PRIVATE');
    // A status reads the same in any case, and without a description or a reason code.
    expect(parseQt(changed(d => { d.events[0] = { title: 'LAST MILE DELIVERY PROCESSING', date: '2026-03-04T07:30:00+01:00' }; }), NUMBER).events![0]!.stage).toBe('out_for_delivery');
  });

  it('orders the events by their clocks, and equal clocks as the service lists them', () => {
    const shuffled = parseQt(changed(d => { d.events.reverse(); }), NUMBER);
    expect(shuffled.events!.map(event => event.provider_code)).toEqual(['LAST MILE DELIVERY PROCESSING', 'ARRIVED TO FINAL DEPOT', 'TRANSFER TO FINAL DEPOT', 'ARRIVED TO REGIONAL DEPOT']);
    const tied = parseQt(changed(d => { d.events[1].date = d.events[0].date; }), NUMBER);
    expect(tied.events!.slice(0, 2).map(event => event.provider_code)).toEqual(['LAST MILE DELIVERY PROCESSING', 'ARRIVED TO FINAL DEPOT']);
    expect(tied.current_stage).toBe('out_for_delivery');
  });

  it('words a failed delivery with its reason, by the code or the service\'s text', () => {
    const failed = (description: string, failureReasonCode: unknown = null, language: 'en' | 'hu' = 'en') =>
      parseQt(then('Delivery failed', { description, failureReasonCode }), NUMBER, language);
    expect(failed('delivery failed - Customer is not available', 'CUSTOMER_IS_NOT_AVAILABLE')).toMatchObject({
      status: languageStageStatus('failed_attempt'), current_stage: 'failed_attempt', last_status_text: 'Delivery failed – Customer is not available', last_update: '2026-03-04T08:30:00+01:00' });
    expect(failed('delivery failed - Customer is not available', 'CUSTOMER_IS_NOT_AVAILABLE', 'hu').last_status_text).toBe('Sikertelen kézbesítés – Az ügyfél nem elérhető');
    // The code decides over the text; the text stands in for a missing or unknown code.
    expect(failed('delivery failed - Customer is not available', 'INCORRECT_PHONE_NUMBER').last_status_text).toBe('Delivery failed – Incorrect Phone Number');
    expect(failed('Delivery Failed - Force Majeure', null, 'hu').last_status_text).toBe('Sikertelen kézbesítés – Vis maior');
    expect(failed('delivery failed - Delivery postponed', 'SYNTHETIC_NEW', 'hu').last_status_text).toBe('Sikertelen kézbesítés – Kézbesítés elhalasztva');
    expect(failed('delivery failed', 'DAMAGE').last_status_text).toBe('Delivery failed – Damaged');
    // A reason the script does not list is kept as written; a typed one and an empty one are left out.
    expect(failed('delivery failed - Synthetic new reason', null, 'hu').last_status_text).toBe('Sikertelen kézbesítés – Synthetic new reason');
    expect(failed('delivery failed - PRIVATE TEXT', 'WRITE_SOMETHING_ELSE').last_status_text).toBe('Delivery failed');
    expect(failed('delivery failed - Write something else...', null, 'hu').last_status_text).toBe('Sikertelen kézbesítés');
    for (const empty of ['delivery failed', 'delivery failed - undefined', 'delivery failed - null', 'delivery failed - N/A', 'delivery failed - -', '', 'PRIVATE NOTE']) {
      expect(failed(empty).last_status_text).toBe('Delivery failed');
    }
    // A reason belongs to a failed delivery only.
    expect(parseQt(then('Lost', { description: 'delivery failed - Lost', failureReasonCode: 'LOST' }), NUMBER).last_status_text).toBe('Lost');
    expect(qtFailureReason(42, 'Synthetic', 'en')).toBe('Synthetic');
  });

  it('dates a delivery by its event and reads the closing statuses', () => {
    const delivered = parseQt(then('Delivered'), NUMBER, 'hu');
    expect(delivered).toMatchObject({ status: languageStageStatus('delivered'), current_stage: 'delivered', last_status_text: 'Kézbesítve',
      last_update: '2026-03-04T08:30:00+01:00', delivered_at: '2026-03-04T08:30:00+01:00' });
    expect(delivered.events).toHaveLength(5);
    for (const [title, stage] of [['Waiting for customer pickup', 'ready_for_pickup'], ['Returned to depot', 'exception'], ['Returned to sender', 'returned'],
      ['Damaged', 'exception'], ['Lost', 'exception'], ['Destroyed in transport', 'exception'], ['Cancelled', 'exception']] as const) {
      const result = parseQt(then(title), NUMBER);
      expect(result).toMatchObject({ status: languageStageStatus(stage), current_stage: stage, last_status_text: title });
      expect(result.delivered_at).toBeUndefined();
    }
    // A delivery followed by a return is no longer one.
    const back = parseQt(changed(d => { d.events.unshift({ title: 'Returned to sender', date: '2026-03-05T08:30:00+01:00' }, { title: 'Delivered', date: '2026-03-04T08:30:00+01:00' }); }), NUMBER);
    expect(back.current_stage).toBe('returned');
    expect(back.delivered_at).toBeUndefined();
  });

  it('keeps a status the script does not list, without a stage, as the page keeps to the steps it knows', () => {
    const result = parseQt(then('Synthetic new step'), NUMBER, 'hu');
    expect(result.events![0]).toEqual({ time: '2026-03-04T08:30:00+01:00', description: 'Synthetic new step', provider_code: 'SYNTHETIC NEW STEP' });
    expect(result).toMatchObject({ status: languageStageStatus('out_for_delivery'), current_stage: 'out_for_delivery', last_status_text: 'Synthetic new step' });
    const alone = parseQt({ trackingNumber: NUMBER, events: [{ title: 'Synthetic new step', date: '2026-03-04T08:30:00Z' }] }, NUMBER);
    expect(alone).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic new step', events: expect.objectContaining({ length: 1 }) });
    expect(alone.current_stage).toBeUndefined();
    // A delivery under a newer status the script does not list may have been undone, so the parcel takes no stage from it.
    const undone = parseQt(changed(d => { d.events.unshift({ title: 'Synthetic new step', date: '2026-03-05T08:30:00+01:00' }, { title: 'Delivered', date: '2026-03-04T08:30:00+01:00' }); }), NUMBER);
    expect(undone).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic new step' });
    expect(undone.current_stage).toBeUndefined();
    expect(undone.delivered_at).toBeUndefined();
    const long = changed(d => { d.events = Array.from({ length: 120 }, (_, index) => ({ title: 'Arrived to final depot', date: `2026-03-02T${String(index % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z` })); });
    expect(parseQt(long, NUMBER)).toMatchObject({ history_truncated: true, events: expect.objectContaining({ length: 100 }) });
  });

  it('rejects a reply that names another parcel', () => {
    for (const own of ['QTX0000000002', `${NUMBER}1`, `1${NUMBER}`, '', null, undefined, {}, [NUMBER]]) {
      expect(() => parseQt(changed(d => { d.trackingNumber = own; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const own of [NUMBER, NUMBER.toLowerCase(), ' qtx 0000000001 ', 'QTX-0000000001']) expect(parseQt(changed(d => { d.trackingNumber = own; }), NUMBER).events).toHaveLength(4);
    expect(parseQt(changed(d => { d.trackingNumber = 1234567890; }), '1234567890').events).toHaveLength(4);
  });

  it('rejects an event without a status or a clock with an offset, and a malformed list', () => {
    for (const data of [changed(d => { d.events[0].date = '2026-03-04T07:30:00'; }), changed(d => { d.events[0].date = '2026-03-04'; }),
      changed(d => { d.events[0].date = '2026-02-31T07:30:00+01:00'; }), changed(d => { d.events[0].date = 1772605800000; }), changed(d => { delete d.events[0].date; }),
      changed(d => { delete d.events[0].title; }), changed(d => { d.events[0].title = ''; }), changed(d => { d.events[0].title = 42; }), changed(d => { d.events[0].title = 'Step #2'; }),
      changed(d => { d.events[0].title = 'A'.repeat(65); }), changed(d => { d.events[3] = null; }), changed(d => { d.events[3] = 'Delivered'; }),
      changed(d => { d.events = {}; }), changed(d => { delete d.events; }), changed(d => { d.events = Array(501).fill(d.events[0]); }),
      null, [], [fixture()], 'parcel', MISSING, { data: fixture() }]) {
      expect(() => parseQt(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('tells a missing parcel from a moved service, a refusal and a page', () => {
    expect(() => parseQtReply(404, JSON.stringify(MISSING), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    // The page shows its "not found" for a parcel without a step.
    expect(() => parseQtReply(200, JSON.stringify({ trackingNumber: NUMBER, events: [] }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseQtReply(200, JSON.stringify({ trackingNumber: 'QTX0000000002', events: [] }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQtReply(404, '{"error":"Not Found"}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseQtReply(404, '{}', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseQtReply(200, JSON.stringify(MISSING), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const status of [200, 404]) {
      expect(() => parseQtReply(status, '<!doctype html><html><head><title>QT Tracking</title></head><body></body></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
      expect(() => parseQtReply(status, '<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(parseQtReply(200, JSON.stringify(fixture()), NUMBER, 'hu').last_status_text).toBe('Kézbesítés folyamatban');
  });

  it('maps every status of the script to its stage, in both languages', () => {
    expect(statuses.entries).toHaveLength(26);
    for (const entry of statuses.entries) {
      const known = qtStatus(entry.code)!;
      expect(known[entry.language]).toBe(entry.wording);
      expect(known.stage).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
      expect(STAGES).toContain(entry.stage);
    }
    expect(new Set(statuses.entries.map(entry => entry.code)).size).toBe(13);
    expect(qtStatus('Delivered')).toBeUndefined();
    expect(statusMap.stage(null, 'Delivered')).toBeUndefined();
    expect(statusMap.stage('SYNTHETIC NEW', 'Delivered')).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status, { 'retry-after': '60' }));
    await expect(new QtExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports the service\'s own missing-parcel reply as not found, and a page as a changed service', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(response(MISSING, 404));
    await expect(new QtExpressTracker({ fetcher: missing }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(missing).toHaveBeenCalledOnce();
    const page = vi.fn<typeof fetch>().mockResolvedValue(response('<!doctype html><title>QT Tracking</title>', 200, { 'content-type': 'text/html' }));
    await expect(new QtExpressTracker({ fetcher: page }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new QtExpressTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new QtExpressTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection in the reader\'s language and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()));
    const tracker = createTracker({ fetcher, env: {}, providers: [] });
    const result = await tracker.track({ carrier: 'qt-express', number: NUMBER });
    expect(result.source).toBe('qt-express');
    expect(result.result.events).toHaveLength(4);
    expect((await tracker.track({ carrier: 'qt-express', number: NUMBER, language: 'hu-HU' })).result.last_status_text).toBe('Kézbesítés folyamatban');
    expect((await tracker.track({ carrier: 'qt-express', number: NUMBER, language: 'de' })).result.last_status_text).toBe('Last mile delivery processing');
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('qt-express');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('qt-express');
    for (const number of ['', 'QT1', '-QTX000001', 'QTX 000001', 'QTX/000001', 'QTX000001?', 'Q'.repeat(41)]) expect(() => normalizeQtNumber(number)).toThrow();
    for (const number of [NUMBER, 'qtx0000000001', '1234567890', 'QTX_0000-1']) expect(normalizeQtNumber(` ${number} `)).toBe(number);
  });
});
