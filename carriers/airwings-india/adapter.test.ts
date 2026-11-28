import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { AIRWINGS_INDIA, normalizeAirwingsNumber, parseAirwings } from './parser.js';
import { airwingsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'AW0000000001';
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = () => JSON.parse(read('forwarded'));
type Reply = ReturnType<typeof fixture>;
const changed = (edit: (data: Reply) => void) => { const data = fixture(); edit(data); return JSON.stringify(data); };
const response = (body: string, status = 200, headers: HeadersInit = { 'Content-Type': 'application/json; charset=utf-8' }) => new Response(body, { status, headers });
const carrier = (fetcher: typeof fetch, recorder = NOOP_RECORDER) => adapter({ fetcher, recorder, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'SyntheticHost/1' });

describe('Airwings India Xpresion lookup', () => {
  it('posts the air waybill with the page’s visitor login, once, with the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(read('forwarded')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await carrier(fetcher, recorder).track({ number: 'aw 0000-000001' }, { budgetMs: 4000 });
    expect(result.events).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://xpresion.airwingsindia.com/api/v1/Tracking/Tracking');
    expect(JSON.parse(String(init!.body))).toEqual({ UserID: 'CARD', Password: 'CARD@71', AWBNo: NUMBER, Type: 'A', RequiredUrl: 'yes' });
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), headers: { 'Content-Type': 'application/json',
      Origin: 'https://airwingsindia.com', Referer: `https://airwingsindia.com/tracking.html?awbno=${NUMBER}`, 'User-Agent': 'SyntheticHost/1' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'airwings-india', step: 'direct', outcome: 'ok' }));
  });

  it('reads the scans newest first on wall clocks, the destination and the forwarding carrier', () => {
    const result = parseAirwings(read('forwarded'), NUMBER);
    expect(result).toMatchObject({ status: languageStageStatus('in_transit'), current_stage: 'in_transit', last_status_text: 'Synthetic arrival at destination',
      provider_code: 'AR', last_update: null, last_update_local: '2026-03-05T10:15:00', expected_delivery: null, destination_country: 'GB',
      delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784', unread_estimates: ['Tracking.ExpectedDeliveryDate'] });
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-03-05T10:15:00', '2026-03-03T22:30:00', '2026-03-02T17:42:00']);
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-03-02T17:42:00', location: 'MUMBAI', description: 'SHIPMENT RECEIVED',
      stage: 'accepted', stage_source: 'carrier_map' });
    expect(result.events![1]).not.toHaveProperty('provider_code');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|1\.5/);
  });

  it('reads an oldest-first reply newest first, drops repeats and dates a delivery', () => {
    const delivered = changed((d) => {
      d.Response.Events.unshift({ EventDate: '06/03/2026', EventTime: '0901', Location: 'LONDON', Status: 'DELIVERED', Excp_Code: 'OK' });
      d.Response.Events.reverse();
      d.Response.Events.push(d.Response.Events.at(-1));
    });
    const result = parseAirwings(delivered, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'DELIVERED', last_update_local: '2026-03-06T09:01:00' });
    expect(result.events).toHaveLength(4);
    expect(result.unread_estimates).toBeUndefined();
  });

  it('names a forwarding carrier only when its number has that carrier’s shape', () => {
    const forwarded = (edit: (shipment: Record<string, unknown>) => void) => parseAirwings(changed((d) => edit(d.Response.Tracking[0])), NUMBER);
    expect(forwarded((s) => { s.VendorAWBNo1 = 'ABCD12345'; })).toMatchObject({ delivery_tracking_number: 'ABCD12345' });
    expect(forwarded((s) => { s.VendorAWBNo1 = 'ABCD12345'; }).delivery_carrier).toBeUndefined();
    expect(forwarded((s) => { s.VendorName = ''; s.VendorLinkURL = ''; }).delivery_carrier).toBeUndefined();
    expect(forwarded((s) => { s.VendorName = ''; })).toMatchObject({ delivery_carrier: 'ups' });
    for (const reference of ['', 'AB', NUMBER, null]) {
      const result = forwarded((s) => { s.VendorAWBNo1 = reference; });
      expect(result.delivery_tracking_number).toBeUndefined();
      expect(result.delivery_carrier).toBeUndefined();
    }
  });

  it('keeps the forwarding number of a shipment listed without scans', () => {
    for (const events of [[], null]) {
      expect(() => parseAirwings(changed((d) => { d.Response.Events = events; }), NUMBER)).toThrowError(expect.objectContaining({
        name: 'NoHistoryError', reason: 'listed', deliveryCarrier: 'ups', deliveryTrackingNumber: '1Z999AA10123456784' }));
    }
  });

  it('binds the shipment to the number asked', () => {
    for (const body of [changed((d) => { d.Response.Tracking[0].AWBNo = 'AW0000000002'; }), changed((d) => { d.Response.Tracking = [null]; }),
      changed((d) => { delete d.Response.Tracking[0].AWBNo; })]) {
      expect(() => parseAirwings(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseAirwings(changed((d) => { d.Response.Tracking[0].AWBNo = 'aw-0000000001'; }), NUMBER).events).toHaveLength(3);
  });

  it('rejects a malformed scan, clock or envelope', () => {
    for (const body of [changed((d) => { d.Response.Events[0].EventDate = '31/02/2026'; }), changed((d) => { d.Response.Events[0].EventTime = '2400'; }),
      changed((d) => { d.Response.Events[0].EventTime = '10:15'; }), changed((d) => { d.Response.Events[0].Status = ''; }),
      changed((d) => { d.Response.Events[0].Excp_Code = 'A B'; }), changed((d) => { d.Response.Events[0].Location = 4; }),
      changed((d) => { d.Response.Events[0] = null; }), changed((d) => { d.Response.Events = {}; }),
      changed((d) => { d.Response.Tracking = null; }), changed((d) => { d.Response = null; }), '[]']) {
      expect(() => parseAirwings(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the service’s own missing-shipment reply as not found, and other refusals and pages as failures', () => {
    expect(() => parseAirwings(read('not-found'), 'AW2314163530')).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAirwings(changed((d) => { d.Response.ErrorDisc = 'Invalid UserID or Password'; }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAirwings('<!doctype html><title>Airwings</title>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAirwings('<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [404, 'transport']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status, { 'retry-after': '60' }));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
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

  it('takes an air waybill as printed and offers no number rule', () => {
    for (const raw of ['', 'AW123', 'AW/2314163530', 'A'.repeat(31)]) expect(() => normalizeAirwingsNumber(raw), raw).toThrow();
    expect(normalizeAirwingsNumber('AW 2314163530')).toBe('AW2314163530');
    expect(AIRWINGS_INDIA.page('AW2314163530')).toBe('https://airwingsindia.com/tracking.html?awbno=AW2314163530');
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('airwings-india');
    expect(recognitionCandidates(NUMBER).map((candidate) => candidate.carrier)).not.toContain('airwings-india');
  });

  it('stages the recorded wording by the map and the rest by the shared rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    expect(airwingsStage('', 'Out for Delivery')).toMatchObject({ stage: 'out_for_delivery' });
    expect(statusMap.stage('15', 'out for delivery')).toBeUndefined();
    expect(airwingsStage('', 'Synthetic step')).toBeNull();
  });
});
