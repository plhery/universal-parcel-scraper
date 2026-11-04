import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/detect.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, EtomarsTracker, etomarsUrl } from './adapter.js';
import { isEtomarsRegistration, normalizeEtomarsNumber, parseEtomars } from './parser.js';
import { etomarsStage, statusMap } from './status.js';

const NUMBER = 'SN864209752JP';
const PARTNER = '907426158305';
type Scan = [string, string, string];
const delivered: Scan = ['2026-07-04 10:20:30', '[700] Order Completed', 'Delivered : 配達完了 (例示営業所)'];
const defaults = (): Scan[] => [delivered,
  ['2026-07-04 09:00:00', '[550] (Destination Country)In Delivery', '配達中 (例示営業所)'],
  ['2026-07-04 08:00:00', '[550] (Destination Country)In Delivery', '保管中 (例示営業所)'],
  ['2026-07-03 12:00:00', '[500] (Destination Country)Start Delivery', '発送準備中 (例示営業所)'],
  ['2026-07-03 15:00:00', '[400] Customs Clearance Completed', 'JAPAN'],
  ['2026-07-02 11:00:00', '[10] Order Placed', 'SHIPNERGY Receipt']];
const shell = (content: string) => `<title>SHIPNERGY</title><div class="con_wrap login"><header class="header2"><a href="/Track/Search">Tracking</a></header><form id="form1" action="/Track/Result" method="post"><input type="hidden" name="__RequestVerificationToken" value="synthetic-state">${content}</form></div>`;
const miss = () => shell('');
const page = (scans = defaults(), options: { number?: string; headingNumber?: string; summary?: string; partner?: boolean; origin?: string; destination?: string } = {}) => {
  const number = options.number ?? NUMBER;
  return shell(`<div id="popup"><div class="popup-content"><div id="Invoice1" class="track_content active"><ul onclick="toggle(this, 'Invoice1')"><li>Registration Number<span>|</span>${options.headingNumber ?? number}</li><li class="ing">${options.summary ?? '[700] Order Completed'}</li><li><button>Open</button></li></ul><aside>PRIVATE ADDRESS AND CONTACT</aside><div class="table"><table><thead><tr><th>Departure country</th><th>Destination Country</th><th>Registration Number</th>${options.partner === false ? '' : '<th>Delivery No</th><th>Delivery Company</th>'}</tr></thead><tbody><tr><td>${options.origin ?? 'Republic of Korea'}</td><td>${options.destination ?? 'JAPAN'}</td><td>${number}</td>${options.partner === false ? '' : `<td><a href="https://e-customer.sagawa-exp.co.jp/k2k">${PARTNER}</a></td><td><a href="https://e-customer.sagawa-exp.co.jp/k2k">SAGAWA</a></td>`}</tr></tbody></table></div><div class="table"><table><thead><tr><th>Date</th><th>Status</th><th>Explanation</th></tr></thead><tbody>${scans.map(row => `<tr>${row.map(value => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div></div></div>`);
};

describe('Etomars history', () => {
  it('binds both whole identities and projects all scans, local clocks and the declared delivery partner', () => {
    const result = parseEtomars(page(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: '700',
      last_update: null, last_update_local: '2026-07-04T10:20:30', expected_delivery: null, destination_country: 'JP',
      delivery_carrier: 'sagawa', delivery_tracking_number: PARTNER });
    expect(result.events).toHaveLength(6);
    expect(result.events![0]).toEqual({ local_time: '2026-07-04T10:20:30', description: 'Order Completed — Delivered : 配達完了',
      location: '例示営業所', provider_code: '700', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.map(event => event.provider_code)).toEqual(['700', '550', '550', '400', '500', '10']);
    expect(result.events!.every(event => !event.time)).toBe(true);
    expect(result).not.toHaveProperty('history_truncated');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('does not promote storage or a partner label to a delivery round', () => {
    for (const [detail, stage] of [['配達中 (例示営業所)', 'out_for_delivery'], ['輸送中 (例示中継センター)', 'in_transit'], ['保管中 (例示営業所)', 'in_transit']] as const) {
      expect(parseEtomars(page([['2026-07-04 10:20:30', '[550] (Destination Country)In Delivery', detail]],
        { summary: '[550] (Destination Country)In Delivery' }), NUMBER).current_stage).toBe(stage);
    }
    expect(parseEtomars(page([defaults()[3]!], { summary: '[500] (Destination Country)Start Delivery' }), NUMBER).current_stage).toBe('in_transit');
    expect(etomarsStage('700', 'Order Completed')).toBeNull();
    expect(statusMap.gaps).toContainEqual(expect.objectContaining({ code: '700', wording: 'order completed' }));
  });

  it('keeps the current completed activity when a lower phase has a later written clock', () => {
    const result = parseEtomars(page([delivered, ['2026-07-04 11:00:00', '[400] Customs Clearance Completed', 'JAPAN']]), NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(result.last_status_text).toBe('Order Completed — Delivered : 配達完了');
    expect(result.last_update_local).toBe('2026-07-04T10:20:30');
    expect(result.events![0]!.stage).toBe('customs');
  });

  it('rejects ambiguous panels, changed labels, mismatched identifiers and impossible dates', () => {
    const wrong = 'SN864209753JP';
    for (const html of [page(defaults(), { number: wrong, headingNumber: NUMBER }), page(defaults(), { headingNumber: wrong }),
      page().replace("toggle(this, 'Invoice1')", "toggle(this, 'Invoice2')"), page().replace('Registration Number</th>', 'Order Number</th>'),
      page().replace('Date</th>', 'Timestamp</th>'), page().replace('2026-07-04 10:20:30', '2026-02-30 10:20:30'),
      page().replace('2026-07-04 10:20:30', '2026-07-04 24:00:00'), page() + page(),
      page(defaults(), { number: NUMBER + ' EXTRA' })]) {
      expect(() => parseEtomars(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseEtomars(page(defaults(), { origin: 'Another network' }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'unsupported_service' }));
    expect(() => parseEtomars(page(defaults(), { destination: 'Another country' }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps unknown phases visible and does not infer a stage from order completion alone', () => {
    for (const state of ['[999] New logistics phase', '[700] Order Completed']) {
      const result = parseEtomars(page([['2026-07-04 10:20:30', state, 'PRIVATE RECIPIENT COMMENT']], { summary: state, partner: false }), NUMBER);
      expect(result.status).toBe('unknown'); expect(result.events![0]).not.toHaveProperty('stage');
      expect(result.events![0]!.description).toBe(state.replace(/^\[\d+\] /, ''));
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(result).not.toHaveProperty('delivery_carrier');
    }
  });

  it('flags a missing summary activity and capped distinct scans, without counting duplicates as truncation', () => {
    const incomplete = parseEtomars(page([defaults()[1]!]), NUMBER);
    expect(incomplete).toMatchObject({ status: 'unknown', history_truncated: true, provider_code: '700' });
    const rows = Array.from({ length: 101 }, (_, i): Scan => ['2026-07-04 10:20:30', '[550] (Destination Country)In Delivery', `輸送中 (例示${i}営業所)`]);
    const options = { summary: '[550] (Destination Country)In Delivery' };
    expect(parseEtomars(page(rows.slice(0, 100), options), NUMBER)).not.toHaveProperty('history_truncated');
    expect(parseEtomars(page(rows, options), NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseEtomars(page(rows, options), NUMBER).events).toHaveLength(100);
    expect(parseEtomars(page(Array.from({ length: 120 }, () => delivered)), NUMBER).events).toHaveLength(1);
    expect(() => parseEtomars(page(Array.from({ length: 501 }, () => delivered)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('separates the exact empty tracking view from changes, challenges and unsupported references', () => {
    expect(() => parseEtomars(miss(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseEtomars(page([]), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEtomars(miss().replace('synthetic-state', 'different-state'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEtomars(miss().replace('</form>', '<p>Service unavailable</p></form>'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEtomars('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseEtomars('<title>SHIPNERGY</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeEtomarsNumber(' sn 864209752 jp ')).toBe(NUMBER);
    expect(isEtomarsRegistration(NUMBER)).toBe(true); expect(isEtomarsRegistration('RM864209752JP')).toBe(false);
    expect(() => normalizeEtomarsNumber('7642097516')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'unsupported_reference' }));
    expect(() => normalizeEtomarsNumber('<invalid>')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('retains the timeline without accepting a changed partner link as handoff evidence', () => {
    const html = page().replaceAll('https://e-customer.sagawa-exp.co.jp/k2k', 'https://other.invalid/private-link');
    const result = parseEtomars(html, NUMBER);
    expect(result.current_stage).toBe('delivered'); expect(result).not.toHaveProperty('delivery_carrier');
    expect(JSON.stringify(result)).not.toContain('private-link');
  });
});

describe('Etomars transport and recognition', () => {
  it('makes the existing ambiguous SN shape eligible for HTTP confirmation and preserves postal detection', () => {
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).toContain('etomars');
    expect(recognitionCandidates('SN864209751JP').map(candidate => candidate.carrier)).not.toContain('etomars');
    expect(detectCarrierMatch('SN864209751JP')).toMatchObject({ carrier: 'japan-post', confidence: 'high' });
    expect(recognitionCandidates('RM864209752JP').map(candidate => candidate.carrier)).not.toContain('etomars');
  });

  it('uses the supplied client, agent and signal for one whole-registration HTTP lookup', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(etomarsUrl(NUMBER)); expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('User-Agent')).toBe('host-agent'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(page());
    }) as unknown as typeof fetch;
    const result = await new EtomarsTracker({ fetcher, userAgent: 'host-agent' }).fetch(NUMBER);
    expect(result.events).toHaveLength(6); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries a missing network response once, but never an HTTP or parser answer', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('connection failed')).mockResolvedValueOnce(new Response(page())) as unknown as typeof fetch;
    expect((await new EtomarsTracker({ fetcher }).fetch(NUMBER)).current_stage).toBe('delivered'); expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [response, kind] of [[new Response('blocked', { status: 403 }), 'challenge'],
      [new Response('slow', { status: 429, headers: { 'Retry-After': '60' } }), 'rate_limited'],
      [new Response('unavailable', { status: 503 }), 'maintenance'], [new Response('gone', { status: 404 }), 'transport'],
      [new Response('', { status: 302, headers: { Location: '/Track/Search' } }), 'transport'],
      [new Response('changed'), 'schema'], [new Response(miss()), 'indeterminate']] as const) {
      const fetcher = vi.fn(async () => response) as unknown as typeof fetch;
      await expect(new EtomarsTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('recognizes only a bound dated history and does not turn retention into not-found', async () => {
    const fetcher = vi.fn(async () => new Response(page())) as unknown as typeof fetch;
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-07-04T10:20:30' });
    await expect(instance.recognize!('7642097516')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const empty = adapter({ fetcher: vi.fn(async () => new Response(miss())),
      recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(empty.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('cancels before dispatch and leaves unsupported order-reference modes to fallback', async () => {
    const fetcher = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(new EtomarsTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    await expect(new EtomarsTracker({ fetcher }).fetch('7642097516')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
