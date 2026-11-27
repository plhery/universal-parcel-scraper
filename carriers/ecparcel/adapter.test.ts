import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS, statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, EcparcelTracker } from './adapter.js';
import { ECPARCEL_LOOKUP, normalizeEcparcelNumber, parseEcparcel, parseEcparcelReply } from './parser.js';
import { ecparcelStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample of numbers.json and the service's reply to it.
const NUMBER = 'YOTN20260423100000003';
// A synthetic number of the sample's shape, dated in 2099.
const UNKNOWN = 'YOTN20991231900000017';
type Row = Record<string, unknown>;
type Reply = { success: boolean; result: { shipmentTrackingNumber: unknown; trackingEventList: Row[] } };
const sampleText = readFileSync(new URL(`./fixtures/${NUMBER}.json`, import.meta.url), 'utf8');
const notFoundText = readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8');
const sample = (): Reply => JSON.parse(sampleText);
const changed = (edit: (reply: Reply) => void) => { const reply = sample(); edit(reply); return reply; };
const newest = (edit: (row: Row) => void) => changed((reply) => edit(reply.result.trackingEventList[0]!));
const JSON_TYPE = 'application/json; charset=utf-8';
const response = (body: string, status = 200, headers: HeadersInit = { 'content-type': JSON_TYPE }) => new Response(body, { status, headers });
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('ecParcel adapter', () => {
  it('asks the service the tracker page asks, once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(sampleText));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new EcparcelTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(12);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://track.ec-parcel.com/api/shipmentTracking/getShipmentTracking?trackingNumber=${NUMBER}`);
    expect(String(url).startsWith(ECPARCEL_LOOKUP)).toBe(true);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ecparcel', step: 'direct', outcome: 'ok' }));
  });

  it('reads the public sample as delivered, its scans as the instants they state', () => {
    const result = parseEcparcel(sample(), NUMBER);
    expect(result).toMatchObject({
      status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'Delivered',
      last_status_text: 'Delivered', last_update: '2026-04-30T10:09:11+10:00', expected_delivery: null, delivered_at: '2026-04-30T10:09:11+10:00',
    });
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage, event.provider_code])).toEqual([
      ['2026-04-30T10:09:11+10:00', 'Delivered', 'MOSSMAN QLD, Australia', 'delivered', 'Delivered'],
      ['2026-04-30T07:46:39+10:00', 'Onboard for delivery', 'CRAIGLIE QLD, Australia', 'out_for_delivery', 'OutForDelivery'],
      ['2026-04-27T22:24:03+10:00', 'Arrived at facility', 'BUNGALOW QLD, Australia', 'in_transit', 'InTransit'],
      ['2026-04-27T22:24:02+10:00', 'Arrived at facility', 'BUNGALOW QLD, Australia', 'in_transit', 'InTransit'],
      ['2026-04-26T17:04:15+10:00', 'In transit to next facility', 'REDBANK QLD, Australia', 'in_transit', 'InTransit'],
      ['2026-04-26T13:25:18+10:00', 'Item processed at sorting facility', 'REDBANK QLD, Australia', 'in_transit', 'InTransit'],
      ['2026-04-25T06:59:14+10:00', 'Arrived at facility', 'REDBANK QLD, Australia', 'in_transit', 'InTransit'],
      ['2026-04-25T05:01:50+10:00', 'Arrived at facility', 'REDBANK QLD, Australia', 'in_transit', 'InTransit'],
      ['2026-04-24T06:34:30+10:00', 'In transit to next facility', 'DANDENONG SOUTH VIC, Australia', 'in_transit', 'InTransit'],
      ['2026-04-23T02:40:03.373Z', 'In transit to the destination', null, 'in_transit', 'InTransit_002'],
      ['2026-04-23T02:38:08.264Z', 'Parcel collected by the courier', null, 'accepted', 'InTransit_001'],
      ['2026-04-23T02:37:05.978Z', 'Document received by the courier', null, 'registered', 'InfoReceived_001'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    // The scans' ids stay behind.
    expect(JSON.stringify(result)).not.toMatch(/eventId|01KQ/);
  });

  it('orders scans by their instants across offsets, keeping the reply\'s order at one instant', () => {
    // A depot scan written in UTC still sorts by its instant.
    const moved = parseEcparcel(changed((reply) => { reply.result.trackingEventList[1]!.eventTime = '2026-04-30T00:30:00Z'; }), NUMBER);
    expect(moved.events!.slice(0, 2).map((event) => event.description)).toEqual(['Onboard for delivery', 'Delivered']);
    expect(moved).toMatchObject({ current_stage: 'out_for_delivery', last_update: '2026-04-30T00:30:00Z' });
    expect(moved.delivered_at).toBeUndefined();
    const tied = parseEcparcel(changed((reply) => { reply.result.trackingEventList[2]!.eventTime = '2026-04-30T07:46:39+10:00'; }), NUMBER);
    expect(tied.events!.slice(1, 3).map((event) => event.description)).toEqual(['Onboard for delivery', 'Arrived at facility']);
    // The same scan twice, under another id, is one.
    const doubled = changed((reply) => { reply.result.trackingEventList.splice(1, 0, { ...reply.result.trackingEventList[1]!, eventId: 'X' }); });
    expect(parseEcparcel(doubled, NUMBER).events).toHaveLength(12);
  });

  it('reads a clock only with its offset or Z', () => {
    const clock = (eventTime: unknown) => parseEcparcel(newest((row) => { row.eventTime = eventTime; }), NUMBER).events![0]!.time;
    expect(clock('2026-04-30T10:09:11+10:00')).toBe('2026-04-30T10:09:11+10:00');
    expect(clock('2026-04-30T10:09:11+11:00')).toBe('2026-04-30T10:09:11+11:00');
    expect(clock('2026-05-01T00:09:11.5Z')).toBe('2026-05-01T00:09:11.500Z');
    for (const unread of ['2026-04-30T10:09:11', '2026-04-30 10:09:11', '2026-04-30', '2026-04-30T24:09:11+10:00', '2026-04-30T10:09:11+1000',
      '30/04/2026 10:09', 1777507751000, null, '']) {
      expect(() => parseEcparcel(newest((row) => { row.eventTime = unread; }), NUMBER), String(unread)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps the place the reply gives, else the suburb and state, else none', () => {
    const fromParts = parseEcparcel(newest((row) => { delete row.location; }), NUMBER).events![0]!;
    expect(fromParts.location).toBe('MOSSMAN QLD');
    const none = parseEcparcel(newest((row) => { delete row.location; delete row.city; delete row.state; }), NUMBER).events![0]!;
    expect(none).not.toHaveProperty('location');
    expect(() => parseEcparcel(newest((row) => { row.location = { city: 'MOSSMAN' }; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('stages a scan by its code, letting transit yield to wording the shared rules read otherwise', () => {
    const stageOf = (status: string, message: string, subStatus?: string) => parseEcparcel(newest((row) => {
      row.eventStatus = status; row.eventMessage = message; if (subStatus) row.eventSubStatus = subStatus;
    }), NUMBER);
    // An unseen wording under a known status takes the status's stage.
    expect(stageOf('Delivered', 'Left in a safe place')).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(stageOf('OutForDelivery', 'With driver')).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(stageOf('InTransit', 'Departed facility')).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(stageOf('InTransit', 'Departed facility', 'InTransit_009')).toMatchObject({ current_stage: 'in_transit', provider_code: 'InTransit_009' });
    // Transit is every depot scan's status: a return or a failed delivery filed under it reads by its words.
    expect(stageOf('InTransit', 'Returned to sender')).toMatchObject({ current_stage: 'returned', current_stage_source: expect.stringMatching(/^wording:/) });
    expect(stageOf('InTransit', 'Delivery attempted')).toMatchObject({ current_stage: 'failed_attempt' });
    // A status the service has not shown reads by its wording, or leaves the scan without a stage.
    expect(stageOf('AttemptFail', 'Card left')).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: expect.stringMatching(/^wording:/) });
    const unread = stageOf('Exception', 'Please contact us');
    expect(unread.events![0]).not.toHaveProperty('stage');
    // Then the newest staged scan leads, which cannot be the delivery the unread scan may have undone.
    expect(unread).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Onboard for delivery', provider_code: 'OutForDelivery' });
    expect(unread.delivered_at).toBeUndefined();
  });

  it('binds the reply to the whole number asked', () => {
    for (const other of ['YOTN20260423100000004', `${NUMBER}1`, NUMBER.slice(1)]) {
      expect(() => parseEcparcel(changed((reply) => { reply.result.shipmentTrackingNumber = other; }), NUMBER), other)
        .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const missing of ['', null, 42, [NUMBER], undefined]) {
      expect(() => parseEcparcel(changed((reply) => { reply.result.shipmentTrackingNumber = missing; }), NUMBER), String(missing))
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseEcparcel(changed((reply) => { reply.result.shipmentTrackingNumber = ` ${NUMBER.toLowerCase()} `; }), NUMBER).events).toHaveLength(12);
  });

  it('reads a known shipment without scans as no history, never as missing', () => {
    expect(() => parseEcparcel(changed((reply) => { reply.result.trackingEventList = []; }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('rejects a reply that is not a list of complete scans', () => {
    for (const data of [newest((row) => { delete row.eventMessage; }), newest((row) => { row.eventMessage = 7; }), newest((row) => { row.eventMessage = ' '; }),
      newest((row) => { delete row.eventStatus; }), newest((row) => { row.eventStatus = 'In Transit'; }), newest((row) => { row.eventStatus = 3; }),
      newest((row) => { row.eventSubStatus = 'InTransit 001'; }), newest((row) => { row.eventSubStatus = {}; }),
      changed((reply) => { reply.result.trackingEventList.push(null as unknown as Row); }),
      changed((reply) => { reply.result.trackingEventList = Array(301).fill(sample().result.trackingEventList[0]); }),
      changed((reply) => { (reply.result as Row).trackingEventList = {}; }), changed((reply) => { reply.success = false; }),
      { success: true }, { success: true, result: [] }, null, [], 'Delivered']) {
      expect(() => parseEcparcel(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the service\'s own not-found answer, and nothing else, as a missing shipment', () => {
    expect(() => parseEcparcelReply(404, JSON_TYPE, notFoundText, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    // A missing route answers 404 under the same code, in other words.
    const route = '{"success":false,"errors":[{"code":"NOT_FOUND","message":"Not Found"}]}';
    expect(() => parseEcparcelReply(404, JSON_TYPE, route, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseEcparcelReply(404, JSON_TYPE, '{}', UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseEcparcelReply(404, 'text/html', '<html><title>404</title></html>', UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseEcparcelReply(200, JSON_TYPE, notFoundText, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // The service's refusal of the number's form, and of the request.
    const refused = '{"success":false,"errors":[{"code":"VALIDATION_ERROR","message":"shipmentTrackingNumber: Invalid tracking number"}]}';
    expect(() => parseEcparcelReply(422, JSON_TYPE, refused, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    const bad = '{"success":false,"errors":[{"code":"BAD_REQUEST","message":"Invalid request query input"}]}';
    expect(() => parseEcparcelReply(400, JSON_TYPE, bad, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcparcelReply(422, JSON_TYPE, bad, UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('tells a browser check, another page and a broken reply apart', () => {
    expect(() => parseEcparcelReply(200, 'text/html; charset=UTF-8', CLOUDFLARE, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseEcparcelReply(200, 'text/html', '<!DOCTYPE html><title>ecParcel Tracking Web</title>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcparcelReply(200, JSON_TYPE, '{"success":', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcparcelReply(200, '', sampleText, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcparcelReply(302, '', '', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(parseEcparcelReply(200, JSON_TYPE, sampleText, NUMBER).current_stage).toBe('delivered');
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(notFoundText, status, { 'retry-after': '60' }));
    await expect(new EcparcelTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reads a not-found answer, a challenge page and a redirect through the transport', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(response(notFoundText, 404));
    await expect(new EcparcelTracker({ fetcher: missing }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    const check = vi.fn<typeof fetch>().mockResolvedValue(response(CLOUDFLARE, 200, { 'content-type': 'text/html' }));
    await expect(new EcparcelTracker({ fetcher: check }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 301, headers: { location: '/' } }));
    await expect(new EcparcelTracker({ fetcher: moved }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('sends a read that fails to reach the service once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(response(sampleText));
    const result = await new EcparcelTracker({ fetcher }).fetch(NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refuses a number the service cannot take before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'YOTN1', 'YOTN_2026', 'YOTN/20260423', 'YOTNABCDEF', 'Y'.repeat(41), '1'.repeat(65)]) {
      expect(() => normalizeEcparcelNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
    await expect(new EcparcelTracker({ fetcher }).fetch('YOTN1')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of [NUMBER, 'yotn20260423100000003', 'YOTN 2026 0423 1000 0000 3', 'YOTN-20260423-100000003']) {
      expect(normalizeEcparcelNumber(number)).toBe(NUMBER);
    }
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn<typeof fetch>();
    await expect(new EcparcelTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new EcparcelTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('detects the sample\'s shape and routes it to the adapter', async () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'ecparcel', confidence: 'high' });
    expect(detectCarrierMatch(UNKNOWN)).toMatchObject({ carrier: 'ecparcel', confidence: 'high' });
    for (const other of ['YOTN20261323100000003', 'YOTN2026042310000003', 'XOTN20260423100000003', 'YOTN19990423100000003']) {
      expect(detectCarrierMatch(other).carrier, other).not.toBe('ecparcel');
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(sampleText));
    const answer = await createTracker({ fetcher, env: {}, providers: [] }).track({ number: NUMBER });
    expect(answer).toMatchObject({ carrier: 'ecparcel', source: 'ecparcel' });
    expect(answer.result).toMatchObject({ current_stage: 'delivered' });
    const registered = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    expect(registered).toMatchObject({ id: 'ecparcel', steps: ['direct', 'retry'] });
  });

  it('maps every status it recorded and registers its map', () => {
    expect(STATUS_MAPS.ecparcel).toBe(statusMap);
    for (const { code, wording, stage } of statuses.entries) {
      expect(ecparcelStage(code, wording), `${code} ${wording}`).toEqual({ stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'ecparcel', providerCode: code, description: wording }), `${code} ${wording}`).toEqual({ kind: 'mapped', stage });
    }
    expect(statusMap.stage('InTransit', 'returned to sender')).toBeUndefined();
    expect(statusMap.stage('Exception', 'please contact us')).toBeUndefined();
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
  });
});
