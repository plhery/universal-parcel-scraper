import { describe, expect, it, vi } from 'vitest';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/detect.js';
import { isFlickpostReference } from '../../core/detection/flickpost.js';
import { parseTrackingInput } from '../../core/detection/parse.js';
import { createTracker } from '../../facade/index.js';
import { FlickpostTracker, flickpostUrl } from './adapter.js';
import { normalizeFlickpostNumber, parseFlickpost } from './parser.js';
import { flickpostStage, statusMap } from './status.js';

const NUMBER = 'EW731640285MY', OWN = 'X731602';
type Scan = [clock: string, status: string, location: string, activity: string];
const origin: Scan = ['2026-03-12 12:00', 'Progress', 'Shah Alam Warehouse', 'Shipment created'];
const scans = (): Scan[] => [
  ['2026-03-15 08:00', 'Delivered', 'Example Town, ZZ', 'Delivered, Door/Yard. For Delivery Issues & Tracking Support, contact +1 555 010 0099 or private@example.invalid'],
  ['2026-03-13 08:00', 'Transit', '-', 'Shipping Label Created'],
  ['2026-03-12 13:00', 'Arrived At Hub', 'KLG', 'Awaiting Sorting and Bagging'], origin,
];
const genericError = '<p class="invalid-text" style="display:none">Invalid tracking number: The tracking number was not found. Please enter a valid number</p>';
const shell = (result: string) => `<title>Track Parcel - Flickpost</title><link rel="canonical" href="https://flickpost.com/tracking/"><form id="track-form"><input name="trackingno"></form><div class="elementor-widget-shortcode"><div class="elementor-widget-container">${genericError}${result}</div></div><div class="elementor-hidden-desktop elementor-hidden-tablet elementor-hidden-mobile"><button class="result-accord"><h3>DEMONSTRATION NUMBER</h3><h4>DELIVERED</h4></button><p>PRIVATE RECIPIENT EXAMPLE</p></div><form id="cf7-career-application-form"><span class="g-recaptcha"></span><input name="_wpcf7_recaptcha_response"></form><form id="cf7-merchant-onboarding-form"><span class="g-recaptcha"></span></form>`;
const missing = (number = NUMBER) => shell(`<div class="tracking-results"><div class="grid-col"><p class="invalid-text">Invalid tracking number: Error occurred while tracking shipment ${number}. The tracking number was not found. Please enter a valid number</p></div></div>`);
const page = (rows = scans(), options: { number?: string; copy?: string; summary?: string } = {}) => shell(`<div class="full-accord"><button class="result-accord"><div class="track-col"><h6>TRACKING NUMBER</h6><h3><span class="ctc-inline-copy"><span class="ctc-inline-copy-text">${options.number ?? NUMBER}</span><textarea class="ctc-inline-copy-textarea">${options.copy ?? options.number ?? NUMBER}</textarea></span></h3></div><div class="status-col"><div class="status-list"><h4>${options.summary ?? rows[0]?.[1] ?? 'Delivered'}</h4></div></div></button><div class="panel"><div class="accord-box-col"><div class="accord-box-timeline"><div class="status-gap">${rows.map(([clock, state, place, detail]) => `<div class="history-timeline-dot"></div><div class="status-point"><h5>${state}</h5><p>${place}</p><p>${detail}</p><p>${clock}</p></div>`).join('')}</div></div><div class="accord-box-content"><div class="accord-content-list"><div><p>SHIPMENT TYPE</p><h5>Non-document</h5></div></div><div class="accord-content-list"><div><p>SHIPPING OPTION</p><h5>Economy Plus (Tracked)</h5></div><div><p>PARCEL WEIGHT</p><h5>0.73 Kg</h5></div></div></div></div></div></div>`);

