import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adapter as fezDelivery } from '../carriers/fez-delivery/adapter.js';
import { adapter as junfengInternational } from '../carriers/junfeng-international/adapter.js';
import { adapter as shipglobalUs } from '../carriers/shipglobal-us/adapter.js';
import { adapter as royaleInternational } from '../carriers/royale-international/adapter.js';
import { adapter as topdelivery } from '../carriers/topdelivery/adapter.js';
import { adapter as kargoturk } from '../carriers/kargoturk/adapter.js';
import { adapter as profitFields } from '../carriers/profit-fields/adapter.js';
import { adapter as expedico } from '../carriers/expedico/adapter.js';
import type { AdapterFactory } from '../core/adapter/index.js';
import { AdapterRegistry } from '../core/adapter/index.js';
import { hasDirectHandoffAdapter } from '../core/catalog/handoff.js';
import { recognitionAskedCarriers, recognitionCandidates } from '../core/catalog/recognition.js';
import { detectCarrierMatch } from '../core/detection/detect.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { REGISTRY } from '../generated/registry.js';
import { createTracker } from '../facade/index.js';

const cases: { carrier: string; factory: AdapterFactory; number: string; fixture: string; count: number;
  request: (url: URL, init?: RequestInit) => void }[] = [
  { carrier: 'fez-delivery', factory: fezDelivery, number: 'TZ7K04072612', fixture: 'tracking.json', count: 4,
    request: (url, init) => { expect(url.origin + url.pathname).toBe('https://customerapi.fezdelivery.co/v1/order/historyv2/TZ7K04072612'); expect(init?.method).toBeUndefined(); } },
  { carrier: 'junfeng-international', factory: junfengInternational, number: 'IW864209751GB', fixture: 'tracking.json', count: 5,
    request: (url, init) => { expect(url.href).toBe('https://www.junfengfast.com/api/public/tracking'); expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body))).toEqual({ outWaybillCodes: ['IW864209751GB'] }); } },
  { carrier: 'shipglobal-us', factory: shipglobalUs, number: 'FFUSA7416302', fixture: 'tracking.json', count: 4,
    request: (url, init) => { expect(url.href).toBe('https://api.shipglobal.us/api/tracking'); expect(init?.method).toBe('POST'); expect(String(init?.body)).toBe('waybill=FFUSA7416302'); } },
  { carrier: 'royale-international', factory: royaleInternational, number: '970682415309', fixture: 'tracking.html', count: 4,
    request: (url, init) => { expect(url.href).toBe('https://www.royaleinternational.com/tracking?waybillno=970682415309'); expect(init?.method).toBeUndefined(); } },
  { carrier: 'topdelivery', factory: topdelivery, number: '97468135', fixture: 'tracking.html', count: 5,
    request: (url, init) => { expect(url.href).toBe('https://www.topdelivery.ru/tracking/?order=97468135'); expect(init?.method).toBeUndefined(); } },
  { carrier: 'kargoturk', factory: kargoturk, number: '974681350246', fixture: 'tracking.html', count: 6,
    request: (url, init) => { expect(url.href).toBe('https://online.kargoturk.com.tr/tracking?har_kod=974681350246'); expect(init?.method).toBeUndefined(); } },
  { carrier: 'expedico', factory: expedico, number: '9734628105691', fixture: 'tracking.json', count: 4,
    request: (url, init) => { expect(url.href).toBe('https://expedico.eu/api/public'); expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)); expect(body.variables).toEqual({ codes: ['9734628105691'] });
      expect(body.query).toContain('tracking(codes: $codes)'); expect(body.query).not.toMatch(/sender|moneyCod|Authorization/); } },
  { carrier: 'profit-fields', factory: profitFields, number: 'EWSXY974682510368YQ', fixture: 'tracking.json', count: 5,
    request: (url, init) => { expect(url.href).toBe('https://8dt.com/api/tracking/query'); expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ trackingNumbers: ['EWSXY974682510368YQ'] }); } },
];
const environment = (fetcher: typeof fetch) => ({ fetcher, userAgent: 'consumer-agent', recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const body = (entry: typeof cases[number]) => readFileSync(new URL(`../carriers/${entry.carrier}/fixtures/${entry.fixture}`, import.meta.url), 'utf8');

describe.each(cases)('$carrier bounded guest transport', entry => {
  it('uses the supplied transport, user agent and signal for one complete reference', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      entry.request(new URL(String(url)), init);
      expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('User-Agent')).toBe('consumer-agent'); expect(headers.has('Cookie')).toBe(false);
      expect(headers.has('Authorization')).toBe(false);
      return new Response(body(entry));
    }) as unknown as typeof fetch;
    const instance = new AdapterRegistry(REGISTRY, environment(fetcher)).for(entry.carrier)!;
    const result = await instance.track({ number: entry.number });
    expect(result.current_stage).toBe('delivered'); expect(result.events).toHaveLength(entry.count);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reaches native history from explicit selection while retaining local clocks and enrichment provenance', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (entry.carrier === 'profit-fields' && new URL(String(url)).hostname === 'tracking.speedx.io') {
        expect(String(url)).toBe('https://tracking.speedx.io/SPXABC974682510368142731');
        const absent = readFileSync(new URL('../carriers/speedx/fixtures/not-found.rsc', import.meta.url), 'utf8')
          .replace(/SPX[A-Z]{3}\d{12,18}/g, 'SPXABC974682510368142731');
        return new Response(absent, { headers: { 'Content-Type': 'text/x-component' } });
      }
      entry.request(new URL(String(url)), init);
      return new Response(body(entry));
    }) as unknown as typeof fetch;
    const response = await createTracker({ fetcher, providers: [], env: {} }).track({ carrier: entry.carrier, number: entry.number });
    expect(response.source).toBe(entry.carrier);
    expect(response.result.current_stage).toBe('delivered'); expect(response.result.events).toHaveLength(entry.count);
    expect(response.result.events.every(event => event.local_time ? (!event.time || (event.time_zone && event.time_zone_basis)) : Boolean(event.time))).toBe(true);
    if (entry.carrier === 'expedico') expect(response.handoff).toBeUndefined();
    if (entry.carrier === 'profit-fields') {
      expect(response.handoff).toMatchObject({ carrier: 'speedx', number: 'SPXABC974682510368142731', basis: 'reference', confirmed: false });
    }
    expect(fetcher).toHaveBeenCalledTimes(entry.carrier === 'profit-fields' ? 2 : 1);
  });

  it('retries a connection failure once and retains HTTP, parse and challenge failure kinds', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('connection failed')).mockResolvedValueOnce(new Response(body(entry))) as unknown as typeof fetch;
    expect((await entry.factory(environment(fetcher)).track({ number: entry.number })).events).toHaveLength(entry.count);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [status, text, kind] of [
      [403, 'denied', 'challenge'], [429, 'slow down', 'rate_limited'], [503, 'unavailable', 'maintenance'],
      [404, 'gone', 'transport'], [302, '', 'transport'], [200, 'changed', 'schema'],
      [200, '<title>Just a moment</title>', 'challenge'],
    ] as const) {
      const fetcher = vi.fn(async () => new Response(text, { status, headers: { 'Retry-After': '60' } })) as unknown as typeof fetch;
      await expect(entry.factory(environment(fetcher)).track({ number: entry.number })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('honours cancellation, the aggregate budget, the body cap and unsupported-reference fallback', async () => {
    const fetcher = vi.fn(); const controller = new AbortController(); controller.abort();
    const instance = entry.factory(environment(fetcher));
    await expect(instance.track({ number: entry.number }, { signal: controller.signal })).rejects.toThrow();
    await expect(instance.track({ number: entry.number }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(instance.track({ number: 'UNSUPPORTED7' })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'unsupported_reference' });
    expect(fetcher).not.toHaveBeenCalled();
    const oversized = vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))) as unknown as typeof fetch;
    await expect(entry.factory(environment(oversized)).track({ number: entry.number })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(oversized).toHaveBeenCalledTimes(1);
    const waiting = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch;
    const started = performance.now();
    const failure = await entry.factory(environment(waiting)).track({ number: entry.number }, { budgetMs: 30 }).catch(error => error);
    expect(['transport', 'budget']).toContain(failure.kind);
    expect(performance.now() - started).toBeLessThan(500);
    expect(vi.mocked(waiting).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(waiting).mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('guest adapter routing and recognition', () => {
  it('confirms existing Fez and ShipGlobal suggestions without adding postal or twelve-digit candidates', () => {
    expect(recognitionAskedCarriers(cases[0]!.number)).toContain('fez-delivery');
    expect(recognitionAskedCarriers(cases[2]!.number)).toContain('shipglobal-us');
    expect(detectCarrierMatch(cases[1]!.number).carrier).toBe('royal-mail');
    expect(recognitionCandidates(cases[1]!.number).map(candidate => candidate.carrier)).not.toContain('junfeng-international');
    expect(recognitionCandidates(cases[3]!.number).map(candidate => candidate.carrier)).not.toContain('royale-international');
    for (const entry of cases.slice(4).filter(entry => entry.carrier !== 'profit-fields')) expect(recognitionCandidates(entry.number).map(candidate => candidate.carrier)).not.toContain(entry.carrier);
    for (const entry of cases) {
      expect(hasDirectHandoffAdapter(entry.carrier, entry.number)).toBe(true);
      expect(hasDirectHandoffAdapter(entry.carrier, 'UNSUPPORTED7')).toBe(false);
    }
  });

  it('recognizes only the supplied HTTP history, with exact Fez absence negative and ShipGlobal absence inconclusive', async () => {
    for (const entry of [cases[0]!, cases[2]!]) {
      const instance = entry.factory(environment(vi.fn(async () => new Response(body(entry)))));
      await expect(instance.recognize!(entry.number)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-07-04T10:20:30' });
      await expect(instance.recognize!('UNSUPPORTED7')).resolves.toEqual({ known: false });
    }
    const fez = fezDelivery(environment(vi.fn(async () => Response.json({ status: 'Error', description: 'Order Not Found', history: '' }))));
    await expect(fez.recognize!(cases[0]!.number)).resolves.toEqual({ known: false });
    const ship = shipglobalUs(environment(vi.fn(async () => Response.json({ message: 'Invalid tracking number' }, { status: 400 }))));
    await expect(ship.recognize!(cases[2]!.number)).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
