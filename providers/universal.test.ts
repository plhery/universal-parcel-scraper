// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierErrorKind } from '../core/errors/index.js';
import type { CarrierResult } from '../core/result/index.js';
import { parcelOwners } from '../core/result/partial.js';
import type { LookupRecord, StepRecord, StepRecorder } from '../core/telemetry/index.js';
import { TrawlClient } from '../core/transport/index.js';
import { parseTrackingInput } from '../core/detection/index.js';
import { fakeBudgetClock } from '../testing/budgetClock.js';
import { UniversalTracker, UniversalTrackingError, orderUniversalSources, universalPlan, universalSources, UNIVERSAL_SOURCES, type UniversalTrackerOptions } from './universal.js';
import type { UniversalSource } from './types.js';

// Its draw asks ParcelsApp before Ship24 (plan.ts): the chain tests below start with ParcelsApp's reply.
const number = 'ZZ12340678904';
const identity = (value = number) => `<div class="tracking-info"><div class="parcel"><table class="parcel-attributes"><tr><td>Tracking number</td><td>${value}</td></tr></table></div></div>`;
const track17 = {
  meta: { code: 200 }, shipments: [{ number, code: 200, shipment: {
    tracking: { providers: [{ events: [{ time_utc: '2026-08-31T18:50:50Z', description: 'Delivered', stage: 'Delivered' }] }] },
  } }],
};
// The postal union's feed keeps ParcelsApp's label: a scan of a network nothing knows would keep only its wall clock.
const parcels = { carriers: ['Universal Postal Union'], states: [{ date: '2026-08-18T03:04:00Z', status: 'Electronic information submitted by shipper', carrier: 0 }] };
const reply = (data: unknown) => new Response(JSON.stringify(data), { status: 201 });
/** What the browser seam returns for a provider: one dated scan at the given stage. */
const seen = (source: string, stage: string) => ({ tracking_provider: source, current_stage: stage,
  events: [{ time: '2026-08-31T18:50:50.000Z', description: 'Scanned', stage }] });
const browserResponse = (source: '17TRACK' | 'ParcelsApp', data: unknown, overrides = {}) => new Response(JSON.stringify({
  url: source === '17TRACK' ? `https://t.17track.net/en#nums=${number}` : `https://parcelsapp.com/en/tracking/${number}`,
  html: identity(), statusCode: 200, tier: 3,
  capturedResponses: [{ url: source === '17TRACK' ? 'https://t.17track.net/track/restapi' : 'https://parcelsapp.com/api/v2/parcels',
    body: JSON.stringify(data), status: 200, truncated: false, base64Encoded: false }],
  ...overrides,
}));

