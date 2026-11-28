import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { navigatorEndpoint } from './courier-navigator.js';
import { normalizeUbxUkNumber, parseUbxUk, UBX_UK } from './parser.js';
import { navigatorCode, navigatorStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'UBX0000000001';
const fixture = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
type Payload = ReturnType<typeof fixture>;
const changed = (edit: (data: Payload) => void, name?: string) => { const data = fixture(name); edit(data); return data; };
const script = (data: unknown) => `trackingdownload(${JSON.stringify(data)});`;
const parse = (data: unknown) => parseUbxUk(script(data), NUMBER);
const response = (body: string, status = 200, headers: HeadersInit = { 'Content-Type': 'text' }) => new Response(body, { status, headers });
const carrier = (fetcher: typeof fetch, recorder = NOOP_RECORDER) => adapter({ fetcher, recorder, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'SyntheticHost/1' });
const missing = { jobs: [], GmapKey: null, request: { consign_note: NUMBER } };

describe('Courier Navigator tracking search', () => {
  it('posts the number as the page does, once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(script(fixture())));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await carrier(fetcher, recorder).track({ number: ' ubx-0000 000001 ' }, { budgetMs: 4000 });
    expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://ubx.couriernavigator-secure.com/json/search/trackingdownload');
    expect(navigatorEndpoint(UBX_UK)).toBe(url);
    expect(init).toMatchObject({ method: 'POST', body: `consign_note=${NUMBER}`, signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ubx-uk', step: 'direct', outcome: 'ok' }));
  });

  it('reads the timeline newest first on wall clocks, and keeps a delivery under a later step', () => {
    const result = parse(fixture());
    expect(result).toMatchObject({ status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Synthetic step after delivery', provider_code: '25', last_update: null, last_update_local: '2026-03-03T18:00:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.provider_code, event.stage])).toEqual([['25', undefined], ['20', 'delivered'],
      ['16', 'out_for_delivery'], ['14', 'in_transit'], ['11', 'accepted'], ['1', 'registered']]);
    expect(result.events![1]).toEqual({ local_time: '2026-03-03T11:20:00', description: 'Synthetic delivery', provider_code: '20',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events![2]!.stage_source).toMatch(/^wording:/);
    expect(result.unread_estimates).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|time_stamp|statusid/);
  });

  it('names the network a job is handed to, by its link and the reference it gives', () => {
    const result = parse(fixture('handed-off'));
    expect(result).toMatchObject({ current_stage: 'in_transit', delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784',
      unread_estimates: ['addresses.address.openETAWindow', 'addresses.address.closeETAWindow'] });
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-03-03T08:00:00', '2026-03-02T14:30:00', '2026-03-02T09:15:00']);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['14', '11', '1']);

    const linked = (edit: (job: Payload) => void) => parse(changed((d) => edit(d.jobs[0]), 'handed-off'));
    expect(linked((job) => { job.link = 'courier::dpd'; job.agentref = '1550 1234 5678 90'; }))
      .toMatchObject({ delivery_carrier: 'dpd-uk', delivery_tracking_number: '15501234567890' });
    // A reference without the network's shape, GLS (no catalog carrier for its Irish network) and an unknown link name no carrier.
    for (const edit of [(job: Payload) => { job.agentref = 'ABCD12345'; }, (job: Payload) => { job.link = 'courier::gls'; },
      (job: Payload) => { job.link = 'courier::synthetic'; }, (job: Payload) => { delete job.link; }]) {
      const result = linked(edit);
      expect(result.delivery_carrier).toBeUndefined();
      expect(result.delivery_tracking_number).toMatch(/^(?:1Z999AA10123456784|ABCD12345)$/);
    }
    // The reply's own link wins over the page's table.
    expect(linked((job) => { job.link = 'courier::dpd'; job.trackurl = 'https://www.ups.com/track?loc=en_US&trackingNumber=%agentref%'; job.trackurltitle = 'Track with UPS'; }))
      .toMatchObject({ delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    // The job's own number is no second reference, and the job's carrier is never its own partner.
    expect(linked((job) => { job.agentref = NUMBER; })).not.toHaveProperty('delivery_tracking_number');
    for (const agentref of ['', 'AB', null, 'A'.repeat(41), 'AB/CD']) expect(linked((job) => { job.agentref = agentref; })).not.toHaveProperty('delivery_tracking_number');
  });

  it('keeps the hand-off of a job listed without events', () => {
    expect(() => parse(changed((d) => { d.jobs[0].events = []; }, 'handed-off'))).toThrowError(expect.objectContaining({
      kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed', deliveryCarrier: 'ups', deliveryTrackingNumber: '1Z999AA10123456784' }));
    expect(() => parse(changed((d) => { delete d.jobs[0].events; }))).toThrowError(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('binds the job to the number asked, by its consignment note or job id', () => {
    expect(parseUbxUk(script(changed((d) => { d.jobs[0].jobid = 1000001; })), '1000001').events).toHaveLength(6);
    expect(parse(changed((d) => { d.jobs.unshift({ ...d.jobs[0], consign_note: 'UBX0000000002', jobid: 2, events: [] }); })).events).toHaveLength(6);
    for (const data of [changed((d) => { d.jobs[0].consign_note = 'UBX0000000002'; }), changed((d) => { delete d.jobs[0].consign_note; }),
      changed((d) => { d.jobs[0].consign_note = `${NUMBER}1`; })]) {
      expect(() => parse(data)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parse(changed((d) => { d.jobs[0].consign_note = 'ubx-0000000001'; })).events).toHaveLength(6);
  });

  it('orders events on one clock by the reply, drops repeats and caps the history', () => {
    const same = changed((d) => {
      d.jobs[0].events = [{ time_stamp: '2026-03-02 09:00:00', statusid: '12.00', description: 'A' },
        { time_stamp: '2026-03-02 09:00:00', statusid: '13.00', description: 'B' }, { time_stamp: '2026-03-02 09:00:00', statusid: '13.00', description: 'B' }];
    });
    expect(parse(same).events!.map((event) => event.description)).toEqual(['B', 'A']);
    const long = changed((d) => {
      d.jobs[0].events = Array.from({ length: 120 }, (_, index) => ({ time_stamp: `2026-03-02 09:${String(index % 60).padStart(2, '0')}:${String(Math.floor(index / 60)).padStart(2, '0')}`,
        statusid: '14.00', description: `Synthetic ${index}` }));
    });
    expect(parse(long)).toMatchObject({ history_truncated: true, events: expect.objectContaining({ length: 100 }) });
  });

  it('rejects a clock it cannot read as a wall clock, a malformed event and an oversized timeline', () => {
    for (const data of [changed((d) => { d.jobs[0].events[0].time_stamp = '2026-02-31 09:15:00'; }),
      changed((d) => { d.jobs[0].events[0].time_stamp = '2026-03-02 24:00:00'; }),
      changed((d) => { d.jobs[0].events[0].time_stamp = '2026-03-02T09:15:00Z'; }),
      changed((d) => { d.jobs[0].events[0].time_stamp = '02/03/2026 09:15'; }), changed((d) => { delete d.jobs[0].events[0].time_stamp; }),
      changed((d) => { d.jobs[0].events[0].description = ' '; }), changed((d) => { d.jobs[0].events[0].statusid = 'done'; }),
      changed((d) => { d.jobs[0].events[0] = null; }), changed((d) => { d.jobs[0].events = {}; }),
      changed((d) => { d.jobs[0].events = Array(501).fill(d.jobs[0].events[0]); }), changed((d) => { delete d.jobs; }),
      changed((d) => { d.jobs = {}; }), null, [], 'jobs']) {
      expect(() => parse(data)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parse(changed((d) => { d.jobs[0].events[0].time_stamp = '2026-03-02T09:15:00.000'; })).events!.at(-1)!.local_time).toBe('2026-03-02T09:15:00');
  });

  it('tells a missing consignment from a refusal, another search, a changed reply and a browser check', () => {
    expect(() => parse(missing)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseUbxUk(` trackingdownload(${JSON.stringify(missing)})\n`, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    for (const data of [{ ...missing, request: { consign_note: 'UBX0000000002' } }, { ...missing, request: null }, { jobs: [] },
      { ...missing, error: [{ field: 'consign_note', error: 'Synthetic refusal' }] }]) {
      expect(() => parse(data)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseUbxUk('trackingdownload({"jobs":', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUbxUk(JSON.stringify(missing), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUbxUk('<!doctype html><title>Courier Navigator</title>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUbxUk('<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [404, 'transport']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status, { 'retry-after': '60' }));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reports the search's empty job list as not found", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(script(missing)));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn<typeof fetch>();
    await expect(carrier(never).track({ number: NUMBER }, { signal: before.signal })).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('takes a consignment note as printed and offers no number rule', () => {
    for (const number of ['', 'ABC', 'AB/CD1234', 'A'.repeat(31), '../search', 'A'.repeat(65)]) expect(() => normalizeUbxUkNumber(number), number).toThrow();
    for (const [raw, number] of [[' ubx 0000-000001 ', NUMBER], ['807012132', '807012132'], ['1000', '1000']]) expect(normalizeUbxUkNumber(raw!)).toBe(number);
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('ubx-uk');
    expect(recognitionCandidates(NUMBER).map((candidate) => candidate.carrier)).not.toContain('ubx-uk');
  });
});

describe('Courier Navigator status ids', () => {
  it('reads the ranges the pages read, and words the steps between collection and delivery', () => {
    expect(['1.00', '10.50', 11, '19.00', '20', '25.00', '30.00', '31.00', '99', null, '', undefined].map(navigatorCode))
      .toEqual(['1', '10.5', '11', '19', '20', '25', '30', '31', '99', '', '', '']);
    for (const value of ['x', '1.234', '1000', -1, '20,00']) expect(navigatorCode(value), String(value)).toBeUndefined();
    const stage = (code: string | null, wording = 'synthetic step') => navigatorStage(code, wording)?.stage;
    expect(['0', '10.5', '11', '12', '18.5', '19', '20', '20.5', '30', '31'].map((code) => stage(code)))
      .toEqual(['registered', 'registered', 'accepted', 'in_transit', 'in_transit', 'delivered', 'delivered', undefined, undefined, 'exception']);
    expect(stage('16', 'Out for delivery')).toBe('out_for_delivery');
    expect(stage('16', 'Delivered to neighbour')).toBe('in_transit');
    expect(stage('5', 'Out for delivery')).toBe('registered');
    expect(stage(null, 'Out for delivery')).toBe('out_for_delivery');
    expect(stage(null, 'synthetic step')).toBeUndefined();
    expect(stage('x', 'Delivered')).toBeUndefined();
    expect(statusMap.gapNote!('25', 'synthetic step')).toMatch(/after the delivery/);
    expect(statusMap.gapNote!('31', 'synthetic step')).toBeUndefined();
    expect(statusMap.gapNote!('20', 'synthetic step')).toBeUndefined();
  });

  it('records the ids it maps', () => {
    expect(statuses.entries.map((entry) => entry.code)).toEqual(['11', '19', '20']);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, 'synthetic step')).toBe(entry.stage);
      expect(entry.confirmedBy).toBe('documentation');
    }
  });
});