describe('Flickpost history and ownership', () => {
  it('reads the bound forwarding history and service, excluding unrelated examples, forms and contacts', () => {
    const result = parseFlickpost(page(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-03-15T08:00:00', expected_delivery: null,
      service_name: 'Economy Plus (Tracked)', weight_kg: 0.73 });
    expect(result.events).toHaveLength(4);
    expect(result.events![0]).toEqual({ description: 'Delivered — Delivered, Door/Yard', local_time: '2026-03-15T08:00:00',
      location: 'Example Town, ZZ', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.every(event => !event.time)).toBe(true);
    for (const text of ['PRIVATE', '555', 'example.invalid', 'recaptcha', 'DEMONSTRATION']) expect(JSON.stringify(result)).not.toContain(text);
    expect(result).not.toHaveProperty('delivery_carrier');
  });

  it('does not treat a matching postal number and overseas feed alone as Flickpost ownership', () => {
    expect(() => parseFlickpost(page(scans().slice(0, 2)), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'unsupported_service' }));
    const result = parseFlickpost(page([origin], { number: OWN }), OWN);
    expect(result.current_stage).toBe('registered');
    expect(result.events).toHaveLength(1);
  });

  it('keeps shipping labels at registration, customs details at clearance and pointer entries unstaged', () => {
    expect(flickpostStage('Transit — Shipping Label Created')).toBe('registered');
    expect(flickpostStage('Progress — Shipment created')).toBe('registered');
    expect(flickpostStage('Progress')).toBeUndefined();
    expect(flickpostStage('Transit — Loaded on Vehicle')).toBe('in_transit');
    expect(flickpostStage("En route to destination's port of entry — Inbound for customs processing")).toBe('customs');
    expect(flickpostStage('Processed At Hub — Outbound clearance in progress')).toBe('customs');
    const result = parseFlickpost(page([['2026-03-15 08:00', 'Track and Trace', 'NZ', 'https://flickpost.com/tracking/?trackingNumber=LP731640285MY'], origin]), NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events![0]!.description).toBe('Track and Trace');
    expect(statusMap.gaps[0]!.wording).toBe('track and trace');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(JSON.stringify(result)).not.toContain('https:');
  });

  it('preserves the portal order when overseas wall clocks compare differently, and keeps unknown wording', () => {
    const result = parseFlickpost(page([scans()[0]!, ['2026-03-15 20:00', 'New phase', 'PRIVATE ADDRESS 99', 'PRIVATE COMMENT'], origin]), NUMBER);
    expect(result.events![0]!.stage).toBe('delivered');
    expect(result.events![1]!.description).toBe('New phase');
    expect(result.events![1]).not.toHaveProperty('stage');
    expect(result.events![1]).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('requires both whole identities, unique structure, coherent summary and valid clocks and weight', () => {
    for (const html of [page(scans(), { copy: 'EW731640286MY' }), page(scans(), { number: NUMBER + ' EXTRA' }),
      page(scans(), { summary: 'Request Received' }), page().replace('https://flickpost.com/tracking/', 'https://other.invalid/'),
      page().replace('SHIPMENT TYPE', 'SENDER NAME'), page().replace('0.73 Kg', '-1 Kg'),
      page().replace('2026-03-15 08:00', '2026-02-30 08:00'), page().replace('2026-03-15 08:00', '2026-03-15 24:00'),
      page() + page()]) expect(() => parseFlickpost(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('recognizes only the exact number-bound absence, ignoring the generic hidden invalid notice', () => {
    expect(() => parseFlickpost(missing(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const html of [shell(''), missing('EW731640286MY'), missing().replace('Error occurred while tracking shipment', 'Service temporarily unavailable for'),
      missing() + page()]) expect(() => parseFlickpost(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlickpost(page([]), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlickpost(page().replace('<form id="track-form">', '<form id="track-form"><span class="g-recaptcha"></span>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseFlickpost('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('deduplicates within the cap and marks truncated histories', () => {
    const rows = Array.from({ length: 100 }, (_, i): Scan => [`2026-03-15 ${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      'Transit', 'Example Town, ZZ', 'Loaded on Vehicle']);
    expect(parseFlickpost(page([...rows.slice(0, 99), origin]), NUMBER)).not.toHaveProperty('history_truncated');
    expect(parseFlickpost(page([...rows, origin]), NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseFlickpost(page([...rows, origin]), NUMBER).events).toHaveLength(100);
    expect(parseFlickpost(page(Array.from({ length: 120 }, () => origin)), NUMBER).events).toHaveLength(1);
    expect(() => parseFlickpost(page(Array.from({ length: 501 }, () => origin)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Flickpost routing and transport', () => {
  it('preserves postal detection, makes carrier links explicit and adds no broad recognition candidate', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'pos-malaysia', confidence: 'high' });
    expect(detectCarrierMatch(OWN)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(flickpostUrl(NUMBER))).toMatchObject({ trackingNumber: NUMBER, carrier: 'flickpost', source: 'link' });
    expect(recognitionCandidates(NUMBER, { hint: 'flickpost' }).map(candidate => candidate.carrier)).not.toContain('flickpost');
    expect(recognitionCandidates(OWN).map(candidate => candidate.carrier)).not.toContain('flickpost');
    expect(hasDirectHandoffAdapter('flickpost', NUMBER)).toBe(true);
    expect(hasDirectHandoffAdapter('flickpost', OWN)).toBe(true);
    expect(hasDirectHandoffAdapter('flickpost', 'LP731640285JP')).toBe(false);
    expect(isFlickpostReference(NUMBER)).toBe(true); expect(isFlickpostReference('EW731640286MY')).toBe(false);
    expect(normalizeFlickpostNumber(' ew 731640285 my ')).toBe(NUMBER);
    expect(() => normalizeFlickpostNumber('OTHER123456')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'unsupported_reference' }));
    expect(() => normalizeFlickpostNumber('<invalid>')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('uses the supplied client, agent, whole number and request signal', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(flickpostUrl(NUMBER)); expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('User-Agent')).toBe('host-agent'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(page());
    }) as unknown as typeof fetch;
    expect((await new FlickpostTracker({ fetcher, userAgent: 'host-agent' }).fetch(NUMBER)).events).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries a failed network connection once and preserves HTTP, parser and absence answers', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('connection failed')).mockResolvedValueOnce(new Response(page())) as unknown as typeof fetch;
    expect((await new FlickpostTracker({ fetcher }).fetch(NUMBER)).current_stage).toBe('delivered'); expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [response, kind] of [[new Response('blocked', { status: 403 }), 'challenge'],
      [new Response('slow', { status: 429 }), 'rate_limited'], [new Response('down', { status: 503 }), 'maintenance'],
      [new Response('missing route', { status: 404 }), 'transport'], [new Response('', { status: 302 }), 'transport'],
      [new Response('changed'), 'schema'], [new Response(missing()), 'not_found'],
      [new Response(page(scans().slice(0, 2))), 'indeterminate']] as const) {
      const client = vi.fn(async () => response) as unknown as typeof fetch;
      await expect(new FlickpostTracker({ fetcher: client }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(client).toHaveBeenCalledTimes(1);
    }
  });

  it('cancels before dispatch and leaves other reference modes to fallback', async () => {
    const fetcher = vi.fn(), controller = new AbortController(); controller.abort();
    await expect(new FlickpostTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    await expect(new FlickpostTracker({ fetcher }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(new FlickpostTracker({ fetcher }).fetch('OTHER123456')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reaches the native adapter through the public facade with universal providers disabled', async () => {
    const fetcher = vi.fn(async () => new Response(page())) as unknown as typeof fetch;
    const response = await createTracker({ fetcher, providers: [] }).track({ carrier: 'flickpost', number: NUMBER });
    expect(response).toMatchObject({ carrier: 'flickpost', source: 'flickpost', attempts: [{ source: 'flickpost', kind: 'ok' }] });
    expect(response.result.events).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
