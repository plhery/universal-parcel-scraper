import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { OmLogisticsTracker, OM_ENDPOINT } from './adapter.js';
import { normalizeOmNumber, omChallenge, omJson, omSummary, parseOm } from './parser.js';
import { statusMap } from './status.js';

const NUMBER = '1234567890123';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const image = (text = 'A2b4C') => ({ image: 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg">' + [...text].map((c, i) => `<text x="${10 + i * 20}">${c}</text>`).join('') + '</svg>') });

function mockFlow(values: unknown[], status = 200) {
  const calls: { url: URL; cookie: string | null; signal?: AbortSignal | null }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const index = calls.length;
    calls.push({ url: new URL(input instanceof Request ? input.url : String(input)), cookie: new Headers(init?.headers).get('cookie'), signal: init?.signal });
    return Object.defineProperty(new Response(JSON.stringify(values[index]), { status: index ? status : 200,
      headers: { 'content-type': 'application/json', ...(index === 0 ? { 'set-cookie': 'guest=fixture; Path=/; Secure; HttpOnly' } : {}) } }), 'url', { value: String(input) });
  });
  return { fetcher: fetcher as typeof fetch, calls };
}

describe('Om Logistics guest form', () => {
  it('reads positioned SVG glyphs, preserving case and numeric zero', () => {
    expect(omChallenge(image('a0B2c'))).toBe('a0B2c');
    expect(() => omChallenge({ image: 'data:image/png;base64,invalid' })).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => omChallenge(image('1234'))).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => omChallenge(image('123456'))).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => omChallenge({ image: 'data:image/svg+xml;utf8,%ZZ' })).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('validates whole numeric identity without removing leading zeroes or internal separators', () => {
    expect(normalizeOmNumber(' 0012345678 ')).toBe('0012345678');
    for (const value of ['123', '12345678901234', '1234 5678', '12345678-0', 'ABC12345678']) {
      expect(() => normalizeOmNumber(value)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
    for (const row of [{ CNNO: '12345678' }, { CNNO: NUMBER, CNNNO: '00000000' }, {}]) {
      expect(() => omSummary({ error: false, cn_enquiry: [row] }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('keeps the five source scans, date precision and contradictory summary clock separate', () => {
    const result = parseOm(fixture.summary, fixture.history, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-01-04', service_name: 'SURFACE' });
    expect(result.events).toHaveLength(5);
    expect(result.events!.map(event => event.local_time)).toEqual(['2026-01-04', '2026-01-04T15:10:00', '2026-01-03T13:10:00', '2026-01-02T06:44:00', '2026-01-01']);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted']);
    expect(result.events!.every(event => !event.time && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-document|private-invoice|CN_TRANSIT_STATUS|03:10:00/);
    expect(result.destination_country).toBeUndefined();
  });

  it('rejects malformed dates, unfamiliar rows and empty histories without claiming not-found', () => {
    for (const out of ['31-FEB-2026', '01-JAN-2026 00:10AM', '01-JAN-2026 13:10PM', '01-JAN-2026 03:99PM', '01-JAN-1999']) {
      const history = structuredClone(fixture.history); history.cn_enquiry_detail[0].OUT_DATE = out;
      expect(() => parseOm(fixture.summary, history, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseOm(fixture.summary, { error: false, cn_enquiry_detail: [{}] }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOm(fixture.summary, { error: false, cn_enquiry_detail: [] }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => omSummary({ error: true }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => omJson('<html>Access Denied</html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => omJson('{"error":true,"message":"Incorrect Captcha verification code."}')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('performs only the three official requests with a fresh guest session and whole query', async () => {
    const { fetcher, calls } = mockFlow([image(), fixture.summary, fixture.history]);
    const result = await new OmLogisticsTracker({ fetcher }).fetch(NUMBER);
    expect(result.events).toHaveLength(5);
    expect(calls.map(call => call.url.searchParams.get('type'))).toEqual(['captcha', 'enquiry', 'details']);
    expect(calls.every(call => call.url.origin + call.url.pathname === OM_ENDPOINT)).toBe(true);
    expect(calls[0]!.cookie).toBeNull();
    for (const call of calls.slice(1)) {
      expect(call.cookie).toBe('guest=fixture'); expect(call.url.searchParams.get('cn_no')).toBe(NUMBER);
      expect(call.url.searchParams.get('captcha_input')).toBe('A2b4C'); expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    await new OmLogisticsTracker({ fetcher: mockFlow([image(), fixture.summary, fixture.history]).fetcher }).fetch(NUMBER);
  });

  it('never asks for unbound history after a wrong identity or an inconclusive empty result', async () => {
    for (const summary of [{ error: true }, { error: false, cn_enquiry: [{ CNNO: '9999999999999' }] }]) {
      const { fetcher, calls } = mockFlow([image(), summary]);
      await expect(new OmLogisticsTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(calls).toHaveLength(2);
    }
  });

  it('preserves verification, rate limits, network markers and cancellation without session diagnostics', async () => {
    const blocked = mockFlow([image(), { error: true, message: 'Incorrect Captcha verification code.' }], 400);
    await expect(new OmLogisticsTracker({ fetcher: blocked.fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', reason: 'verification_rejected' });
    const limited = mockFlow([image(), {}], 429);
    await expect(new OmLogisticsTracker({ fetcher: limited.fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    const controller = new AbortController(); controller.abort();
    const never = vi.fn(); await expect(new OmLogisticsTracker({ fetcher: never }).fetch(NUMBER, { signal: controller.signal })).rejects.toBeDefined();
    expect(never).not.toHaveBeenCalled();
    const failed = vi.fn(async () => { throw new TypeError('guest=fixture captcha_input=SECRET'); });
    try { await new OmLogisticsTracker({ fetcher: failed }).fetch(NUMBER); throw new Error('expected failure'); }
    catch (error) { expect(error).toMatchObject({ kind: 'transport' }); expect(JSON.stringify(error)).not.toMatch(/fixture|SECRET/); }
  });

  it('does not treat numeric dispatch fields as status codes', () => {
    expect(statusMap.stage('5', 'OUT FOR DELIVERY')).toBeUndefined();
    expect(statusMap.stage(null, 'OUT FOR DELIVERY')).toBe('out_for_delivery');
    expect(statusMap.stage(null, 'Delivered')).toBeUndefined();
  });

  it('allows only supported named handoff references without claiming shared numeric issuer shapes', () => {
    expect(hasDirectHandoffAdapter('om-logistics', NUMBER)).toBe(true);
    expect(hasDirectHandoffAdapter('om-logistics', '12345678')).toBe(true);
    expect(hasDirectHandoffAdapter('om-logistics', 'RR000000005IN')).toBe(false);
    expect(hasDirectHandoffAdapter('om-logistics', '12345678901234')).toBe(false);
    expect(detectCarrierMatch(NUMBER).carrier).not.toBe('om-logistics');
  });
});
