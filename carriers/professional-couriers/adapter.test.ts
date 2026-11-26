import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { ProfessionalCouriersTracker } from './adapter.js';
import {
  normalizeProfessionalCouriersNumber, parseProfessionalCouriers, professionalCouriersDetailsFields, professionalCouriersVerifyFields,
  TPC_GATE, TPC_HOME, TPC_TRACK,
} from './parser.js';
import { statusMap } from './status.js';

// The public sample in numbers.json whose reply the fixtures keep, and a synthetic number.
const DELIVERED = 'KNP507956665';
const UNKNOWN = 'KNP999999990';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PICTURE = readFileSync(new URL('./fixtures/captcha-9C8L2.png', import.meta.url));
const SEARCH = 'ctl00$ctl00$ContentPlaceHolderForTop$ContentPlaceHolderQuickLinkForTop$';
const DETAILS = 'ctl00$ctl00$ContentPlaceHolderMid$ContentPlaceHolder2$';

function answer(target: string, body: BodyInit | null, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  // The cookie jar files a cookie under the address that answered.
  Object.defineProperty(response, 'url', { value: target });
  return response;
}
const moved = (target: string, location: string, cookie?: string) =>
  answer(target, null, { status: 302, headers: { Location: location, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });

/** A tracker that keeps the consignment in its session and accepts one captcha code. */
function site(options: { summary?: string; accepted?: string; details?: string } = {}) {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    const headers = new Headers(init?.headers);
    const form = new URLSearchParams(init?.body ? String(init.body) : '');
    if (target === TPC_HOME && !init?.method) return answer(target, page('home.html'));
    if (target === TPC_HOME && init?.method === 'POST') {
      expect(form.get('__EVENTTARGET')).toBe(`${SEARCH}Button1`);
      expect(form.get('__VIEWSTATE')).toBe('synthetic-viewstate-home');
      if (form.get(`${SEARCH}TextBox1`)!.startsWith('ABC')) return answer(target, page('invalid-number.html'));
      return moved(target, '/CaptchaGate.aspx', 'ASP.NET_SessionId=synthetic; path=/; HttpOnly');
    }
    expect(headers.get('cookie')).toBe('ASP.NET_SessionId=synthetic');
    if (target === TPC_GATE && !init?.method) return answer(target, page('captcha.html'));
    if (target.startsWith('https://www.tpcindia.com/CaptchaImage.ashx?r=')) {
      expect(headers.get('referer')).toBe(TPC_GATE);
      return answer(target, PICTURE, { headers: { 'Content-Type': 'image/png' } });
    }
    if (target === TPC_GATE && init?.method === 'POST') {
      expect(form.get('btnVerify')).toBe('Submit');
      if (form.get('txtCaptcha') !== (options.accepted ?? '9C8L2')) return answer(target, page('captcha-refused.html'));
      return moved(target, '/Track-info.aspx');
    }
    if (target === TPC_TRACK && !init?.method) return answer(target, page(options.summary ?? 'summary.html'));
    if (target === TPC_TRACK && form.get('__EVENTTARGET') === `${DETAILS}Button8`) return answer(target, options.details ?? page('verify.html'));
    if (target === TPC_TRACK && form.get('__EVENTTARGET') === `${DETAILS}btnVerify4` && form.get(`${DETAILS}txtLast4`) === '1234') {
      return answer(target, page('delivered.html'));
    }
    return moved(target, '/Oops.aspx?aspxerrorpath=/Track-info.aspx');
  });
  return fetcher;
}

