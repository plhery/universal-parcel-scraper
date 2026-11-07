import { describe, expect, it, vi } from 'vitest';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter, CostcoLogisticsTracker } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import absent from './fixtures/not-found.json' with { type: 'json' };
import { COSTCO_API, COSTCO_MAX_BYTES, costcoTrackingUrl, normalizeCostcoLogisticsNumber, parseCostcoLogistics, parseCostcoLogisticsBody } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '1I20260907000000017', OTHER = '1I20260907000000029';
const SERVICE = 'https://trawl.invalid';
const API = COSTCO_API + NUMBER, PAGE = costcoTrackingUrl(NUMBER);
const fixture = () => structuredClone(delivered);
const capture = (body: unknown = fixture(), extra: Record<string, unknown> = {}) => ({
  url: API, status: 200, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' }, ...extra,
});
const response = (captures: unknown[] = [capture()], extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  url: PAGE, statusCode: 200, tier: 3, html: '<html>Rendered page is not a tracking reply</html>', capturedResponses: captures, ...extra,
}), { headers: { 'Content-Type': 'application/json' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: new TrawlClient(SERVICE), recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
const withGroups = (groups: unknown) => {
  const payload = fixture();
  return { ...payload, serviceResponse: { ...payload.serviceResponse, trackingDetails: [{ ...payload.serviceResponse.trackingDetails[0], orderDetailList: groups }] } };
};

describe('Costco Logistics browser tracking', () => {
  it('keeps all milestones, current wording and local clocks without recipient or scheduling fields', () => {
    const result = parseCostcoLogistics(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-09-11T13:04:00', expected_delivery: null });
    expect(result.events).toHaveLength(6);
    expect(result.events!.map(event => [event.local_time, event.stage])).toEqual([
      ['2026-09-11T13:04:00', 'delivered'], ['2026-09-10T07:45:00', 'out_for_delivery'],
      ['2026-09-09T10:30:00', 'in_transit'], ['2026-09-08T12:15:00', 'in_transit'],
      ['2026-09-07T00:00:00', 'registered'], ['2026-09-07T00:00:00', 'registered'],
    ]);
    expect(result.events!.every(event => !event.time && !event.location && !event.provider_code)).toBe(true);
    const text = JSON.stringify(result);
    for (const secret of [NUMBER, 'Synthetic', 'Depot Road', '202-555', '00000', 'scheduling', 'appointment']) expect(text).not.toContain(secret);
    expect(result.events![1]!.description).toBe('Out for Delivery');
    expect(result.events![2]!.description).toBe('Arrived at Costco Delivery Center');
    expect(result.delivered_at).toBeUndefined();
  });

  it('orders and deduplicates identical scans, keeping the source order of ties', () => {
    const groups = fixture().serviceResponse.trackingDetails[0]!.orderDetailList.reverse();
    groups.push(structuredClone(groups.at(-1)!));
    const result = parseCostcoLogistics(withGroups(groups), NUMBER);
    expect(result.events).toHaveLength(6);
    expect(result.events!.slice(-2).map(event => event.description)).toEqual(['Processing Order', 'Order Placed']);
  });

  it('keeps an unseen latest wording without reusing an older delivered stage', () => {
    const groups = fixture().serviceResponse.trackingDetails[0]!.orderDetailList;
    groups[0]!.orderList[0]!.resultStatus = 'New carrier wording';
    expect(parseCostcoLogistics(withGroups(groups), NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'New carrier wording' });
    expect(parseCostcoLogistics(withGroups(groups), NUMBER).current_stage).toBeUndefined();
  });

  it.each(statuses.entries)('maps the observed wording $wording', entry => {
    expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
  });

  it.each([OTHER, NUMBER + '9', NUMBER.slice(0, -1)])('rejects a mismatching detail identifier', number => {
    const p = fixture(); p.serviceResponse.trackingDetails[0]!.trackingNumber = number;
    expect(() => parseCostcoLogistics(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('requires the complete number in both identities and one detail only', () => {
    for (const trackingNumbers of [[OTHER], [], [NUMBER, OTHER]]) {
      const p = fixture(); p.serviceResponse.trackingNumbers = trackingNumbers;
      expect(() => parseCostcoLogistics(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const p = fixture(); p.serviceResponse.trackingDetails.push(structuredClone(p.serviceResponse.trackingDetails[0]!));
    expect(() => parseCostcoLogistics(p, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts only the exact observed negative envelope', () => {
    expect(() => parseCostcoLogistics(absent, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const value of [
      { ...absent, status: { statusCode: '98', statusMessage: 'ERROR' } },
      { ...absent, status: { statusCode: '99', statusMessage: 'NODATAFOUND' } },
      { ...absent, serviceResponse: fixture().serviceResponse },
      { ...absent, errorDetails: 'Unavailable' },
    ]) expect(() => parseCostcoLogistics(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCostcoLogistics(withGroups([]), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each([
    [{ date: '02/30/26', orderList: [{ time: '1:04 pm', resultStatus: 'Delivery Completed' }] }],
    [{ date: '09/11/26', orderList: [{ time: '13:04 pm', resultStatus: 'Delivery Completed' }] }],
    [{ date: '09/11/26', orderList: [{ time: '1:04', resultStatus: 'Delivery Completed' }] }],
    [{ date: '09/11/26', orderList: [{ time: '1:04 pm', status: 'Delivery Complete' }] }],
    [{ date: '09/11/26', orderList: [null] }], [null], {},
  ].map(groups => ({ groups })))('rejects malformed or incomplete history %#', ({ groups }) => {
    expect(() => parseCostcoLogistics(withGroups(groups), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an HTTP 200 verification page and malformed JSON distinct', () => {
    expect(() => parseCostcoLogisticsBody('<title>Human Verification</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseCostcoLogisticsBody('{broken', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not treat an unused passive-script address as a challenge, and strips names from scan wording', () => {
    const p = fixture();
    p.serviceResponse.trackingDetails[0]!.showLink = 'https://example.invalid/challenge-platform';
    p.serviceResponse.trackingDetails[0]!.orderDetailList[0]!.orderList[0]!.resultStatus = 'Delivery Completed signed by Synthetic Recipient';
    const result = parseCostcoLogisticsBody(JSON.stringify(p), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivery Completed' });
    expect(JSON.stringify(result)).not.toContain('Synthetic');
  });

  it('uses one exact guest page and capture URL through the supplied transport and recorder', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CostcoLogisticsTracker({ fetcher, trawl: new TrawlClient(SERVICE), recorder }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SERVICE + '/scrape');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init!.body))).toMatchObject({ url: PAGE, skipHttp: true, maxTier: 3, maxTimeout: 30_000, captureResponses: [API] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('retains a final rejection after an earlier success and a final success after verification', async () => {
    const denied = capture('Denied', { status: 403 });
    let fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([capture(), denied]));
    await expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([denied, capture()]));
    await expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('accepts the official no-records fragment with the unchanged whole query and exact negative reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([capture(absent)], { url: PAGE + '#norecords' }));
    await expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([OTHER, NUMBER + '9'])('ignores a different whole request URL', number => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([capture(absent, { url: COSTCO_API + number })]));
    return expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([{ truncated: true }, { error: 'failed' }, { base64Encoded: true }, { body: null }])('rejects incomplete captures %#', extra => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([capture(fixture(), extra)]));
    return expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([401, 403, 404, 429, 503])('keeps captured HTTP %s separate from parcel absence', status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([capture(absent, { status, headers: { 'Retry-After': '120' } })]));
    return expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER)).rejects.toMatchObject({
      kind: [401, 403].includes(status) ? 'challenge' : status === 429 ? 'rate_limited' : status === 503 ? 'maintenance' : 'transport',
      ...(status === 429 ? { retryAfterMs: 120_000 } : {}),
    });
  });

  it.each([{ url: costcoTrackingUrl(OTHER) }, { tier: 1 }, { url: undefined }, { url: PAGE + '#other' }, { url: costcoTrackingUrl(OTHER) + '#norecords' }])('requires the requested browser page %#', extra => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([capture()], extra));
    return expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('bounds capture counts and bytes', async () => {
    for (const captures of [Array.from({ length: 11 }, () => capture()), [capture(' '.repeat(COSTCO_MAX_BYTES + 1))]]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(captures));
      await expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER)).rejects.toMatchObject({ kind: captures.length > 1 ? 'transport' : 'schema' });
    }
  });

  it('adds no recognition sessions for the existing distinctive series', () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const a = adapter(environment(fetcher));
    expect(a.recognize).toBeUndefined();
    expect(a.recognizeWithBrowser).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes the existing id and high-confidence series natively with providers disabled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'costco-logistics', confidence: 'high' });
    expect(parseTrackingInput(PAGE)).toMatchObject({ carrier: 'costco-logistics', trackingNumber: NUMBER });
    expect(hasDirectHandoffAdapter('costco-logistics', NUMBER)).toBe(true);
    for (const other of ['123456789', '1234567890', 'LO100000017GB']) expect(hasDirectHandoffAdapter('costco-logistics', other)).toBe(false);
    await expect(createTracker({ providers: [], trawlUrl: SERVICE, fetcher }).track({ number: NUMBER }))
      .resolves.toMatchObject({ carrier: 'costco-logistics', source: 'costco-logistics', result: { status: 'delivered' } });
  });

  it('does not start work without the service or sufficient budget, or after cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new CostcoLogisticsTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController(); controller.abort(new Error('Cancelled'));
    await expect(new CostcoLogisticsTracker(environment(fetcher)).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of ['123456789', NUMBER + '9']) expect(() => normalizeCostcoLogisticsNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});
