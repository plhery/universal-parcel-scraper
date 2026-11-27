import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { keepAdapterHolds, resetAdapterHolds, type AdapterHold } from '../../core/runner/holds.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { outsideCountryLast } from '../../core/testing/recognition.js';
import type { TrawlClient, TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DPD_RO_ENDPOINT, DPD_RO_PAGE_REST_MS, dpdRoPageRequest, DpdRoTracker } from './adapter.js';
import { parseDpdRo, parseDpdRoReply } from './parser.js';
import { dpdRoOperation, dpdRoPhase, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '89999999980';
const ABROAD = '80000000002';
const CANCELLED = '80000000003';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown> => JSON.parse(text(`${name}.json`)) as Record<string, unknown>;
const reply = (name: string) => new Response(text(`${name}.json`), { headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
const missing = () => new Response(text('not-found.html'), { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DPD Romania HTTP adapter', () => {
  it('asks the public track endpoint once, in English, through the supplied transport and records the step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DpdRoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 8999 9999 980 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://mydpd.dpd.ro/rest/public/track?id=${DELIVERED}&language=en`);
    expect(init).toMatchObject({ signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init?.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dpd-ro', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('names the shape of a reply without its scans, never its values', () => {
    expect(() => parseDpdRoReply(200, JSON.stringify({ error: 'Sample message', code: 7, 'not a key': 1 }), DELIVERED))
      .toThrow('DPD Romania returned a reply without its scans (an object with 3 fields: error, code)');
    expect(() => parseDpdRoReply(200, JSON.stringify({ events: 'none' }), DELIVERED)).toThrow('(an object with 1 field: events, events: string)');
    expect(() => parseDpdRoReply(200, '[1, 2]', DELIVERED)).toThrow('(an array of 2)');
  });

  it('reads a delivered history newest first, with offset clocks and the masked signatory, without the proof of delivery', () => {
    const result = parseDpdRo(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-04T11:20:30+02:00', delivered_at: '2026-03-04T11:20:30+02:00',
      expected_delivery: null, signed_by: 'ABC**********' });
    expect(result.events!.map(event => [event.time, event.provider_code, event.stage ?? null, event.location ?? null])).toEqual([
      ['2026-03-04T11:20:30+02:00', '-14', 'delivered', 'Example City'],
      ['2026-03-04T08:05:00+02:00', '12', 'out_for_delivery', 'Example City'],
      ['2026-03-04T07:30:00+02:00', '175', null, null],
      ['2026-03-03T04:10:00+02:00', '1', 'in_transit', 'Example City'],
      ['2026-03-02T22:30:00+02:00', '2', 'in_transit', 'Sample Town'],
      ['2026-03-02T18:05:00+02:00', '11', 'in_transit', 'Sample Town'],
      ['2026-03-02T16:40:00+02:00', '39', 'accepted', 'Sample Town'],
      ['2026-03-02T09:15:00+02:00', '148', 'registered', null],
    ]);
    expect(result.events![2]).toEqual({ time: '2026-03-04T07:30:00+02:00', description: 'Predict', provider_code: '175' });
    const kept = JSON.stringify({ ...result, signed_by: undefined });
    for (const dropped of ['ABC**', 'received from', 'SYNTHETIC-POD-TOKEN', 'Expected Delivery', '09:00 - 12:00']) {
      expect(kept).not.toContain(dropped);
    }
    // Only a delivery's note names who took the parcel.
    const undelivered = fixture('delivered') as { events: Record<string, unknown>[] };
    undelivered.events = undelivered.events.slice(0, -1).concat({ ...undelivered.events.at(-1)!, operationCode: 12, description: 'Out for Delivery' });
    expect(parseDpdRo(undelivered, DELIVERED).signed_by).toBeUndefined();
  });

  it('keeps the Predict window on its day while the parcel is out for delivery, until the window has passed', () => {
    const outForDelivery = (change: (events: Record<string, unknown>[]) => void = () => {}) => {
      const payload = fixture('delivered') as { events: Record<string, unknown>[]; info: Record<string, unknown> };
      payload.events.pop();
      payload.info = { phase: 'IN_TRANSIT' };
      change(payload.events);
      return parseDpdRo(payload, DELIVERED);
    };
    const result = outForDelivery();
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', expected_delivery: '2026-03-04 09:00–12:00' });
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result.events!.find(event => event.provider_code === '175')).toEqual(
      { time: '2026-03-04T07:30:00+02:00', description: 'Predict', provider_code: '175' });
    // A window is on the scan's own day and wall clock, not UTC's.
    expect(outForDelivery((events) => {
      Object.assign(events[5]!, { dateTime: '2026-03-04T00:30:00+0200', comments: [{ text: '08:30-10:00' }] });
    }).expected_delivery).toBe('2026-03-04 08:30–10:00');
    // A scan after the window ends passes it, and the expected day stands.
    expect(outForDelivery((events) => {
      events.push({ operationCode: 9001, description: 'Example new operation', dateTime: '2026-03-04T12:30:00+0200', place: '', comments: [] });
    }).expected_delivery).toBe('2026-03-04');
    // A note in another shape, a window that does not end after it starts, or the note on another scan is no window.
    for (const [index, note] of [[5, 'between nine and noon'], [5, '12:00 - 09:00'], [6, '09:00 - 12:00']] as const) {
      expect(outForDelivery((events) => {
        events[5]!.comments = [];
        events[index]!.comments = [{ text: note }];
      }).expected_delivery, note).toBe('2026-03-04');
    }
  });

  it('keeps the estimate of a parcel on its way abroad, its partner scan place and none of the partner mapping', () => {
    const result = parseDpdRo(fixture('abroad'), ABROAD);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrival Scan',
      last_update: '2026-03-11T07:50:00+01:00', expected_delivery: '2026-03-13' });
    expect(result.events!.map(event => [event.provider_code, event.location ?? null])).toEqual([
      ['1', 'SAMPLEDORF, Germany'], ['176', 'Sample Town'], ['39', 'Sample Town'], ['148', null]]);
    expect(result.delivered_at).toBeUndefined();
    expect(result.delivery_carrier).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/00000000000000|example\.com|99-/);
  });

  it('names ACS and its number when DPD Romania hands it the receiving leg, as for a parcel to Cyprus', () => {
    const payload = fixture('abroad') as { externalCarriermappings: Record<string, unknown>[] };
    payload.externalCarriermappings = [{ barcode: '9900000001', externalCarrierId: 3, externalCarrier: 'ACS', mappingFor: 'RECEIVER',
      trackURL: 'https://www.acscourier.net/en/track-and-trace?trackingNumber=9900000001' }];
    expect(parseDpdRo(payload, ABROAD)).toMatchObject({ delivery_carrier: 'acs-courier', delivery_tracking_number: '9900000001' });
    // The sender's leg, and a partner that cannot be asked, name none.
    payload.externalCarriermappings[0]!.mappingFor = 'SENDER';
    expect(parseDpdRo(payload, ABROAD).delivery_carrier).toBeUndefined();
    Object.assign(payload.externalCarriermappings[0]!, { mappingFor: 'RECEIVER', externalCarrier: 'Example Network' });
    expect(parseDpdRo(payload, ABROAD).delivery_carrier).toBeUndefined();
  });

  it('reads a cancelled waybill as an exception without an estimate', () => {
    expect(parseDpdRo(fixture('cancelled'), CANCELLED)).toMatchObject({ status: 'exception', current_stage: 'exception',
      last_status_text: 'Canceled', last_update: '2026-08-03T15:08:23+03:00', expected_delivery: null,
      events: [{ provider_code: '128', stage: 'exception', location: 'Sample Town' }, { provider_code: '148', stage: 'registered' }] });
  });

  it('keeps unknown codes visible without a stage and answers a reply without scans from its phase', () => {
    const payload = fixture('abroad') as { events: Record<string, unknown>[]; info: unknown };
    payload.events.push({ operationCode: 9001, description: 'Example new operation', dateTime: '2026-03-12T09:00:00+0200', place: '', comments: [] });
    const unknown = parseDpdRo(payload, ABROAD);
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Example new operation' });
    expect(unknown.events![0]).toEqual({ time: '2026-03-12T09:00:00+02:00', description: 'Example new operation', provider_code: '9001' });
    payload.events = [];
    expect(parseDpdRo(payload, ABROAD)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', provider_code: 'IN_TRANSIT',
      last_status_text: 'In transit', summary_only: true, last_update: null, events: [] });
    payload.info = { phase: 'SOMETHING_NEW' };
    expect(() => parseDpdRo(payload, ABROAD)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the reply to the whole requested waybill and dated scans', () => {
    expect(() => parseDpdRo(fixture('delivered'), '80000000009')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [{ dateTime: '2026-03-02T09:15:00' }, { dateTime: '' }, { operationCode: null }, { operationCode: { code: 1 } }]) {
      const payload = fixture('delivered') as { events: Record<string, unknown>[] };
      Object.assign(payload.events[0]!, change);
      expect(() => parseDpdRo(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDpdRo({ barcode: DELIVERED, events: {} }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads MyDPD’s not-found page as not found and other replies by their own kind', () => {
    expect(() => parseDpdRoReply(404, text('not-found.html'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDpdRoReply(404, '<html>Not Found</html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseDpdRoReply(200, '<html><title>Just a moment...</title></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDpdRoReply(200, '<html><title>Un instant…</title></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDpdRoReply(200, '<html><title>SkyLogistics</title><div class="cf-turnstile"></div></html>', DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // Without the tracker page's Turnstile token every waybill gets an empty object; a refused token gets 406.
    expect(() => parseDpdRoReply(200, '{}', DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDpdRoReply(406, '[{"type":"error","context":"turnstile-failure"}]', DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(parseDpdRoReply(200, `\uFEFF${text('delivered.json')}`, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads MyDPD\'s not-found page as not found, and offers no HTTP recognition', async () => {
    const instance = carrier(vi.fn<typeof fetch>().mockResolvedValue(missing()));
    expect(instance.recognize).toBeUndefined();
    await expect(instance.track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [400, 'transport'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('<html></html>', { status, headers: { 'Retry-After': '120' } }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps a 404 that is not MyDPD’s page and a blocked HTTP 200 apart from missing waybills', async () => {
    for (const [response, kind] of [[new Response('Not Found', { status: 404 }), 'transport'],
      [new Response('<html><title>Just a moment...</title></html>'), 'challenge'], [new Response('{"items":[]}'), 'schema']] as const) {
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    }
  });

  it('rejects numbers DPD Romania does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['8000000000', '800000000011', '60000000001', '00000000000000', 'RO80000000001']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes a waybill filed under DPD Romania to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('delivered'));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'dpd-ro' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'dpd-ro', source: 'dpd-ro', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${DPD_RO_ENDPOINT}?`))).toBe(true);
  });
});

const page = (captures: Partial<TrawlScrapeResponse['capturedResponses'][number]>[], extra: Partial<TrawlScrapeResponse> = {}): TrawlScrapeResponse => ({
  url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {}, ...extra,
  capturedResponses: captures.map(capture => ({ url: dpdRoPageRequest(DELIVERED), status: 200, headers: {}, body: text('delivered.json'),
    truncated: false, base64Encoded: false, error: null, ...capture })),
});
// Without a service address no rest is kept; `service` names one.
const browser = (answer: TrawlScrapeResponse, service?: string) => {
  const scrape = vi.fn<TrawlClient['scrape']>().mockResolvedValue(answer);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { headers: { 'Content-Type': 'application/json;charset=UTF-8' } }));
  const trawl = { scrape, ...(service ? { endpoint: new URL(service) } : {}) } as unknown as TrawlClient;
  return { scrape, fetcher, instance: adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl, browserExecutablePath: null }) };
};

describe('DPD Romania through MyDPD\'s tracker page', () => {
  it('opens the tracker page when the endpoint wants its Turnstile token, and reads the page\'s own reply', async () => {
    const { scrape, fetcher, instance } = browser(page([{}]));
    expect(instance.steps).toEqual(['direct', 'trawl']);
    await expect(instance.track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(scrape).toHaveBeenCalledTimes(1);
    const [request, options] = scrape.mock.calls[0]!;
    expect(request).toMatchObject({ url: `https://mydpd.dpd.ro/pub/tracking/${DELIVERED}?language=en`, skipHttp: true,
      captureResponses: [DPD_RO_ENDPOINT] });
    expect(options).toMatchObject({ requireSolved: false, signal: expect.any(AbortSignal) });
    expect(dpdRoPageRequest(DELIVERED)).toBe(`${DPD_RO_ENDPOINT}?id=${DELIVERED}&language=en&mobile=N`);
  });

  it('reads the not-found page as not found and keeps refusals, other waybills and partial replies apart', async () => {
    for (const [answer, kind] of [
      [page([{ status: 404, body: text('not-found.html') }]), 'not_found'],
      [page([{ status: 404, body: null, error: 'body was not read' }]), 'transport'],
      [page([{ status: 200, body: null, error: 'body was not read' }]), 'transport'],
      [page([{ status: 406, body: null }]), 'challenge'],
      [page([{ status: 403, body: null }]), 'challenge'],
      [page([{ status: 429, body: null, headers: { 'retry-after': '60' } }]), 'rate_limited'],
      [page([{ status: 400, body: null }]), 'transport'],
      [page([]), 'challenge'],
      [page([{ url: dpdRoPageRequest(CANCELLED) }]), 'challenge'],
      [page([{ url: `${DPD_RO_ENDPOINT}?id=${DELIVERED}&language=en` }]), 'challenge'],
      [page([{ body: text('delivered.json').replace(DELIVERED, CANCELLED) }]), 'schema'],
      [page([{}], { tier: 1 }), 'transport'],
    ] as const) {
      await expect(browser(answer).instance.track({ number: DELIVERED })).rejects.toMatchObject({ kind });
    }
  });

  it('leaves the page unopened when the budget cannot give the service the time its Turnstile check takes', async () => {
    const { scrape, instance } = browser(page([{}]));
    await expect(instance.track({ number: DELIVERED }, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(scrape).not.toHaveBeenCalled();
    await expect(instance.track({ number: DELIVERED }, { budgetMs: 26_000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(scrape.mock.calls[0]![0].maxTimeout).toBeGreaterThanOrEqual(10_000);
  });

  it('recognizes a waybill through the page only on its dated scans or its record, and unknown only on MyDPD\'s not-found page', async () => {
    const found = browser(page([{}]));
    await expect(found.instance.recognizeWithBrowser!(DELIVERED)).resolves.toMatchObject({ known: true,
      lastActivityAt: '2026-03-04T09:20:30.000Z', finished: true, result: { current_stage: 'delivered' } });
    expect(found.fetcher).toHaveBeenCalledTimes(1);
    expect(found.scrape).toHaveBeenCalledTimes(1);
    await expect(browser(page([{ status: 404, body: text('not-found.html') }])).instance.recognizeWithBrowser!(DELIVERED))
      .resolves.toEqual({ known: false, lastActivityAt: null });
    // A reply for the whole waybill with its phase and no scan is DPD Romania's record of it, with no history to reuse.
    const scanless = fixture('abroad');
    scanless.events = [];
    await expect(browser(page([{ url: dpdRoPageRequest(ABROAD), body: JSON.stringify(scanless) }])).instance.recognizeWithBrowser!(ABROAD))
      .resolves.toEqual({ known: true, lastActivityAt: null });
    // A number DPD Romania does not issue is unknown without a request.
    const other = browser(page([{}]));
    await expect(other.instance.recognizeWithBrowser!('8000000001')).resolves.toEqual({ known: false, lastActivityAt: null });
    expect(other.fetcher).not.toHaveBeenCalled();
    expect(other.scrape).not.toHaveBeenCalled();
  });

  it('fails browser recognition on a challenge, a throttle, a malformed reply, a short budget or no browser service', async () => {
    for (const [answer, kind] of [
      [page([]), 'challenge'],
      [page([{ status: 406, body: null }]), 'challenge'],
      [page([{ status: 429, body: null }]), 'rate_limited'],
      [page([{ status: 404, body: '<html>Not Found</html>' }]), 'transport'],
      [page([{ body: '{"items":[]}' }]), 'schema'],
    ] as const) {
      await expect(browser(answer).instance.recognizeWithBrowser!(DELIVERED)).rejects.toMatchObject({ kind });
    }
    const { scrape, instance } = browser(page([{}]));
    await expect(instance.recognizeWithBrowser!(DELIVERED, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(scrape).not.toHaveBeenCalled();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    await expect(carrier(fetcher).recognizeWithBrowser!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('leaves the page for a while after it met the Turnstile check, on that browser service only', async () => {
    const saved: AdapterHold[] = [];
    await keepAdapterHolds({ load: async () => [], save: async (hold) => { saved.push(hold); } });
    try {
      const { scrape, fetcher, instance } = browser(page([]), 'https://browser.example.test/dpd-ro-rest');
      await expect(instance.track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
      expect(scrape).toHaveBeenCalledTimes(1);
      expect(saved).toEqual([{ key: expect.stringMatching(/^dpd-ro-page-rest\//), until: expect.any(Number) }]);
      expect(JSON.stringify(saved)).not.toContain('browser.example.test');
      // In the rest a lookup ends with the endpoint's challenge, recognition included, without opening the page.
      await expect(instance.track({ number: ABROAD })).rejects.toMatchObject({ kind: 'challenge' });
      await expect(instance.recognizeWithBrowser!(DELIVERED)).rejects.toMatchObject({ kind: 'challenge' });
      expect(scrape).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(3);
      await expect(browser(page([{}]), 'https://browser.example.test/dpd-ro-other').instance.track({ number: DELIVERED }))
        .resolves.toMatchObject({ current_stage: 'delivered' });
      scrape.mockResolvedValue(page([{}]));
      const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DPD_RO_PAGE_REST_MS + 1);
      try {
        await expect(instance.track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
      } finally { later.mockRestore(); }
      expect(scrape).toHaveBeenCalledTimes(2);
    } finally {
      resetAdapterHolds();
    }
  });

  it('keeps asking the page after a throttle, a failed load or a not-found page', async () => {
    for (const answer of [page([{ status: 429, body: null }]), page([{}], { tier: 1 }), page([{ status: 404, body: text('not-found.html') }])]) {
      const { scrape, instance } = browser(answer, 'https://browser.example.test/dpd-ro-answers');
      await expect(instance.track({ number: DELIVERED })).rejects.toThrow();
      await expect(instance.track({ number: DELIVERED })).rejects.toThrow();
      expect(scrape).toHaveBeenCalledTimes(2);
    }
  });

  it('answers a found waybill over HTTP without the browser', async () => {
    const { scrape, fetcher, instance } = browser(page([{}]));
    fetcher.mockResolvedValue(reply('delivered'));
    await expect(instance.track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(scrape).not.toHaveBeenCalled();
  });
});

describe('DPD Romania numbers', () => {
  it('suggests eleven digits starting with 8, which only browser recognition asks it about, last outside Romania', () => {
    for (const number of [DELIVERED, ABROAD]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates).toContain('dpd-ro');
      for (const countryHint of [undefined, 'RO', 'BG', 'FR', 'DE']) {
        expect(recognitionCandidates(number, { countryHint }).map(({ carrier }) => carrier), `${number} ${countryHint}`).not.toContain('dpd-ro');
      }
      expect(recognitionCandidates(number, { countryHint: 'RO', phase: 'browser' }).find(({ carrier }) => carrier === 'dpd-ro'), number)
        .toMatchObject({ countryMatch: 'home' });
      expect(outsideCountryLast(number, 'dpd-ro', { countryHint: 'RO', phase: 'browser' }), number).toBe(false);
      // Other carriers print eleven digits from 8 elsewhere: from another country DPD Romania comes once they have all missed it.
      for (const countryHint of ['FR', 'DE', 'BG']) {
        expect(outsideCountryLast(number, 'dpd-ro', { countryHint, phase: 'browser' }), `${number} ${countryHint}`).toBe(true);
      }
      expect(recognitionCandidates(number, { phase: 'browser' }).find(({ carrier }) => carrier === 'dpd-ro'), number)
        .toEqual({ carrier: 'dpd-ro', needsInput: null, preferred: false });
    }
    for (const other of ['70000000001', '8000000001', '800000000012']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('dpd-ro');
      expect(recognitionCandidates(other, { countryHint: 'RO', phase: 'browser' }).map(({ carrier }) => carrier), other).not.toContain('dpd-ro');
    }
  });
});

describe('DPD Romania status vocabulary', () => {
  it('records every code and phase with the stage the adapter gives it, and its documented English wording', () => {
    for (const entry of statuses.entries) {
      if (!('code' in entry) || !entry.code) continue;
      const known = /^-?\d+$/.test(entry.code) ? dpdRoOperation(entry.code) : dpdRoPhase(entry.code);
      expect(known?.stage, entry.code).toBe('stage' in entry ? entry.stage : undefined);
      if (entry.language === 'en') expect(known?.wording, entry.code).toBe(entry.wording);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(dpdRoOperation('152')).toEqual({ wording: 'Routed to another DPD Location', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'dpd-ro', providerCode: '128', description: 'Canceled' })).toEqual({ kind: 'mapped', stage: 'exception' });
    expect(statusMapAnswer({ carrier: 'dpd-ro', providerCode: '175', description: 'Predict' })).toMatchObject({ kind: 'intentional_gap' });
  });
});