describe('universal discovery chain', () => {
  it('prefers 17TRACK only for validated China Post C/L families', () => {
    for (const postal of ['LZ000000005CN', 'CY000000005CN', 'lz 0000 0000 5 cn']) {
      expect(universalSources(false, postal)[0]).toBe('17TRACK');
      expect(universalSources(true, postal).slice(-2)).toEqual(['Postal Ninja', 'UPU']);
    }
    // Someone may be waiting: the HTTP providers lead every other number.
    for (const other of ['EB999999987CN', 'RR000000005CN', 'LZ000000005NL', 'LZ000000006CN', '1234/12345678']) {
      expect(['ParcelsApp', 'Ship24']).toContain(universalSources(false, other)[0]);
    }
  });

  it('keeps the persisted provider names and the opt-in position of Postal Ninja', () => {
    expect(UNIVERSAL_SOURCES).toEqual(['ParcelsApp', 'Ship24', '17TRACK', 'Track718', 'Ordertracker', 'UPU']);
    // Without a number, the largest share leads.
    expect(universalSources()).toEqual(['Ship24', 'ParcelsApp', '17TRACK', 'UPU']);
    expect(universalSources(true)).toEqual(['Ship24', 'ParcelsApp', '17TRACK', 'Postal Ninja', 'UPU']);
    expect(universalSources(false, number)).toEqual(['ParcelsApp', 'Ship24', '17TRACK']);
    expect(universalSources(false, 'EB999999987CN').at(-1)).toBe('UPU');
    // A carrier's coverage evidence reorders them.
    expect(universalPlan({ carriers: ['usps'], trackingNumber: number }).sources).toEqual(['17TRACK', 'ParcelsApp', 'Ordertracker', 'Ship24']);
  });

  it('shares the numbers among equal providers by their share, each number keeping its order', () => {
    const numbers = Array.from({ length: 4000 }, (_, index) => `ZZ${10_000_000_000 + index * 7919}`);
    const leads = (background: boolean) => {
      const counts: Partial<Record<UniversalSource, number>> = {};
      for (const trackingNumber of numbers) {
        const [first] = universalPlan({ trackingNumber, background }).sources;
        counts[first!] = (counts[first!] ?? 0) + 1;
      }
      return counts;
    };
    // Someone may be waiting: the HTTP providers lead, Ship24 for two numbers in three.
    const waiting = leads(false);
    expect(Object.keys(waiting).sort()).toEqual(['ParcelsApp', 'Ship24']);
    expect(waiting.Ship24! / numbers.length).toBeCloseTo(4 / 6, 1);
    // In the background the browser providers take their part too.
    const background = leads(true);
    expect(background.Ship24! / numbers.length).toBeCloseTo(4 / 7, 1);
    expect(background.ParcelsApp! / numbers.length).toBeCloseTo(2 / 7, 1);
    expect(background['17TRACK']! / numbers.length).toBeCloseTo(1 / 7, 1);
    // However the number is written.
    expect(universalSources(false, 'zz 1234-0678.904')).toEqual(universalSources(false, number));
    // A provider left out leaves the others in their order.
    for (const trackingNumber of numbers.slice(0, 200)) {
      const all = orderUniversalSources(['ParcelsApp', 'Ship24', '17TRACK'], null, { trackingNumber, background: true });
      expect(orderUniversalSources(['ParcelsApp', '17TRACK'], null, { trackingNumber, background: true }))
        .toEqual(all.filter((source) => source !== 'Ship24'));
    }
  });

  it('asks no provider about a carrier none has answered for, unless another carrier is named first', () => {
    for (const carrier of ['flash-courier', 'j-and-t-br', 'j-and-t-de']) {
      expect(universalPlan({ carriers: [carrier], trackingNumber: number, enablePostalNinja: true }).sources, carrier).toEqual([]);
      expect(universalPlan({ carriers: [null, carrier], trackingNumber: number }).sources, carrier).toEqual([]);
    }
    // Providers are the only route for a carrier without an adapter.
    expect(universalPlan({ carriers: ['azul-cargo'], trackingNumber: number }).sources).toEqual(['ParcelsApp', 'Ship24', '17TRACK']);
    expect(universalPlan({ carriers: ['usps', 'j-and-t-de'], trackingNumber: number }).sources).toEqual(['17TRACK', 'ParcelsApp', 'Ordertracker', 'Ship24']);
  });

  it('leaves out only the provider that has not answered for a carrier', () => {
    expect(universalPlan({ carriers: ['gzyl'], trackingNumber: number }).sources).toEqual(['ParcelsApp', '17TRACK']);
    expect(universalPlan({ carriers: ['gzyl'], trackingNumber: number, enablePostalNinja: true }).sources).not.toContain('Ship24');
    expect(universalPlan({ carriers: ['usps', 'gzyl'], trackingNumber: number }).sources).toContain('Ship24');
  });

  it('starts with ParcelsApp and stops after success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(parcels));
    const browserLookup = vi.fn().mockRejectedValue(new Error('Unavailable'));
    const result = await new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test/v1', fetcher, browserLookup }).fetch(number);
    expect(result.current_stage).toBe('registered');
    expect(result.tracking_provider).toBe('ParcelsApp');
    // The tracking page for its ticket, then the lookup.
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`https://parcelsapp.com/en/tracking/${number}`, 'https://parcelsapp.com/api/v2/parcels']);
    expect(browserLookup).not.toHaveBeenCalled();
    const [url, options] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://parcelsapp.com/api/v2/parcels');
    expect(new URLSearchParams(String(options!.body)).get('carrier')).toBe('Auto-Detect');
  });

  it('ends the chain on the caller\'s signal and spends one budget across providers', async () => {
    const browserLookup = vi.fn().mockRejectedValue(new Error('Unavailable'));
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK'], trawlUrl: '', fetcher, browserLookup });
    await expect(tracker.fetch(number, null, { signal: AbortSignal.abort(new Error('caller cancelled')) })).rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = tracker.fetch(number, null, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserLookup).not.toHaveBeenCalled();
    fetcher.mockClear();
    const spent = await tracker.fetch(number, null, { budgetMs: 80 }).catch((error: unknown) => error);
    expect(spent).toBeInstanceOf(UniversalTrackingError);
    // The first source used the budget: the others are reported as never asked.
    expect((spent as UniversalTrackingError).failures.map(({ source, error }) => [source, carrierErrorKind(error)]))
      .toEqual([['ParcelsApp', 'transport'], ['Ship24', 'budget'], ['17TRACK', 'budget']]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserLookup).not.toHaveBeenCalled();
  });

  it('continues to another provider when prioritized 17TRACK returns no history', async () => {
    const postalNumber = 'LZ000000014CN';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith('https://parcelsapp.com/')
      ? new Response('', { status: 503 })
      : browserResponse('17TRACK', { meta: { code: 200 }, shipments: [{ number: postalNumber, code: 400, shipment: null }] },
        { url: `https://t.17track.net/en#nums=${postalNumber}` }));
    const browserLookup = vi.fn().mockResolvedValue(seen('Ship24', 'delivered'));
    await expect(new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher, browserLookup }).fetch(postalNumber))
      .resolves.toMatchObject({ tracking_provider: 'Ship24', current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['browser.test', 'parcelsapp.com']);
    expect(browserLookup.mock.calls).toEqual([['Ship24', postalNumber]]);
  });

  it('reaches the real UPU factory only after richer lookups fail for an eligible postal number', async () => {
    const postalNumber = 'EB000000014CN';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('globaltracktrace.ptc.post')
      ? Response.json([{ ID: postalNumber, Events: [{ EventCd: 'EMA', EventNm: 'Posting/Collection',
        EventDT: '2026-09-20T10:00:00Z' }] }])
      : new Response('', { status: 404 }));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  fetcher, trawlUrl: '' });
    await expect(tracker.fetch(postalNumber)).resolves.toMatchObject({ tracking_provider: 'UPU', current_stage: 'accepted' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname))
      .toEqual(['api.ship24.com', 'parcelsapp.com', 'globaltracktrace.ptc.post']);
  });

  it('falls through an unrelated ParcelsApp result to 17TRACK', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html></html>')).mockResolvedValueOnce(reply({ error: 'RELOAD' }))
      .mockResolvedValueOnce(browserResponse('ParcelsApp', parcels, { html: identity('OTHER123') }))
      .mockResolvedValueOnce(browserResponse('17TRACK', track17));
    const result = await new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher, browserLookup: vi.fn().mockRejectedValue(new Error('Unavailable')) }).fetch(number);
    expect(result.tracking_provider).toBe('17TRACK');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('retains provider failures for Sentry while keeping the lookup summary readable', async () => {
    const originalError = new Error('SECRET upstream cookie');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(originalError);
    const error = await new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher, browserLookup: vi.fn().mockRejectedValue(new Error('Unavailable')) }).fetch(number).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'UniversalTrackingError' });
    expect(String(error)).not.toContain('SECRET');
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toBeInstanceOf(UniversalTrackingError);
    const errors = (error as AggregateError).errors;
    expect(errors).toHaveLength(3);
    // ParcelsApp and 17TRACK went through the fetcher; Ship24 through the browser lookup.
    for (const providerError of [errors[0], errors[2]]) {
      expect(providerError.cause).toBe(originalError);
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('tries Postal Ninja only after the other aggregators fail', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unavailable'));
    const browserLookup = vi.fn().mockRejectedValueOnce(new Error('Challenge'))
      .mockResolvedValueOnce(seen('Postal Ninja', 'delivered'));
    const result = await new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher, browserLookup, enablePostalNinja: true }).fetch(number);
    expect(result.tracking_provider).toBe('Postal Ninja');
    expect(browserLookup.mock.calls).toEqual([['Ship24', number], ['Postal Ninja', number]]);
    // ParcelsApp's two requests, then 17TRACK's capture.
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['parcelsapp.com', 'parcelsapp.com', 'browser.test']);
  });

  it('can use the form scrapers without TRAWL and stops on Ship24 success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    const browserLookup = vi.fn().mockResolvedValue(seen('Ship24', 'in_transit'));
    await expect(new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: '', fetcher, browserLookup }).fetch(number)).resolves.toMatchObject({ tracking_provider: 'Ship24' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browserLookup).toHaveBeenCalledOnce();
  });

  it('does not request arbitrary user URLs and validates identifiers before network access', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: 'http://browser.test', fetcher }).fetch('http://localhost')).rejects.toThrow('Invalid tracking number');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('takes the browser service and the telemetry sink from the adapter environment', async () => {
    const steps: StepRecord[] = [];
    const lookups: LookupRecord[] = [];
    const recorder: StepRecorder = { step: (record) => { steps.push(record); }, lookup: (record) => { lookups.push(record); } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(browserResponse('17TRACK', track17));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  environment: { trawl: new TrawlClient('http://browser.test', fetcher), recorder } });
    await expect(tracker.fetchSource('17TRACK', number, 20_000)).resolves.toMatchObject({ tracking_provider: '17TRACK' });
    expect(steps).toMatchObject([{ carrier: '17TRACK', step: 'trawl', attempt: 1, outcome: 'ok', fallbackFrom: null }]);
    expect(lookups).toMatchObject([{ carrier: '17TRACK', finalStep: 'trawl', outcome: 'ok', attempts: 1 }]);
    // The browser service is given whole milliseconds of the remaining budget.
    const { maxTimeout } = JSON.parse(String(fetcher.mock.calls[0]![1]!.body)) as { maxTimeout: number };
    expect(Number.isInteger(maxTimeout)).toBe(true);
    expect(maxTimeout).toBeGreaterThan(19_000);
    expect(maxTimeout).toBeLessThanOrEqual(20_000);
  });

  it('submits a stored postcode to ParcelsApp without a browser service', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(parcels));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  trawlUrl: '', fetcher,
      browserLookup: vi.fn().mockRejectedValue(new Error('Ship24 unavailable')) });
    await expect(tracker.fetchSource('ParcelsApp', number, 20_000, '01234')).resolves.toMatchObject({ tracking_provider: 'ParcelsApp' });
    await expect(tracker.fetch(number, '01234')).resolves.toMatchObject({ tracking_provider: 'ParcelsApp' });
    // Each lookup opens the tracking page for its ticket first.
    expect(fetcher).toHaveBeenCalledTimes(4);
    const lookups = fetcher.mock.calls.filter(([url]) => String(url) === 'https://parcelsapp.com/api/v2/parcels');
    expect(lookups).toHaveLength(2);
    for (const [, init] of lookups) {
      expect(new URLSearchParams(String(init!.body)).get('extra[zipcode]')).toBe('01234');
    }
  });

  it("reads a provider's copy of a USPS return as USPS does: the facility scans after it are the trip back", async () => {
    // A public sample of jkeen/tracking_number_data; the scans are synthetic.
    const usps = '9400111201080805483016';
    const ship24History = { data: { tracking_number: usps, events: [
      { timestamp: '2026-11-01T18:54:00Z', status: 'Arrived at USPS Facility' },
      { timestamp: '2026-10-30T19:13:00Z', status: 'Return to Sender Processed' },
      { timestamp: '2026-10-30T15:02:00Z', status: 'Out for Delivery' },
    ] } };
    const tracker = new UniversalTracker({ providers: ['Ship24'], fetcher: vi.fn<typeof fetch>().mockImplementation(async () => reply(ship24History)) });
    const read = await tracker.fetchSource('Ship24', usps, 20_000, null, null, undefined, null, 'usps');
    expect(read).toMatchObject({ current_stage: 'returned', tracking_provider: 'Ship24' });
    expect(read.events?.map((event) => event.stage)).toEqual(['returned', 'returned', 'out_for_delivery']);
    await expect(tracker.fetchSource('Ship24', usps, 20_000)).resolves.toMatchObject({ current_stage: 'in_transit' });
  });

  it('forwards a stored delivery postcode into the provider track input', async () => {
    const ship24History = { data: { tracking_number: number,
      events: [{ timestamp: '2026-09-10T10:00:00+02:00', status: 'Delivered', dispatch_code_id: 7 }] } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith('https://parcelsapp.com/')
      ? new Response('', { status: 503 }) : reply(ship24History));
    const tracker = new UniversalTracker({ providers: ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'],  fetcher });
    await expect(tracker.fetchSource('Ship24', number, 20_000, '8000')).resolves.toMatchObject({
      current_stage: 'delivered', tracking_provider: 'Ship24',
    });
    await expect(tracker.fetch(number, '8000')).resolves.toMatchObject({
      current_stage: 'delivered', tracking_provider: 'Ship24',
    });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['api.ship24.com', 'parcelsapp.com', 'api.ship24.com']);
  });

  it('asks for the package identifier of a USPS routing barcode, never the ZIP code before it', async () => {
    // Invented package identifiers behind the made-up ZIP code 00314, with or without a ZIP+4: 30, 34 and
    // 38 digits. In the last two, the other reading passes the check digit too, as a channel 92 PIC whose
    // Mailer ID does not start with 9.
    const pic = '9210090000000012345679';
    const pic26 = '92000000000123456789012344';
    const wide = '93009200000000123456789013';
    for (const [typed, expected] of [[`420 00314 ${pic}`, pic], [`420003142718${pic}`, pic], [`42000314${pic26}`, pic26],
      [`420003142718${pic26}`, pic26], [`420003149201${pic}`, pic], [`42000314${wide}`, wide]] as const) {
      const history = { data: { tracking_number: expected,
        events: [{ timestamp: '2026-09-10T10:00:00-04:00', status: 'Delivered', dispatch_code_id: 7 }] } };
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(history));
      const tracker = new UniversalTracker({ providers: ['Ship24'], fetcher });
      await expect(tracker.fetchSource('Ship24', typed, 20_000)).resolves.toMatchObject({ current_stage: 'delivered' });
      await expect(tracker.fetch(typed)).resolves.toMatchObject({ current_stage: 'delivered' });
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(Array(2).fill(`/api/parcels/${expected}`));
      expect(fetcher.mock.calls.map(([url, init]) => `${String(url)} ${String(init?.body)}`).join(' ')).not.toContain('00314');
    }
  });

  it('asks providers for the zero a letter O stands for in an S10 serial, however the caller stored it', async () => {
    const history = { data: { tracking_number: 'CI000000014NL',
      events: [{ timestamp: '2026-09-10T10:00:00+02:00', status: 'Delivered', dispatch_code_id: 7 }] } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(history));
    const tracker = new UniversalTracker({ providers: ['Ship24'], fetcher });
    await expect(tracker.fetchSource('Ship24', 'CIO00000014NL', 20_000)).resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(tracker.fetch('cio 0000001 4nl')).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(Array(2).fill('/api/parcels/CI000000014NL'));
  });

  it('sends no provider a USPS routing barcode without a single package identifier, nor either reading', async () => {
    // The made-up ZIP code 00314. The ZIP+4 9300 and the PIC read as a channel 93 PIC that passes its check
    // digit too, each Mailer ID fitting its channel; the other barcode fails its check digit.
    const pic = '9210090000000012345679';
    const providers = ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'] as const;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const browserLookup = vi.fn().mockRejectedValue(new Error('no lookup expected'));
    for (const options of [{ trawlUrl: 'http://browser.test' }, { browserLookup }]) {
      const tracker = new UniversalTracker({ providers: [...providers], enablePostalNinja: true, fetcher, ...options });
      for (const typed of [`420003149300${pic}`, `42000314${pic.slice(0, -1)}0`]) {
        for (const source of providers) {
          await expect(tracker.fetchSource(source, typed, 20_000))
            .rejects.toMatchObject({ kind: 'indeterminate', provider: source, reason: 'usps_routing_barcode' });
        }
        const chain = await tracker.fetch(typed).catch((error: unknown) => error);
        expect(chain).toBeInstanceOf(UniversalTrackingError);
        expect((chain as UniversalTrackingError).failures.length).toBeGreaterThan(0);
        for (const { error } of (chain as UniversalTrackingError).failures) {
          expect(error).toMatchObject({ kind: 'indeterminate', reason: 'usps_routing_barcode' });
        }
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(browserLookup).not.toHaveBeenCalled();
  });

  it('sends no provider a placeholder number, under which they merge other shipments', async () => {
    const providers = ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'] as const;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const browserLookup = vi.fn().mockRejectedValue(new Error('no lookup expected'));
    for (const options of [{ trawlUrl: 'http://browser.test' }, { browserLookup }]) {
      const tracker = new UniversalTracker({ providers: [...providers], enablePostalNinja: true, fetcher, ...options });
      for (const typed of ['1234567890', '0000000000000', 'rr 0000 0000 5 cn']) {
        for (const source of providers) {
          await expect(tracker.fetchSource(source, typed, 20_000))
            .rejects.toMatchObject({ kind: 'invalid_input', provider: source, reason: 'placeholder_number' });
        }
        await expect(tracker.fetch(typed)).rejects.toBeInstanceOf(UniversalTrackingError);
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(browserLookup).not.toHaveBeenCalled();
  });

  it("sends no provider the token of an Amazon order's tracking link, which opens the parcel", async () => {
    const providers = ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'] as const;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const tracker = new UniversalTracker({ providers: [...providers], enablePostalNinja: true, trawlUrl: 'http://browser.test', fetcher });
    for (const source of providers) {
      await expect(tracker.fetchSource(source, '0F1E2D3C4B5A49688776A5B4C3D2E1F0', 20_000, null, null, undefined, null, 'amazon-order'))
        .rejects.toMatchObject({ kind: 'invalid_input', provider: source, reason: 'link_token' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends no provider a number of a share token's shape that no other carrier is named for", async () => {
    // Synthetic token. The link's token is the number parseTrackingInput reads, and an integration may pass it on alone.
    const SYNTHETIC = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
    const link = `https://www.amazon.co.uk/progress-tracker/package/share/?vt=SHARED_PACKAGE_TRACKING&shareToken=${SYNTHETIC}`;
    const { trackingNumber } = parseTrackingInput(link);
    const providers = ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja', 'UPU'] as const;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const browserLookup = vi.fn<NonNullable<UniversalTrackerOptions['browserLookup']>>().mockRejectedValue(new Error('no lookup expected'));
    for (const options of [{ trawlUrl: 'http://browser.test' }, { browserLookup }]) {
      const tracker = new UniversalTracker({ providers: [...providers], enablePostalNinja: true, fetcher, ...options });
      for (const number of [trackingNumber, trackingNumber.toUpperCase().replace(/-/g, '')]) {
        for (const carrier of [undefined, null, 'unknown']) {
          for (const source of providers) {
            await expect(tracker.fetchSource(source, number, 20_000, null, null, undefined, null, carrier))
              .rejects.toMatchObject({ kind: 'invalid_input', provider: source, reason: 'link_token' });
          }
          await expect(tracker.fetch(number, null, {}, null, carrier)).rejects.toBeInstanceOf(UniversalTrackingError);
        }
        expect(universalPlan({ trackingNumber: number }).sources).toEqual([]);
      }
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(browserLookup).not.toHaveBeenCalled();
    // A carrier named for the number is asked about it, and thirty-two digits have no token's letter.
    expect(universalPlan({ carriers: ['fedex'], trackingNumber }).sources).not.toEqual([]);
    expect(universalPlan({ trackingNumber: '9'.repeat(32) }).sources).not.toEqual([]);
    const named = vi.fn<NonNullable<UniversalTrackerOptions['browserLookup']>>().mockRejectedValue(new Error('asked'));
    await expect(new UniversalTracker({ providers: ['Ship24'], browserLookup: named }).fetchSource('Ship24', trackingNumber, 20_000, null, null, undefined, null, 'fedex'))
      .rejects.toThrow('asked');
    expect(named).toHaveBeenCalledTimes(1);
  });

  it('sends a number of seven characters or fewer only with its carrier, whose shipment a provider would otherwise guess', async () => {
    const providers = ['ParcelsApp', 'Ship24', '17TRACK', 'Postal Ninja'] as const;
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const tracker = new UniversalTracker({ providers: [...providers], enablePostalNinja: true, trawlUrl: 'http://browser.test', fetcher });
    for (const typed of ['50417', 'AB12345', '5041 726']) {
      for (const source of providers) {
        for (const carrier of [undefined, null, 'unknown']) {
          await expect(tracker.fetchSource(source, typed, 20_000, null, null, undefined, null, carrier))
            .rejects.toMatchObject({ kind: 'indeterminate', provider: source, reason: 'short_number', name: 'NoHistoryError' });
        }
      }
      await expect(tracker.fetch(typed)).rejects.toBeInstanceOf(UniversalTrackingError);
    }
    expect(fetcher).not.toHaveBeenCalled();
    // With its carrier named, the number is sent.
    await expect(tracker.fetchSource('Ship24', '50417', 20_000, null, null, undefined, null, 'seur')).rejects.not.toMatchObject({ reason: 'short_number' });
    expect(fetcher).toHaveBeenCalled();
  });

  it('sends Track123 no number of seven characters or fewer, whose carrier its answer only repeats', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('no request expected'));
    const tracker = new UniversalTracker({ providers: ['Track123'], trawlUrl: 'http://browser.test', fetcher });
    for (const typed of ['5041726', 'AB12345', '5041 726']) {
      await expect(tracker.fetchSource('Track123', typed, 20_000, null, null, undefined, null, 'dhl'))
        .rejects.toMatchObject({ kind: 'indeterminate', provider: 'Track123', reason: 'short_number', name: 'NoHistoryError' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    // Eight characters are sent.
    await expect(tracker.fetchSource('Track123', '50417268', 20_000, null, null, undefined, null, 'dhl')).rejects.not.toMatchObject({ reason: 'short_number' });
  });

  it('takes an answer for a number that short only when it names the carrier, its brand or the partner after its own leg', async () => {
    const answer = (names: string[], discovered?: string, partner?: string): CarrierResult => ({
      status: 'delivered', current_stage: 'delivered', last_update: '2026-01-02T12:00:00.000Z',
      events: [{ time: '2026-01-02T12:00:00.000Z', description: 'Delivered', stage: 'delivered' }],
      reported_carriers: names, ...(discovered ? { discovered_carrier: discovered } : {}),
      ...(partner ? { delivery_carrier: partner, delivery_tracking_number: 'PARTNER12345' } : {}),
    });
    const lookup = (result: CarrierResult, carrier: string, typed = '58471') => new UniversalTracker({ providers: ['Ship24'],
      browserLookup: vi.fn().mockResolvedValue(result) }).fetchSource('Ship24', typed, 20_000, null, null, undefined, null, carrier);
    const refused = { kind: 'indeterminate', name: 'NoHistoryError', provider: 'Ship24', reason: 'unattributed_history' };
    // Another carrier's parcel, or a parcel the answer names no carrier for.
    await expect(lookup(answer(['Colissimo'], 'la-poste'), 'seur')).rejects.toMatchObject(refused);
    await expect(lookup(answer([]), 'seur')).rejects.toMatchObject(refused);
    await expect(lookup(answer(['Example Courier']), 'seur')).rejects.toMatchObject(refused);
    // The carrier, or another network of its brand.
    await expect(lookup(answer(['SEUR'], 'seur'), 'seur')).resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(lookup(answer(['DPD Austria'], 'dpd-at'), 'dpd-de')).resolves.toMatchObject({ discovered_carrier: 'dpd-at' });
    // The partner it hands the parcel to, beside the carrier's own leg; not that partner alone.
    await expect(lookup(answer(['SEUR', 'Correos'], 'correos-spain', 'correos-spain'), 'seur')).resolves.toMatchObject({ discovered_carrier: 'correos-spain' });
    await expect(lookup(answer(['Correos'], 'correos-spain', 'correos-spain'), 'seur')).rejects.toMatchObject(refused);
    // A longer number keeps any carrier the provider names, and an S10 item is every post's that carries it.
    await expect(lookup(answer(['Colissimo'], 'la-poste'), 'seur', '58471000')).resolves.toMatchObject({ discovered_carrier: 'la-poste' });
    await expect(lookup(answer(['Royal Mail'], 'royal-mail'), 'la-poste', 'RR102938478FR')).resolves.toMatchObject({ discovered_carrier: 'royal-mail' });
    expect(parcelOwners('la-poste', 'RR102938478FR', answer(['Royal Mail'], 'royal-mail'))).toBeNull();
  });

  it('turns down ParcelsApp\'s guess of another carrier for a number that short', async () => {
    const delivered = (carriers: string[]) => vi.fn<typeof fetch>().mockImplementation(async () => reply({ carriers,
      states: [{ date: '2026-01-02T12:00:00Z', status: 'Delivered', carrier: 0, location: 'Paris, France' }] }));
    const lookup = (fetcher: typeof fetch) => new UniversalTracker({ providers: ['ParcelsApp'], fetcher })
      .fetchSource('ParcelsApp', '58471', 20_000, null, null, undefined, null, 'seur');
    await expect(lookup(delivered(['Colissimo']))).rejects.toMatchObject({ name: 'NoHistoryError', reason: 'unattributed_history' });
    await expect(lookup(delivered(['SEUR']))).resolves.toMatchObject({ discovered_carrier: 'seur', current_stage: 'delivered' });
  });

  it('reads BUFFALO\'s round and "RETURNS" as ParcelsApp relays them, and no one else\'s', async () => {
    const states = [
      { date: '2026-03-03T17:10:00Z', status: 'RETURNS', carrier: 0 },
      { date: '2026-03-03T06:40:00Z', status: 'SCAN VEHICLE DEPARTURE', carrier: 0 },
    ];
    const lookup = (carriers: string[]) => new UniversalTracker({ providers: ['ParcelsApp'],
      fetcher: vi.fn<typeof fetch>().mockImplementation(async () => reply({ carriers, states })) }).fetchSource('ParcelsApp', 'BUFZA0SK00000BUYQ', 20_000);
    const buffalo = await lookup(['Buffalo Logistics']);
    expect(buffalo).toMatchObject({ discovered_carrier: 'buffalo-ex', current_stage: 'failed_attempt' });
    expect(buffalo.events?.find((event) => event.description === 'RETURNS')).toMatchObject({ stage: 'failed_attempt', stage_source: 'wording:provider' });
    expect(buffalo.events?.find((event) => event.description === 'SCAN VEHICLE DEPARTURE'))
      .toMatchObject({ stage: 'out_for_delivery', stage_source: 'wording:provider' });
    const other = await lookup(['Universal Postal Union']);
    expect(other.events?.find((event) => event.description === 'RETURNS')).toMatchObject({ stage: 'pending' });
  });

  it('treats a history without one dated scan as inconclusive and moves on', async () => {
    // No offset, courier or place: the scan keeps its wall time and has no instant.
    const undated = { data: { tracking_number: number, events: [{ timestamp: '2026-09-10T10:00:00', status: 'Delivered', dispatch_code_id: 7 }] } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).startsWith('https://api.ship24.com/')
      ? reply(undated) : browserResponse('17TRACK', track17));
    const tracker = new UniversalTracker({ providers: ['Ship24', '17TRACK'], trawlUrl: 'http://browser.test', fetcher });
    const refused = await tracker.fetchSource('Ship24', number, 20_000).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'indeterminate', provider: 'Ship24', reason: 'undated_history' });
    // With the parcel carrier's zone the same scan has an instant.
    await expect(tracker.fetchSource('Ship24', number, 20_000, null, 'Europe/Zurich'))
      .resolves.toMatchObject({ tracking_provider: 'Ship24', last_update: '2026-09-10T08:00:00.000Z' });
    await expect(tracker.fetch(number)).resolves.toMatchObject({ tracking_provider: '17TRACK' });
    const seam = new UniversalTracker({ providers: ['Postal Ninja'], enablePostalNinja: true, browserLookup: vi.fn().mockResolvedValue({
      tracking_provider: 'Postal Ninja', current_stage: 'delivered', events: [{ local_time: '2026-09-10T10:00:00', description: 'Delivered', stage: 'delivered' }],
    }) });
    await expect(seam.fetchSource('Postal Ninja', number)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'undated_history' });
    // An answer without scans is not an undated history.
    const bare = new UniversalTracker({ providers: ['Ship24'], browserLookup: vi.fn().mockResolvedValue({ tracking_provider: 'Ship24', current_stage: 'pending', events: [] }) });
    await expect(bare.fetchSource('Ship24', number)).resolves.toMatchObject({ tracking_provider: 'Ship24' });
  });
});

describe('a provider left while it reads the carriers', () => {
  // A Canada Post number, whose order starts with Ordertracker, then Ship24 and ParcelsApp.
  const postal = 'LA586492541CA';
  const fixture = (name: string) => new Response(readFileSync(new URL(`./ordertracker/fixtures/${name}.json`, import.meta.url)));
  /**
   * Ordertracker reading for 45 s: the request that waits gets `found` then, another one "No
   * information" until then and `found` after. Every other provider fails at once.
   */
  function reading(found: string) {
    const asked: Array<[host: string, second: number]> = [];
    const started = performance.now();
    const fetcher = vi.fn<typeof fetch>((url, init) => {
      const host = new URL(String(url)).hostname;
      const at = performance.now() - started;
      asked.push([host, Math.round(at / 1000)]);
      if (host !== 'api.ordertracker.com') return Promise.resolve(new Response('', { status: 503 }));
      if (at >= 45_000) return Promise.resolve(fixture(found));
      if (asked.filter(([name]) => name === host).length > 1) return Promise.resolve(fixture('no-information'));
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(fixture(found)), 45_000 - at);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason as Error); }, { once: true });
      });
    });
    const browserLookup = vi.fn().mockRejectedValue(new Error('Unavailable'));
    return { asked, tracker: new UniversalTracker({ providers: ['Ordertracker', 'Ship24', 'ParcelsApp'], trawlUrl: '', fetcher, browserLookup }) };
  }

  it('asks the next providers meanwhile and comes back for its answer', async () => {
    const clock = fakeBudgetClock();
    const { asked, tracker } = reading('canada-post-LA586492541CA');
    await expect(clock.settle(tracker.fetch(postal, null, {}, null, 'canada-post')))
      .resolves.toMatchObject({ tracking_provider: 'Ordertracker', current_stage: 'out_for_delivery' });
    // Left after its patience, asked again once ParcelsApp failed, then when its read ended.
    expect(asked).toEqual([['api.ordertracker.com', 0], ['parcelsapp.com', 15], ['api.ordertracker.com', 15], ['api.ordertracker.com', 47]]);
  });

  it('reports it once, as still reading, when the lookup ends before its read does', async () => {
    const clock = fakeBudgetClock();
    const { asked, tracker } = reading('canada-post-LA586492541CA');
    const failed = await clock.settle(tracker.fetch(postal, null, { budgetMs: 20_000 }, null, 'canada-post')).catch((error: unknown) => error);
    expect((failed as UniversalTrackingError).failures.map(({ source, error }) => [source, (error as { reason?: string }).reason]))
      .toEqual([['Ship24', undefined], ['ParcelsApp', undefined], ['Ordertracker', 'still_reading']]);
    expect(asked.map(([host]) => host)).toEqual(['api.ordertracker.com', 'parcelsapp.com', 'api.ordertracker.com']);
  });

  it('waits for the read itself when no other provider is left to ask', async () => {
    const clock = fakeBudgetClock();
    const { asked, tracker } = reading('no-information');
    const alone = new UniversalTracker({ ...tracker.options, providers: ['Ordertracker'] });
    const failed = await clock.settle(alone.fetch(postal, null, {}, null, 'canada-post')).catch((error: unknown) => error);
    expect((failed as UniversalTrackingError).failures).toMatchObject([{ source: 'Ordertracker', error: { name: 'NoHistoryError' } }]);
    expect(asked).toEqual([['api.ordertracker.com', 0]]);
  });
});

it('keeps Ship24 milestones with distinct codes through fetchSource', async () => {
  const events = ['00', '37'].map((seconds, i) => ({
    description: 'Processed', time: `2026-11-04T12:00:${seconds}Z`, provider_code: String(i),
  }));
  const tracker = new UniversalTracker({ browserLookup: vi.fn().mockResolvedValue({ events }) });
  expect((await tracker.fetchSource('Ship24', number)).events).toHaveLength(2);
  events.splice(1, 0, { description: 'Processed', time: '2026-11-04T12:00:05Z', provider_code: '' });
  const kept = (await tracker.fetchSource('Ship24', number)).events;
  expect(kept?.map(scan => scan.provider_code).sort()).toEqual(['0', '1']);
});