describe('The Professional Couriers guest adapter', () => {
  it('passes the captcha and the printed code in one session and reads the whole history', async () => {
    const fetcher = site();
    const tracker = new ProfessionalCouriersTracker({ fetcher, userAgent: 'SyntheticHost/1' });
    try {
      const result = await tracker.fetch(` ${DELIVERED.toLowerCase()} `, { budgetMs: 20_000 });
      expect(fetcher).toHaveBeenCalledTimes(8);
      expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
        last_update_local: '2026-07-10T13:43:00', last_status_text: 'Delivered - Area : SARJAPURA' });
      expect(result.events).toHaveLength(14);
    } finally { await tracker.close(); }
  }, 30_000);

  it('keeps station wall clocks and puts a receipt at the station that received it', () => {
    const result = parseProfessionalCouriers(page('delivered.html'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-07-10T13:43:00', 'Delivered', 'Delivered - Area : SARJAPURA', 'BENGALURU SOUTH', 'delivered'],
      ['2026-07-10T09:41:00', 'Out for Delivery', 'Out for Delivery - Area : NARAYANA HRUDAYALAYA', 'BENGALURU SOUTH', 'out_for_delivery'],
      ['2026-07-09T20:19:00', 'Received at', 'Received at BENGALURU SOUTH-BENGALURU SOUTH', 'BENGALURU SOUTH', 'in_transit'],
      ['2026-07-09T11:26:00', 'Misroute', 'Misroute - Area : SARJAPURA', 'BENGALURU SOUTH', 'in_transit'],
      ['2026-07-09T09:56:00', 'Despatched to', 'Despatched to BENGALURU SOUTH-SARJAPURA', 'BENGALURU SOUTH', 'in_transit'],
      ['2026-07-09T06:48:00', 'Received at', 'Received at BENGALURU SOUTH-BENGALURU SOUTH', 'BENGALURU SOUTH', 'in_transit'],
      ['2026-07-08T23:58:00', 'Bag Despatched to', 'Bag Despatched to BENGALURU', 'CHENNAI', 'in_transit'],
      ['2026-07-08T23:07:00', 'Bag Despatched to', 'Bag Despatched to BENGALURU', 'CHENNAI', 'in_transit'],
      ['2026-07-08T16:31:00', 'Despatched to', 'Despatched to CHENNAI-MADURAVOYAL HUB OFFICE', 'CHENNAI', 'in_transit'],
      ['2026-07-08T13:39:00', 'Received at', 'Received at CHENNAI', 'CHENNAI', 'in_transit'],
      ['2026-07-04T22:07:00', 'Despatched to', 'Despatched to CHENNAI', 'KANPUR', 'in_transit'],
      ['2026-07-04T20:03:00', 'Received at', 'Received at KANPUR-KANPUR', 'KANPUR', 'in_transit'],
      ['2026-07-04T20:02:00', 'Received at', 'Received at KANPUR-KANPUR', 'KANPUR', 'in_transit'],
      ['2026-07-04T05:36:00', 'Booking Completed', 'Booking Completed', 'KANPUR', 'accepted'],
    ]);
    expect(result.events!.every(event => !event.time)).toBe(true);
  });

  it('asks for another picture after a refused or unreadable answer, and stops after three', async () => {
    const solveCaptcha = vi.fn().mockResolvedValueOnce('ABCDE').mockResolvedValueOnce('9C8L').mockResolvedValue('9C8L2');
    const fetcher = site();
    const result = await new ProfessionalCouriersTracker({ fetcher, solveCaptcha }).fetch(DELIVERED, { budgetMs: 20_000 });
    expect(result.status).toBe('delivered');
    // The four-character reading is not sent.
    expect(fetcher.mock.calls.filter(([url, init]) => String(url) === TPC_GATE && init?.method === 'POST')).toHaveLength(2);
    const refused = site({ accepted: 'NONE' });
    await expect(new ProfessionalCouriersTracker({ fetcher: refused, solveCaptcha: async () => '9C8L2' }).fetch(DELIVERED, { budgetMs: 30_000 }))
      .rejects.toMatchObject({ kind: 'challenge', message: expect.stringContaining('refused every captcha answer') });
    expect(refused.mock.calls.filter(([url, init]) => String(url) === TPC_GATE && init?.method === 'POST')).toHaveLength(3);
  });

  it("reports TPC's answer for an unknown consignment as not found and requires the whole number", async () => {
    const fetcher = site({ summary: 'not-found.html' });
    await expect(new ProfessionalCouriersTracker({ fetcher, solveCaptcha: async () => '9C8L2' }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(new ProfessionalCouriersTracker({ fetcher: site(), solveCaptcha: async () => '9C8L2' }).fetch('ABC999999999'))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect(() => professionalCouriersDetailsFields(page('summary.html'), 'KNP507956666')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseProfessionalCouriers(page('delivered.html'), 'KNP507956666')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseProfessionalCouriers(page('delivered.html').replace('Jul 10 2026', 'Jul 32 2026'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseProfessionalCouriers('<html><body><form>maintenance</form></body></html>', DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['KNP5079566', 'KNP5079566650', '507956665', 'KN507956665']) {
      expect(() => normalizeProfessionalCouriersNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('reads the code from the page and stops when the page no longer prints one', async () => {
    expect(professionalCouriersVerifyFields(page('verify.html'))!.get(`${DETAILS}txtLast4`)).toBe('1234');
    expect(professionalCouriersVerifyFields(page('delivered.html'))).toBeNull();
    const hidden = page('verify.html').replace(/Enter the 4-digit code[\s\S]*?<\/strong> or <strong>0000<\/strong>/, 'Enter the last four digits of your mobile number');
    await expect(new ProfessionalCouriersTracker({ fetcher: site({ details: hidden }), solveCaptcha: async () => '9C8L2' }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'challenge', message: expect.stringContaining('does not print') });
    expect(() => parseProfessionalCouriers(page('verify.html'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseProfessionalCouriers('<html><title>Just a moment...</title><form></form></html>', DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
      await expect(new ProfessionalCouriersTracker({ fetcher, solveCaptcha: async () => '9C8L2' }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the opening phrases, also as universal providers relay them, and leaves others without a stage', () => {
    expect(statusMap.stage('Delivered', '')).toBe('delivered');
    expect(statusMap.stage(null, 'bag despatched to bengaluru')).toBe('in_transit');
    expect(statusMap.stage(null, 'door locked - area : sarjapura')).toBe('failed_attempt');
    expect(statusMap.stage(null, 'shipment held - area : sarjapura')).toBeUndefined();
    const html = page('delivered.html').replace('>Misroute - Area : SARJAPURA <', '>Shipment Held - Area : SARJAPURA <');
    const result = parseProfessionalCouriers(html, DELIVERED);
    expect(result.events![3]).toMatchObject({ provider_code: 'Shipment Held', description: 'Shipment Held - Area : SARJAPURA' });
    expect(result.events![3]!.stage).toBeUndefined();
    expect(result.current_stage).toBe('delivered');
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('professional-couriers');
    const tracked = await createTracker({ fetcher: site(), env: {}, providers: [] }).track({ carrier: 'professional-couriers', number: DELIVERED });
    expect(tracked.source).toBe('professional-couriers');
    expect(tracked.result.status).toBe('delivered');
  }, 30_000);
});
