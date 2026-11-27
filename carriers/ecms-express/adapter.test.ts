import { describe, expect, it, vi } from 'vitest';
import { EcmsExpressTracker, normalizeEcmsExpressNumber, parseEcmsExpress } from './adapter.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { carrierAdapter } from '../../core/catalog/definitions.js';
import { isPartialAnswer } from '../../core/result/partial.js';
import { dateLocalClocks } from '../../places/clocks.js';

const NUMBER = 'ECTST00000000001';
const PARTNER = 'SPXTEST000000000001';
const opened = (suffix = '1') => ({ status: 200, message: 'SUCCESS', data: {
  signKey: `00000000-0000-4000-8000-00000000000${suffix}`, base64Data: 'data:image/png;BASE64,QUJD' } });
const verified = (suffix = '1') => ({ status: 200, message: 'SUCCESS', data: `synthetic-verification-sign-${suffix}` });
const refusal = { status: 200, message: 'check fail', error: '500', data: null };
const expired = { status: 500, message: 'verify failure' };
const row = () => ({ trackingId: NUMBER, eventCode: 'EVENT_301', eventDescription: 'Shipment delivered to customer',
  customDescription: 'PRIVATE', purchaseOrderNumber: 'PRIVATE', fileUrlList: ['PRIVATE'],
  operatorTime: Date.UTC(2026, 6, 4, 14, 10), timeZone: 0, createDateTime: Date.UTC(2026, 6, 5),
  cityEnName: 'Example City', provinceEnName: '', countryEnName: 'US', source: 'dc_PN_SpeedX', orderCode: PARTNER });
const fixture = () => ({ status: 200, orderNumber: [NUMBER], eseFreightUrl: 'PRIVATE', eseTaxesUrl: 'PRIVATE', orderInfo: [{
  baseInfo: row(), consigneeCountry: 'US', vendorConfig: { name: 'SpeedX', url: 'PRIVATE' },
  infoList: [row(), { ...row(), eventCode: 'EVENT_314', eventDescription: 'Flight arrival', operatorTime: Date.UTC(2026, 6, 3, 10), timeZone: -8, source: 'APS' },
    { ...row(), eventCode: 'EVENT_201', eventDescription: 'Shipment arrived at origin facility.', operatorTime: Date.UTC(2026, 6, 2, 9), timeZone: 9, source: 'OMSBUSINESS' }],
}] });

