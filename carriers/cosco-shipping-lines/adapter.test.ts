import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { ChallengeError } from '../../core/errors/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { fetchCoscoInBrowser } from './browser.js';
import { containerCheckDigit, COSCO_REPLY_KEY, coscoBillResult, coscoContainerResult, coscoQuery, decodeCoscoReply } from './parser.js';
import { coscoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

vi.mock('./browser.js', () => ({ fetchCoscoInBrowser: vi.fn() }));

// The public samples are bills of lading. The container and the booking are synthetic and lie far beyond the ranges in use.
const BILL = '6503593910';
const TAIWAN = '6505013130';
const MASKED = '6455175780';
const BOOKED = '6452418336';
const CONTAINER = 'ZZZU9999992';
const API = 'https://elines.coscoshipping.com/scct/scct_customer_ex/public/cargoTracking';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
/** A reply as COSCO sends it: the JSON's bytes XORed with the page's key, in base64, as a JSON string. */
const encode = (text: string) => JSON.stringify(Buffer.from(Buffer.from(text, 'utf8')
  .map((byte, index) => byte ^ COSCO_REPLY_KEY.charCodeAt(index % COSCO_REPLY_KEY.length))).toString('base64'));
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const html = (body: string, status: number) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const detail = (number: string) => () => json(encode(fixture(`detail-${number}`)));
const serve = (...replies: (() => Response)[]) => vi.fn<typeof fetch>(async () => replies.shift()!());
const carrier = (fetcher: typeof fetch, browserExecutablePath: string | null = null, recorder: StepRecorder = NOOP_RECORDER) =>
  adapter({ fetcher, recorder, env: {}, trawl: null, browserExecutablePath });
const envelope = (result: unknown, code = '200') => encode(JSON.stringify({ code, message: null, result, success: code === '200' }));
const nothing = { bookingNumbers: null, cargoTrackingFullChain: null, cargoTrackingSailingSchedule: null, cargoTrackingSummary: null,
  cargoTrackingTransportDetail: null, cargoTrackingTransportStatus: null };
const blocked = '<html><head><title>403 Forbidden</title></head><body><script src="https://blocksrc.haplat.net/_bot_sbu/block.js"></script></body></html>';
type Row = Record<string, unknown>;
type Detail = { result: { cargoTrackingFullChain: Row[]; cargoTrackingSailingSchedule: Row[]; cargoTrackingSummary: Row & { latestMilestone: Row } } };
const edited = (number: string, edit: (reply: Detail) => void) => { const reply = JSON.parse(fixture(`detail-${number}`)) as Detail; edit(reply); return encode(JSON.stringify(reply)); };

describe('COSCO SHIPPING Lines adapter', () => {
  it('posts the page\'s lookup for a bill, without its COSU prefix, through the supplied transport', async () => {
    const fetcher = serve(detail(BILL));
    await expect(carrier(fetcher).track({ number: `cosu ${BILL}` })).resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect([String(url), init?.method, init?.redirect, init?.signal instanceof AbortSignal]).toEqual([`${API}/detail`, 'POST', 'manual', true]);
    expect(JSON.parse(String(init?.body))).toEqual({ businessNumber: BILL, businessNumberType: 'blNumber', notFilterResult: false });
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json', Origin: 'https://elines.coscoshipping.com',
      Referer: `https://elines.coscoshipping.com/scct/public/ct/base?lang=en&trackingType=BILLOFLADING&number=${BILL}` });
  });

  it('reads the chain\'s milestones and the latest one, newest first, on the clocks COSCO gives their places', () => {
    const result = coscoBillResult(encode(fixture(`detail-${BILL}`)), BILL);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty Returned', last_update: '2026-08-03T08:41:00-04:00', expected_delivery: null });
    expect(result).not.toHaveProperty('planned_events');
    expect(result.events!.map(event => [event.time, event.time_zone, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-08-03T08:41:00-04:00', 'America/New_York', undefined, 'Empty Returned', 'Maher Terminal, Berth 64, New York, United States', 'delivered'],
      ['2026-07-30T12:08:00-04:00', 'America/New_York', 'Cargo Pickup Time', 'Cargo Pickup Time', 'New York, United States', 'out_for_delivery'],
      ['2026-07-27T07:02:50-04:00', 'America/New_York', 'ATA', 'ATA', 'New York, United States', 'in_transit'],
      ['2026-06-26T16:34:01+08:00', 'Asia/Shanghai', 'ATD', 'ATD', 'Shanghai, China', 'in_transit'],
      ['2026-06-22T20:10:00+08:00', 'Asia/Shanghai', 'Laden Return Time', 'Laden Return Time', 'Shanghai, China', 'accepted'],
    ]);
    expect(result.events!.every(event => event.time_zone_basis === 'carrier' && event.time?.startsWith(event.local_time!))).toBe(true);
  });

  it('leaves out a country the clock contradicts, dates the latest milestone by its town\'s facility, and keeps a masked one\'s wall clock', () => {
    const taiwan = coscoBillResult(encode(fixture(`detail-${TAIWAN}`)), TAIWAN);
    expect(taiwan.events!.map(event => [event.time, event.location])).toEqual([
      ['2026-08-05T08:54:00-07:00', 'Pacific Container Terminal, Long Beach, United States'],
      ['2026-07-30T20:54:00-07:00', 'Long Beach, United States'],
      ['2026-07-27T04:45:10-07:00', 'Long Beach, United States'],
      ['2026-07-13T00:33:48+08:00', 'Kaohsiung'],
      ['2026-06-30T15:23:00+08:00', 'Keelung'],
    ]);
    const masked = coscoBillResult(encode(fixture(`detail-${MASKED}`)), MASKED);
    expect(masked).toMatchObject({ current_stage: 'delivered', last_status_text: 'Empty Return', last_update: null, last_update_local: '2026-08-03T13:53:00' });
    expect(masked.events![0]).toEqual({ local_time: '2026-08-03T13:53:00', description: 'Empty Return', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('finds a bill by its own number or its booking\'s, and reads every vessel leg, keeping estimates as planned steps', async () => {
    await expect(carrier(serve(detail(BOOKED))).track({ number: BOOKED })).resolves.toMatchObject({ current_stage: 'delivered', last_update: '2026-06-15T14:34:00-05:00' });
    await expect(carrier(serve(detail(BOOKED))).track({ number: '6452418330' })).resolves.toMatchObject({ current_stage: 'delivered' });
    const sailing = edited('6505334960', reply => {
      const [leg] = reply.result.cargoTrackingSailingSchedule;
      reply.result.cargoTrackingSailingSchedule = [{ ...leg, podPort: 'Busan', podTimezoneIana: 'Asia/Seoul', ata: '2026-07-08T09:00:00' },
        { ...leg, polPort: 'Busan', polTimezoneIana: 'Asia/Seoul', etd: '2026-07-10T04:00:00', atd: null, ata: null }];
      reply.result.cargoTrackingFullChain[3]!.actualTime = null;
      reply.result.cargoTrackingSummary.latestMilestone = {};
    });
    const result = coscoBillResult(sailing, '6505334960');
    expect(result.events!.map(event => [event.time, event.provider_code, event.location])).toEqual([
      ['2026-07-08T09:00:00+09:00', 'ATA', 'Busan'],
      ['2026-07-06T04:19:04+08:00', 'ATD', 'Shanghai, China'],
      ['2026-07-01T16:12:00+08:00', 'Laden Return Time', 'Shanghai, China'],
    ]);
    expect(result).toMatchObject({ current_stage: 'in_transit', planned_events: [
      { time: '2026-07-10T04:00:00+09:00', description: 'ETD', location: 'Busan' },
      { time: '2026-07-21T06:00:00-07:00', description: 'ETA', location: 'Long Beach, United States' },
      { time: '2026-07-22T17:00:00-07:00', description: 'Cargo Pickup Time', location: 'Long Beach, United States', stage: 'out_for_delivery' },
    ] });
  });

  it('reads a container\'s latest milestone on its wall clock and its arrival at the last port as planned, and marks the history cut short', async () => {
    const fetcher = serve(() => json(encode(fixture('containers-synthetic'))));
    const result = await carrier(fetcher).track({ number: 'zzzu 999999-2' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${API}/containers`);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ businessNumber: CONTAINER, businessNumberType: 'containerNumber', notFilterResult: false });
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Discharged at Port of Transshipment', last_update: null, last_update_local: '2026-11-13T02:14:00', expected_delivery: null,
      history_truncated: true, events: [{ local_time: '2026-11-13T02:14:00', location: 'Piraeus Container Terminal',
        description: 'Discharged at Port of Transshipment', stage: 'in_transit', stage_source: 'carrier_map' }],
      planned_events: [{ time: '2026-11-22T19:00:00+02:00', description: 'ETA' }] });
    const arrived = JSON.parse(fixture('containers-synthetic')) as { result: Record<string, unknown>[] };
    arrived.result[0] = { ...arrived.result[0], ataAtLastPod: '2026-11-22T21:30:00', milestones: [] };
    expect(coscoContainerResult(encode(JSON.stringify(arrived)), CONTAINER)).toMatchObject({ last_update: '2026-11-22T21:30:00+02:00',
      events: [{ time: '2026-11-22T21:30:00+02:00', time_zone: 'Europe/Bucharest', provider_code: 'ATA', stage: 'in_transit' }] });
  });

  it('reads a number COSCO does not hold as not found, and one it lists without milestones as no history', async () => {
    await expect(carrier(serve(() => json(envelope(nothing)))).track({ number: BILL })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(serve(() => json(envelope([])))).track({ number: CONTAINER })).rejects.toMatchObject({ kind: 'not_found' });
    const quiet = edited(BILL, reply => {
      reply.result.cargoTrackingFullChain = [];
      reply.result.cargoTrackingSailingSchedule = [{ ...reply.result.cargoTrackingSailingSchedule[0], atd: null, ata: null }];
      reply.result.cargoTrackingSummary.latestMilestone = {};
    });
    await expect(carrier(serve(() => json(quiet))).track({ number: BILL })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed',
      plannedEvents: [{ description: 'ETD' }, { description: 'ETA' }] });
  });

  it('keeps another shipment, a changed reply, the bot manager and a rate limit apart from a missing shipment', async () => {
    const ask = (reply: () => Response, number = BILL) => carrier(serve(reply)).track({ number });
    await expect(ask(detail(BILL), TAIWAN)).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => json(encode(fixture('containers-synthetic'))), 'CBHU9999990')).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => json(envelope({ ...nothing, cargoTrackingFullChain: [{}] })))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => json(edited(BILL, reply => { reply.result.cargoTrackingSummary.latestMilestone = { eventName: 'Empty Returned', actualEventDateTime: 'yesterday' }; }))))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => json(fixture(`detail-${BILL}`).replace('"code":"200"', '"code":"500"')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => json('"not base64"'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => html('<html><body>COSCO</body></html>', 200))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => json(envelope(null, '429')))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(ask(() => html(blocked, 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(ask(() => html(blocked, 200))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(ask(() => html('', 404))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(ask(() => html('', 302))).rejects.toMatchObject({ kind: 'transport', status: 302 });
    // A reply the page would read unencoded is read the same way.
    expect(decodeCoscoReply(fixture(`detail-${BILL}`))).toMatchObject({ code: '200', success: true });
  });

  it('opens the page in a local browser when the bot manager blocks the plain lookup, and only then', async () => {
    const browser = vi.mocked(fetchCoscoInBrowser).mockClear().mockResolvedValue(coscoBillResult(encode(fixture(`detail-${BILL}`)), BILL));
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(serve(() => html(blocked, 403)), '/synthetic/chromium', recorder).track({ number: BILL })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(browser).toHaveBeenCalledWith({ kind: 'bill', number: BILL }, '/synthetic/chromium', expect.any(AbortSignal), expect.any(Number));
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'challenge' }, { step: 'browser', outcome: 'ok' }]);
    await expect(carrier(serve(() => json(envelope(null, '429'))), '/synthetic/chromium').track({ number: BILL })).resolves.toMatchObject({ current_stage: 'delivered' });
    browser.mockClear().mockRejectedValue(new ChallengeError('COSCO SHIPPING Lines'));
    await expect(carrier(serve(() => json(envelope(nothing))), '/synthetic/chromium').track({ number: BILL })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(serve(() => html(blocked, 403))).track({ number: BILL })).rejects.toMatchObject({ kind: 'challenge' });
    expect(browser).not.toHaveBeenCalled();
  });

  it('tries once more after a failed connection, inside the caller\'s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(detail(BILL)());
    await expect(carrier(flaky).track({ number: BILL })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: BILL }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('takes a bill or booking of ten digits, after COSU too, or a container with its check digit, and nothing else, without a request', async () => {
    expect([containerCheckDigit('ZZZU999999'), containerCheckDigit('CBHU999999')]).toEqual([2, 0]);
    expect(coscoQuery(` COSU${BILL} `)).toEqual({ kind: 'bill', number: BILL });
    expect(coscoQuery('zzzu9999992')).toEqual({ kind: 'container', number: CONTAINER });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZZU9999993', '650359391', '65035939100', 'COSU650359391', 'OOLU6503593910', 'SAMPLETRACKING', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is asked when the number is filed under COSCO SHIPPING Lines', async () => {
    await expect(createTracker({ fetcher: serve(detail(BILL)), providers: [], env: {} }).track({ number: BILL, carrier: 'cosco-shipping-lines' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'cosco-shipping-lines', source: 'cosco-shipping-lines', result: { current_stage: 'delivered' } });
  });
});

describe('COSCO SHIPPING Lines status vocabulary', () => {
  it('stages the chain\'s milestones by their name as a code and the latest milestone by its wording', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code ?? null : null;
      expect(coscoStage(code, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'cosco-shipping-lines', providerCode: code, description: entry.wording }).kind, entry.wording).toBe('mapped');
    }
    expect(statusMap.stage('ATD', 'atd')).toBe('in_transit');
    expect(statusMap.stage(null, 'atd')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'cosco-shipping-lines', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
