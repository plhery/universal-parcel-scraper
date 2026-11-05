import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adapter as lmParcel } from '../carriers/lm-parcel/adapter.js';
import { adapter as znlogic } from '../carriers/znlogic/adapter.js';
import type { AdapterFactory } from '../core/adapter/index.js';
import { AdapterRegistry } from '../core/adapter/index.js';
import { hasDirectHandoffAdapter } from '../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../core/catalog/recognition.js';
import { detectCarrierMatch } from '../core/detection/index.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { createTracker } from '../facade/index.js';
import { REGISTRY } from '../generated/registry.js';

const fixture = (carrier: string, name: string) => readFileSync(new URL(`../carriers/${carrier}/fixtures/${name}`, import.meta.url), 'utf8');
const environment = (fetcher: typeof fetch) => ({ fetcher, userAgent: 'consumer-agent', recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const cases: { carrier: string; number: string; factory: AdapterFactory; count: number; requests: number; response: (url: string) => Response }[] = [
  { carrier: 'lm-parcel', number: 'LM9746825104', factory: lmParcel, count: 14, requests: 2,
    response: url => new Response(fixture('lm-parcel', url.includes('findwaybillDetails') ? 'details.json' : 'summary.json')) },
  { carrier: 'znlogic', number: 'ZPYXY9746825104YQ', factory: znlogic, count: 6, requests: 1,
    response: () => new Response(fixture('znlogic', 'tracking.json')) },
];

describe.each(cases)('$carrier native guest transport', entry => {
  it('uses the supplied transport, whole identity and one aggregate budget across its requests', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get('User-Agent')).toBe('consumer-agent'); expect(headers.has('Cookie')).toBe(false); expect(headers.has('Authorization')).toBe(false);
      if (entry.carrier === 'lm-parcel') {
        if (String(url).includes('findwaybillDetails')) {
          expect(String(url)).toBe(`https://www.lmparcel.com/route-soa/route/findwaybillDetails?waybillNo=${entry.number}`);
          expect(init?.method).toBeUndefined();
        } else {
          expect(String(url)).toBe('https://www.lmparcel.com/route-soa/route/findwaybill');
          expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body))).toEqual([entry.number]);
        }
      } else expect(String(url)).toBe(`https://tracking.link/api/tracking/${entry.number}`);
      return entry.response(String(url));
    }) as unknown as typeof fetch;
    const instance = new AdapterRegistry(REGISTRY, environment(fetcher)).for(entry.carrier)!;
    expect((await instance.track({ number: entry.number })).events).toHaveLength(entry.count);
    expect(fetcher).toHaveBeenCalledTimes(entry.requests);
    await expect(instance.recognize!(entry.number)).resolves.toMatchObject(entry.carrier === 'lm-parcel'
      ? { known: true, lastActivityAt: '2026-01-06T23:53:15.000Z' }
      : { known: true, lastActivityAt: null, lastActivityLocal: '2026-01-06T12:43:00' });
  });

  it('retries the complete read only after a network failure, including a failed second request', async () => {
    let calls = 0;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      calls++;
      if (calls === entry.requests) throw new TypeError('connection reset');
      return entry.response(String(url));
    }) as unknown as typeof fetch;
    expect((await entry.factory(environment(fetcher)).track({ number: entry.number })).events).toHaveLength(entry.count);
    expect(fetcher).toHaveBeenCalledTimes(entry.requests * 2);
  });

  it('keeps refusals, rate limits, absent routes and malformed replies distinct without retry', async () => {
    for (const [status, text, kind] of [
      [403, 'denied', 'challenge'], [429, 'slow down', 'rate_limited'], [503, 'unavailable', 'maintenance'],
      [404, 'missing route', 'transport'], [302, '', 'transport'], [200, 'changed', 'schema'],
      [200, '<title>Just a moment</title>', 'challenge'],
    ] as const) {
      const fetcher = vi.fn(async () => new Response(text, { status, headers: { 'Retry-After': '60' } })) as unknown as typeof fetch;
      await expect(entry.factory(environment(fetcher)).track({ number: entry.number })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const response = entry.response(String(url)); Object.defineProperty(response, 'url', { value: 'https://other.example/tracking' }); return response;
    }) as unknown as typeof fetch;
    await expect(entry.factory(environment(fetcher)).track({ number: entry.number })).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honours cancellation, deadline, body cap and unsupported-reference fallback', async () => {
    const fetcher = vi.fn(), controller = new AbortController(); controller.abort();
    const instance = entry.factory(environment(fetcher));
    await expect(instance.track({ number: entry.number }, { signal: controller.signal })).rejects.toThrow();
    await expect(instance.track({ number: entry.number }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(instance.track({ number: 'UNSUPPORTED7' })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'unsupported_reference' });
    await expect(instance.recognize!('UNSUPPORTED7')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    const oversized = vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1))) as unknown as typeof fetch;
    await expect(entry.factory(environment(oversized)).track({ number: entry.number })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(oversized).toHaveBeenCalledTimes(1);
    const waiting = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch;
    const started = performance.now();
    const failure = await entry.factory(environment(waiting)).track({ number: entry.number }, { budgetMs: 40 }).catch(error => error);
    expect(['transport', 'budget']).toContain(failure.kind); expect(performance.now() - started).toBeLessThan(500);
    expect(vi.mocked(waiting).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('reaches the facade and keeps native history when a whole-reference partner confirmation fails', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (new URL(String(url)).hostname === 'tracking.speedx.io') {
        expect(String(url)).toBe('https://tracking.speedx.io/SPXABC974682510368');
        const body = fixture('speedx', 'not-found.rsc').replace(/SPX[A-Z]{3}\d{12,18}/g, 'SPXABC974682510368');
        return new Response(body, { headers: { 'Content-Type': 'text/x-component' } });
      }
      return entry.response(String(url));
    }) as unknown as typeof fetch;
    const response = await createTracker({ fetcher, providers: [], env: {} }).track({ carrier: entry.carrier, number: entry.number });
    expect(response.source).toBe(entry.carrier); expect(response.result.events).toHaveLength(entry.count);
    expect(response.result.current_stage).toBe('delivered');
    if (entry.carrier === 'lm-parcel') expect(response.handoff).toMatchObject({ carrier: 'speedx', number: 'SPXABC974682510368', confirmed: false });
    else {
      expect(response.handoff).toBeUndefined();
      expect(response.result.events[0]).toMatchObject({ local_time: '2026-01-06T12:43:00', time_zone_basis: 'place' });
    }
    expect(fetcher).toHaveBeenCalledTimes(entry.requests + (entry.carrier === 'lm-parcel' ? 1 : 0));
  });

  it('offers only the existing own-reference suggestion to HTTP recognition and handoffs', () => {
    expect(detectCarrierMatch(entry.number).candidates).toContain(entry.carrier);
    expect(recognitionAskedCarriers(entry.number)).toContain(entry.carrier);
    expect(hasDirectHandoffAdapter(entry.carrier, entry.number)).toBe(true);
    expect(hasDirectHandoffAdapter(entry.carrier, 'SPXABC974682510368')).toBe(false);
    expect(detectCarrierMatch('SPXABC974682510368').carrier).toBe('speedx');
  });
});

it('ends LM lookup after a bound negative or cancellation without asking for details', async () => {
  const number = cases[0]!.number;
  const negative = vi.fn(async () => Response.json({ code: '0', success: true, data: [{ searchNo: number, waybillNo: null, status: 1, originTime: 0, occurTime: 0,
    originCountry: null, targetCountry: null, routeType: null, routeContent: null, occurCountry: null, occurAddr: null }] }));
  await expect(lmParcel(environment(negative)).track({ number })).rejects.toMatchObject({ kind: 'not_found' });
  expect(negative).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  const aborting = vi.fn(async () => { controller.abort(); return cases[0]!.response('findwaybill'); });
  await expect(lmParcel(environment(aborting)).track({ number }, { signal: controller.signal })).rejects.toThrow();
  expect(aborting).toHaveBeenCalledTimes(1);
});