describe('ECMS history', () => {
  it('keeps complete history, carrier offsets and partner instants, discarding private extras', () => {
    const result = parseEcmsExpress(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-07-04T14:10:00Z',
      destination_country: 'US', delivery_carrier: 'speedx', delivery_tracking_number: PARTNER });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events).toHaveLength(3);
    // SpeedX's delivery, relayed with offset zero, is the UTC instant: on Pittsburgh's clock it would
    // fall after ECMS recorded it, where SpeedX's own copy states 10:09:07-05:00 for 15:09:07 here.
    expect(result.events![0]).toMatchObject({ time: '2026-07-04T14:10:00Z', provider_code: 'EVENT_301', stage_source: 'carrier_map' });
    expect(result.events![0]!.local_time).toBeUndefined();
    expect(result.events![1]).toMatchObject({ local_time: '2026-07-03T10:00:00', time: '2026-07-03T10:00:00-08:00' });
    expect(result.events![2]).toMatchObject({ local_time: '2026-07-02T09:00:00', time: '2026-07-02T09:00:00+09:00' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(isPartialAnswer(result)).toBe(false);
  });

  it("keeps the wall clocks of a partner feed whose offset-zero scans would postdate ECMS's record", () => {
    const data = fixture();
    const order = data.orderInfo[0]!;
    order.consigneeCountry = 'TW';
    const taiwan = { source: 'dc_tw.acs', countryEnName: 'TW' };
    // Delivered at 11:57 in Taiwan, recorded at 05:08 UTC; the morning's round, recorded before 11:56 UTC.
    Object.assign(order.baseInfo, taiwan, { operatorTime: Date.UTC(2026, 10, 20, 11, 57), createDateTime: Date.UTC(2026, 10, 20, 5, 8, 21) });
    Object.assign(order.infoList[0]!, taiwan, { operatorTime: Date.UTC(2026, 10, 20, 11, 57), createDateTime: Date.UTC(2026, 10, 20, 5, 8, 21) });
    order.infoList.splice(1, 0, { ...row(), ...taiwan, eventCode: 'EVENT_302', eventDescription: 'Shipment is out for delivery.',
      operatorTime: Date.UTC(2026, 10, 20, 8, 47), createDateTime: Date.UTC(2026, 10, 20, 11, 56) });
    const result = parseEcmsExpress(data, NUMBER);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-11-20T11:57:00' });
    expect(result.events![0]).toMatchObject({ local_time: '2026-11-20T11:57:00', provider_code: 'EVENT_301' });
    expect(result.events![1]).toMatchObject({ local_time: '2026-11-20T08:47:00', provider_code: 'EVENT_302' });
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).not.toHaveProperty('time');
    expect(dateLocalClocks('ecms-express', result).events![0]).toMatchObject({ time: '2026-11-20T11:57:00+08:00', time_zone: 'Asia/Taipei' });
    // SpeedX's feed, whose instants precede their record, stays as it was.
    expect(parseEcmsExpress(fixture(), NUMBER).events![0]).toMatchObject({ time: '2026-07-04T14:10:00Z' });
  });

  it("leaves out the destination's code after a partner's town abroad, keeping it after the destination's own", () => {
    const data = fixture();
    const order = data.orderInfo[0]!;
    order.consigneeCountry = 'BG';
    Object.assign(order.infoList[0]!, { cityEnName: 'Almere', countryEnName: 'BG' });
    Object.assign(order.infoList[1]!, { cityEnName: 'Sofia', countryEnName: 'BG' });
    Object.assign(order.infoList[2]!, { cityEnName: 'Amsterdam', provinceEnName: 'North Holland', countryEnName: 'Netherlands' });
    expect(parseEcmsExpress(data, NUMBER).events!.map(event => event.location))
      .toEqual(['Almere', 'Sofia, BG', 'Amsterdam, North Holland, Netherlands']);
    expect(parseEcmsExpress(fixture(), NUMBER).events![0]!.location).toBe('Example City, US');
  });

  it('keeps a midnight partner delivery instant', () => {
    const data = fixture();
    const order = data.orderInfo[0]!;
    order.baseInfo.operatorTime = order.infoList[0]!.operatorTime = Date.UTC(2026, 6, 4);
    const result = parseEcmsExpress(data, NUMBER);
    expect(result.last_update).toBe('2026-07-04T00:00:00Z');
    expect(result.events![0]!.time).toBe(result.last_update);
  });

  it("keeps the day alone of a flight row at midnight sharp, and a clock a second after it", () => {
    const data = fixture();
    data.orderInfo[0]!.infoList[1]!.operatorTime = Date.UTC(2026, 6, 3);
    const result = parseEcmsExpress(data, NUMBER);
    expect(result.events![1]).toMatchObject({ local_time: '2026-07-03', provider_code: 'EVENT_314' });
    expect(result.events![1]).not.toHaveProperty('time');
    data.orderInfo[0]!.infoList[1]!.operatorTime = Date.UTC(2026, 6, 3, 0, 0, 1);
    expect(parseEcmsExpress(data, NUMBER).events![1]).toMatchObject({ local_time: '2026-07-03T00:00:01', time: '2026-07-03T00:00:01-08:00' });
  });

  it('binds the whole envelope, summary and every scan before accepting history', () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => { data.orderNumber[0] += '0'; },
      (data: ReturnType<typeof fixture>) => { data.orderInfo[0]!.baseInfo.trackingId += '0'; },
      (data: ReturnType<typeof fixture>) => { data.orderInfo[0]!.infoList[1]!.trackingId += '0'; },
    ]) {
      const data = fixture(); change(data);
      expect(() => parseEcmsExpress(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('distinguishes absence, no history, challenges, limits and malformed replies', () => {
    const noHistory = fixture(); noHistory.orderInfo[0]!.infoList = [];
    for (const [data, kind] of [
      [{ status: 200, orderNumber: [], orderInfo: [] }, 'not_found'], [noHistory, 'indeterminate'],
      [expired, 'challenge'], [{ status: 429 }, 'rate_limited'], [{ status: 200 }, 'schema'],
      [{ status: 500, orderInfo: [] }, 'indeterminate'],
    ]) expect(() => parseEcmsExpress(data, NUMBER)).toThrow(expect.objectContaining({ kind }));
    const data = fixture(); data.orderInfo[0]!.infoList[0]!.operatorTime = NaN;
    expect(() => parseEcmsExpress(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('registers the parcel on the manifest in the newer page\'s wording, without the station as its place', () => {
    const data = fixture();
    const manifest = { ...row(), eventCode: 'EVENT_104', eventDescription: 'Virtual Manifest has been received', operatorTime: Date.UTC(2026, 6, 1, 9), timeZone: 8 };
    data.orderInfo[0]!.baseInfo = manifest;
    data.orderInfo[0]!.infoList = [manifest];
    expect(parseEcmsExpress(data, NUMBER)).toMatchObject({ current_stage: 'registered',
      events: [{ provider_code: 'EVENT_104', stage: 'registered', stage_source: 'carrier_map' }] });
    expect(parseEcmsExpress(data, NUMBER).events?.[0]?.location).toBeUndefined();
  });

  it('reads the arrival warehouse, a customs hold, a return notice and a parcel held for collection by ECMS\'s map', () => {
    for (const [code, wording, stage] of [['S06N616', 'Arriving notification received from terminal', 'in_transit'],
      ['S08N800', 'Shipment has arrived at ECMS transit warehouse', 'in_transit'], ['S08N804', 'Shipment has departed from ECMS transit warehouse', 'in_transit'],
      ['S00A00009', 'Customs delay: doc / HS code issue, entry blocked', 'customs'],
      ['EVENT_20018', 'Return to origin', 'exception'], ['EVENT_308', 'Available for pickup', 'ready_for_pickup']] as const) {
      const data = fixture();
      const scan = { ...row(), eventCode: code, eventDescription: wording };
      data.orderInfo[0]!.baseInfo = scan;
      data.orderInfo[0]!.infoList = [scan];
      expect(parseEcmsExpress(data, NUMBER), code).toMatchObject({ current_stage: stage, current_stage_source: 'carrier_map',
        events: [{ provider_code: code, stage, stage_source: 'carrier_map' }] });
    }
  });

  it('reads SpeedX\'s relayed last-mile scan as in transit by ECMS\'s map', () => {
    const data = fixture();
    const scan = { ...row(), eventCode: 'S07N708', eventDescription: 'Parcel in transit during last mile delivery' };
    data.orderInfo[0]!.baseInfo = scan;
    data.orderInfo[0]!.infoList = [scan];
    expect(parseEcmsExpress(data, NUMBER)).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map',
      events: [{ provider_code: 'S07N708', stage: 'in_transit', stage_source: 'carrier_map' }] });
  });

  it('does not mislabel new wording or invent an unambiguous partner reference', () => {
    const data = fixture();
    data.orderInfo[0]!.baseInfo = { ...row(), eventCode: 'NEW', eventDescription: 'Unmapped milestone' };
    data.orderInfo[0]!.infoList.push({ ...row(), orderCode: PARTNER + '0' });
    const result = parseEcmsExpress(data, NUMBER);
    expect(result.current_stage).toBeUndefined(); expect(result.status).toBe('unknown');
    expect(result.delivery_carrier).toBe('speedx'); expect(result.delivery_tracking_number).toBeUndefined();
  });

  it('marks capped histories partial and validates scans beyond the cap', () => {
    const data = fixture(); data.orderInfo[0]!.infoList = Array.from({ length: 101 }, row);
    expect(parseEcmsExpress(data, NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseEcmsExpress(data, NUMBER).events).toHaveLength(100);
    data.orderInfo[0]!.infoList[100]!.trackingId += '0';
    expect(() => parseEcmsExpress(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('routes the existing whole-number shapes to the dedicated adapter', () => {
    for (const number of [NUMBER, 'APTEST0000000001', 'AXTESTS000000001', 'ESTST00000000001']) {
      expect(normalizeEcmsExpressNumber(number.toLowerCase())).toBe(number);
      expect(detectCarrierMatch(number).carrier).toBe('ecms-express');
    }
    expect(carrierAdapter('ecms-express')).toBe('ecms-express');
    expect(() => normalizeEcmsExpressNumber(NUMBER + '0')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('ECMS challenge exchange', () => {
  const responses = (...payloads: unknown[]) => {
    const fetcher = vi.fn<typeof fetch>();
    for (const payload of payloads) fetcher.mockResolvedValueOnce(Response.json(payload));
    return fetcher;
  };

  it('exchanges each fresh image for one sign, then consumes it once with the full number', async () => {
    const fetcher = responses(opened(), verified(), fixture(), opened('2'), verified('2'), fixture());
    const solveCaptcha = vi.fn().mockResolvedValue('8');
    const tracker = new EcmsExpressTracker({ fetcher, solveCaptcha, userAgent: 'TestHost/1' });
    await tracker.fetch(NUMBER); await tracker.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(6);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://www.ecmsglobal.com');
      expect(init?.method).toBe('POST'); expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('User-Agent')).toBe('TestHost/1');
    }
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('signKey')).toBe(opened().data.signKey);
    const lookup = new URL(String(fetcher.mock.calls[2]![0]));
    expect(lookup.searchParams.get('verifySign')).toBe(verified().data);
    expect(lookup.searchParams.get('orderNumber')).toBe(NUMBER);
    expect(new URL(String(fetcher.mock.calls[5]![0])).searchParams.get('verifySign')).toBe(verified('2').data);
    expect(solveCaptcha.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });

  it('opens a fresh challenge after a rejected answer or expired sign', async () => {
    for (const first of [[opened(), refusal], [opened(), verified(), expired]]) {
      const fetcher = responses(...first, opened('2'), verified('2'), fixture());
      const step = vi.fn(), lookup = vi.fn();
      await expect(new EcmsExpressTracker({ fetcher, solveCaptcha: async () => '7', recorder: { step, lookup } }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      const tiers = step.mock.calls.map(([record]) => record).filter(({ step }) => step === 'direct' || step === 'retry');
      expect(tiers[0]).toMatchObject({ step: 'direct', outcome: 'challenge' });
      expect(tiers[1]).toMatchObject({ step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'challenge' });
      expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok', attempts: 2 }));
      const requests = fetcher.mock.calls.map(([url]) => new URL(String(url)));
      expect(requests.filter(url => url.pathname.endsWith('/get/base64'))).toHaveLength(2);
      expect(requests.filter(url => url.pathname.endsWith('/check')).at(-1)!.searchParams.get('signKey')).toBe(opened('2').data.signKey);
    }
  });

  it('caps each request so one that hangs leaves a fresh challenge time, and records each request', async () => {
    const hung: typeof fetch = (_url, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    });
    const retried = ['2:challenge:ok', '2:solve:ok', '2:check:ok', '2:history:ok', '2:retry:ok'];
    for (const [answered, first] of [
      [[], ['1:challenge:transport', '1:direct:transport']],
      [[opened(), verified()], ['1:challenge:ok', '1:solve:ok', '1:check:ok', '1:history:transport', '1:direct:transport']],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>();
      for (const payload of answered) fetcher.mockResolvedValueOnce(Response.json(payload));
      fetcher.mockImplementationOnce(hung);
      for (const payload of [opened('2'), verified('2'), fixture()]) fetcher.mockResolvedValueOnce(Response.json(payload));
      const step = vi.fn(), lookup = vi.fn();
      const tracker = new EcmsExpressTracker({ fetcher, solveCaptcha: async () => '7', recorder: { step, lookup } });
      await expect(tracker.fetch(NUMBER, { budgetMs: 1_000 })).resolves.toMatchObject({ status: 'delivered' });
      const records = step.mock.calls.map(([record]) => record);
      expect(records.map(({ step, attempt, outcome }) => `${attempt}:${step}:${outcome}`)).toEqual([...first, ...retried]);
      expect(records.find(({ outcome }) => outcome === 'transport')).toMatchObject({ errorType: 'UpstreamNetworkError' });
      expect(records.at(-1)).toMatchObject({ fallbackFrom: 'direct', fallbackReason: 'transport' });
      expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok', attempts: 2 }));
    }
  });

  it('bounds unreadable and rejected challenges and does not retry unrelated failures', async () => {
    const unreadable = responses(opened(), opened('2'));
    await expect(new EcmsExpressTracker({ fetcher: unreadable, solveCaptcha: async () => '' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(unreadable).toHaveBeenCalledTimes(2);
    const rejected = responses(opened(), refusal, opened('2'), refusal);
    await expect(new EcmsExpressTracker({ fetcher: rejected, solveCaptcha: async () => '7' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(rejected).toHaveBeenCalledTimes(4);
    for (const [payload, kind] of [[{ status: 429 }, 'rate_limited'], [{ status: 200 }, 'schema'], [{ status: 500, message: 'backend unavailable' }, 'indeterminate']]) {
      const fetcher = responses(opened(), payload);
      await expect(new EcmsExpressTracker({ fetcher, solveCaptcha: async () => '7' }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('keeps HTML challenges and malformed JSON distinct and strips verification diagnostics', async () => {
    for (const [body, status, kind] of [['<html>PRIVATE</html>', 200, 'challenge'], ['{"PRIVATE":', 200, 'schema'], ['PRIVATE', 503, 'maintenance']] as const) {
      const fetcher = responses(opened(), verified());
      fetcher.mockResolvedValueOnce(new Response(body, { status }));
      const step = vi.fn();
      const error = await new EcmsExpressTracker({ fetcher, solveCaptcha: async () => '7', recorder: { step, lookup: vi.fn() } }).fetch(NUMBER).catch(error => error);
      expect(error.kind).toBe(kind);
      const history = step.mock.calls.map(([record]) => record).find(({ step }) => step === 'history');
      expect(history).toMatchObject({ outcome: kind });
      for (const failed of [error, history.error]) {
        expect(failed.request_url).toBeUndefined(); expect(failed.response_body).toBeUndefined();
        expect(JSON.stringify(failed)).not.toContain('PRIVATE'); expect(JSON.stringify(failed)).not.toContain(verified().data);
      }
    }
  });

  it('shares the deadline with OCR and stops before consuming a sign when cancelled', async () => {
    const controller = new AbortController();
    const fetcher = responses(opened());
    const solveCaptcha = vi.fn(async (_bytes: Uint8Array, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false); controller.abort(new Error('cancelled')); return '7';
    });
    await expect(new EcmsExpressTracker({ fetcher, solveCaptcha }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const stalled = new EcmsExpressTracker({ fetcher: responses(opened()), solveCaptcha: (_bytes, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    await expect(stalled.fetch(NUMBER, { budgetMs: 40 })).rejects.toMatchObject({ kind: 'budget' });
  });
});
