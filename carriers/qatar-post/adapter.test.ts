import { afterEach, describe, expect, it, vi } from 'vitest';
import { QatarPostTracker, QATAR_GUEST_TRACKING } from './adapter.js';
import { qatarGuestTimestamp, qatarGuestToken } from './guest.js';
import { normalizeQatarPostNumber, parseQatarPost, parseQatarPostResponse } from './parser.js';
import { deliveryHandoff, hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';

const NUMBER = 'RH904826153GB', OTHER = 'RH904826153QA';
const scan = (event_code = 'QPS0288', event_name_en = 'Picked up by Customer', date_time = '06/07/2026 10:20:30') => ({
  event_code, event_name_en, event_name_ar: '', date_time, branch: 'Example Branch', expected_time: date_time,
  visible_digital_channel: 'false', remarks: 'PRIVATE CONTACT', source: 'QPS',
});
const fixture = () => ({ trackingNumber: NUMBER, orderAWBNumber: NUMBER, customerName: 'PRIVATE', customerMobileNumber: 'PRIVATE',
  receiverAddress: { street: 'PRIVATE' }, paymentBankReferenceNumber: 'PRIVATE', expectedDeliveryDate: 'PRIVATE', currentStatus: {
    currentStatusCode: 22, currentStatusDescription: 'Counter Delivery Success', currentStatusCategory: 'Delivered',
  }, otherDetails: { response: [{ line_item_dtls: { tracking_number: NUMBER, signatory_name: 'PRIVATE' }, total_count: 3,
    track_trace_details: [
      { ...scan('EDI0008', 'Dispatched to Destination Country', '06/05/2026 19:20:30'), branch: 'GBSYNTH' },
      scan('QPS0063', 'Item Returned to customs', '06/06/2026 09:00:00'), scan(),
    ],
  }] } });
afterEach(() => { vi.useRealTimers(); });

describe('Qatar Post guest history', () => {
  it('binds all identities, retains invisible-channel scans and overseas wall clocks, and drops private extras', () => {
    const result = parseQatarPost(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-06-07T10:20:30', last_status_text: 'Counter Delivery Success', provider_code: '22' });
    expect(result.events).toHaveLength(3);
    expect(result.events?.[1]).toMatchObject({ stage: 'customs', provider_code: 'QPS0063' });
    expect(result.events?.[2]).toMatchObject({ location: 'GBSYNTH', local_time: '2026-06-05T19:20:30' });
    expect(result.events?.every(e => !e.time)).toBe(true);
    expect(result).not.toHaveProperty('expected_delivery'); expect(result).not.toHaveProperty('history_truncated');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('requires both root identities and one unique whole-number nested record', () => {
    for (const mutate of [
      (d: ReturnType<typeof fixture>) => { d.trackingNumber = OTHER; },
      (d: ReturnType<typeof fixture>) => { d.orderAWBNumber = OTHER; },
      (d: ReturnType<typeof fixture>) => { d.otherDetails.response[0]!.line_item_dtls.tracking_number = OTHER; },
      (d: ReturnType<typeof fixture>) => { d.otherDetails.response.push(d.otherDetails.response[0]!); },
    ]) { const d = fixture(); mutate(d); expect(() => parseQatarPost(d, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' })); }
    const d = fixture(), unrelated = structuredClone(d.otherDetails.response[0]!); unrelated.line_item_dtls.tracking_number = OTHER;
    d.otherDetails.response.unshift(unrelated); expect(parseQatarPost(d, NUMBER).events).toHaveLength(3);
  });

  it('marks missing or capped history and summary disagreement incomplete', () => {
    const d = fixture(); d.otherDetails.response[0]!.total_count = 4;
    expect(parseQatarPost(d, NUMBER).history_truncated).toBe(true);
    d.otherDetails.response[0]!.total_count = 3; d.otherDetails.response[0]!.track_trace_details.pop(); d.otherDetails.response[0]!.total_count = 2;
    expect(parseQatarPost(d, NUMBER)).toMatchObject({ current_stage: 'delivered', history_truncated: true });
    const many = fixture(); many.otherDetails.response[0]!.track_trace_details = Array.from({ length: 101 }, (_, i) => ({ ...scan(), branch: `Example Branch ${i}` }));
    many.otherDetails.response[0]!.total_count = 101; expect(parseQatarPost(many, NUMBER).events).toHaveLength(100); expect(parseQatarPost(many, NUMBER).history_truncated).toBe(true);
  });

  it('refuses malformed dates, counts and scan identities, and keeps an empty history inconclusive', () => {
    for (const mutate of [
      (d: ReturnType<typeof fixture>) => { d.otherDetails.response[0]!.track_trace_details[0]!.date_time = '02/30/2026 10:00:00'; },
      (d: ReturnType<typeof fixture>) => { d.otherDetails.response[0]!.total_count = 2; },
      (d: ReturnType<typeof fixture>) => { d.otherDetails.response[0]!.track_trace_details[0]!.event_code = ''; },
    ]) { const d = fixture(); mutate(d); expect(() => parseQatarPost(d, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' })); }
    const empty = fixture(); empty.otherDetails.response[0]!.track_trace_details = []; empty.otherDetails.response[0]!.total_count = 0;
    expect(() => parseQatarPost(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts only the exact number-bound 404 and separates guest rejection, WAF and malformed replies', () => {
    expect(() => parseQatarPostResponse(`Order with tracking number : ${NUMBER} Does not exist`, 404, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseQatarPostResponse(`Order with tracking number : ${OTHER} Does not exist`, 404, NUMBER)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseQatarPostResponse(JSON.stringify({ message: 'Invalid token' }), 400, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseQatarPostResponse('<h1>Request Rejected</h1>', 200, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseQatarPostResponse('Forbidden', 403, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseQatarPostResponse('{}', 200, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeQatarPostNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    expect(() => normalizeQatarPostNumber(NUMBER + '9')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('Qatar Post guest transport and routing', () => {
  it('constructs the app UTC timestamp with minute before month and mints a bounded header', () => {
    const at = new Date('2026-07-04T09:08:06Z'); expect(qatarGuestTimestamp(at)).toBe('08|2026|06|04|07|09');
    const token = qatarGuestToken(at); expect(token).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); expect(token.length).toBeLessThan(1024);
    expect(qatarGuestToken(new Date('2026-07-04T09:08:07Z'))).not.toBe(token);
  });

  it('uses the supplied HTTP transport, caller UA, fresh guest header and a whole path identifier', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(QATAR_GUEST_TRACKING + NUMBER); const headers = new Headers(init?.headers);
      expect(headers.get('Platform')).toBe('Mobile'); expect(headers.get('Guest-API-Token')).toBeTruthy(); expect(headers.get('User-Agent')).toBe('host-agent');
      expect(init?.signal).toBeInstanceOf(AbortSignal); return Response.json(fixture());
    }) as unknown as typeof fetch;
    expect((await new QatarPostTracker({ fetcher, userAgent: 'host-agent' }).fetch(NUMBER)).events).toHaveLength(3); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('regenerates the header on a network retry, preserves rate limits and omits private request diagnostics', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-07-04T09:08:06Z')); const tokens: string[] = [];
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get('Guest-API-Token')!);
      if (tokens.length === 1) { vi.setSystemTime(new Date('2026-07-04T09:08:07Z')); throw new TypeError('offline'); }
      return Response.json(fixture());
    }) as unknown as typeof fetch;
    await new QatarPostTracker({ fetcher }).fetch(NUMBER); expect(tokens).toHaveLength(2); expect(tokens[0]).not.toBe(tokens[1]);
    vi.useRealTimers();
    const limited = vi.fn(async () => new Response('PRIVATE', { status: 429, headers: { 'Retry-After': '60' } })) as unknown as typeof fetch;
    try { await new QatarPostTracker({ fetcher: limited }).fetch(NUMBER); throw new Error('expected refusal'); }
    catch (error) { expect(error).toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 }); expect(JSON.stringify(error)).not.toContain('Guest-API-Token'); expect(JSON.stringify(error)).not.toContain('PRIVATE'); }
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it('does not claim foreign postal issuers, and offers Qatar only as a confirmed-destination handoff candidate', () => {
    expect(detectCarrierMatch(NUMBER).carrier).not.toBe('qatar-post');
    expect(recognitionAskedCarriers(NUMBER, { hint: 'qatar-post' })).not.toContain('qatar-post');
    expect(deliveryHandoff('royal-mail', NUMBER, { destination_country: 'QA' })).toEqual({ carrier: 'qatar-post', number: NUMBER, basis: 'destination' });
    expect(deliveryHandoff('royal-mail', NUMBER, {}, 'QA')?.carrier).toBe('qatar-post');
    expect(hasDirectHandoffAdapter('qatar-post', 'LOCAL12345')).toBe(false);
  });

  it('cancels before any request', async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn();
    await expect(new QatarPostTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
});
