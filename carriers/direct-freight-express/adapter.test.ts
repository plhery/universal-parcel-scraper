import { describe, expect, it, vi } from 'vitest';
import { TrawlClient } from '../../core/transport/trawl.js';
import { DirectFreightTracker, directFreightUrl } from './adapter.js';
import { normalizeDirectFreightNumber, parseDirectFreight } from './parser.js';

const NUMBER = '8042761935802';
const headings = ['Date', 'Location', 'Status', 'Items'];
type Row = [string, string, string, string];
const rows = (): Row[] => [['04 Jul 2026 10:20:30', 'Example Depot', 'Delivered', '1'], ['03 Jul 2026 09:00:00', 'Example Depot', 'Pickup Collected', '1']];
const scan = (values: Row) => `<div class="hidden md:grid grid-cols-4">${values.map(v => `<div>${v}</div>`).join('')}</div><div class="block md:hidden">${values.map((v, i) => `<div><span>${headings[i]}:</span><br>${v}</div>`).join('')}</div>`;
const page = (values = rows(), number = NUMBER) => `<form id="frmConsignmentStatus"><span id="lblMessage"></span><div id="pnlConsignment"><div id="pnlSingleConcharge"><div><span>Consignment Number</span><span id="lblConnote">${number}</span></div><span id="lblSender">PRIVATE ADDRESS</span><span id="lblReceiver">PRIVATE ADDRESS</span><span id="lblPodImage">PRIVATE PROOF</span><span id="lblEtaLabel">Scheduled For Delivery By</span><span id="lblEtaDetails">05/07/2026</span><div id="pnlManifestTracking"><p>Tracking Details</p><div class="hidden md:grid">${headings.map(v => `<div>${v}</div>`).join('')}</div>${values.map(scan).join('')}</div></div></div></form>`;
const miss = (number = NUMBER) => `<form id="frmConsignmentStatus"><span id="lblMessage">Consignment Number  ${number} could not be found. Please try again!</span></form>`;

describe('Direct Freight history', () => {
  it('keeps each scan once, depot-local wall clocks and the stated delivery day', () => {
    const result = parseDirectFreight(page(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-07-04T10:20:30', expected_delivery: '2026-07-05' });
    expect(result.events).toEqual([
      { description: 'Delivered', location: 'Example Depot', local_time: '2026-07-04T10:20:30', stage: 'delivered', stage_source: 'carrier_map' },
      { description: 'Pickup Collected', location: 'Example Depot', local_time: '2026-07-03T09:00:00', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(result).not.toHaveProperty('history_truncated');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('requires matching whole identity and consistent mobile and desktop histories', () => {
    for (const html of [page(rows(), NUMBER + '9'), page().replace('Consignment Number', 'Order Number'),
      page().replace('Date:', 'Other:'), page().replace('block md:hidden', 'changed'),
      page().replace('<span>Status:</span><br>Delivered', '<span>Status:</span><br>On Board'),
      page().replace('03 Jul 2026 09:00:00', '31 Feb 2026 09:00:00'), page().replace('05/07/2026', '31/02/2026')]) {
      expect(() => parseDirectFreight(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps empty location and item cells, unknown wording and an empty estimate without inventing a stage', () => {
    const result = parseDirectFreight(page([['04 Jul 2026 10:20:30', '', 'New carrier wording', '']]).replace('05/07/2026', ''), NUMBER);
    expect(result.status).toBe('unknown'); expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result.events?.[0]).not.toHaveProperty('location'); expect(result.expected_delivery).toBeNull();
  });

  it('flags truncation after distinct scans and refuses excessive input', () => {
    const many = Array.from({ length: 101 }, (_, i): Row => ['04 Jul 2026 10:20:30', `Example Depot ${i}`, 'Depot Scan', '1']);
    expect(parseDirectFreight(page(many.slice(0, 100)), NUMBER)).not.toHaveProperty('history_truncated');
    expect(parseDirectFreight(page(many), NUMBER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseDirectFreight(page(many), NUMBER).events).toHaveLength(100);
    expect(parseDirectFreight(page(Array.from({ length: 120 }, () => rows()[0]!)), NUMBER).events).toHaveLength(1);
    expect(() => parseDirectFreight(page(Array.from({ length: 501 }, () => rows()[0]!)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('separates a whole-number portal miss from mismatched notices, empty history and challenges', () => {
    expect(() => parseDirectFreight(miss(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseDirectFreight(miss('9042761935802'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDirectFreight(page([]), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDirectFreight('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseDirectFreight('<h1>Tracking</h1>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeDirectFreightNumber(' 8042761935802 ')).toBe(NUMBER);
    expect(() => normalizeDirectFreightNumber(NUMBER + '9')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('Direct Freight transport', () => {
  it('recovers an HTTP challenge through the same whole-number TRAWL page', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.startsWith('http://trawl.invalid')) {
        const request = JSON.parse(String(init!.body)); expect(request.url).toBe(directFreightUrl(NUMBER)); expect(request.skipHttp).toBe(true);
        return Response.json({ url: request.url, html: page(), tier: 3, statusCode: 200 });
      }
      expect(new Headers(init?.headers).get('User-Agent')).toBe('host-agent');
      return new Response('blocked', { status: 403 });
    }) as unknown as typeof fetch;
    const tracker = new DirectFreightTracker({ fetcher, trawl: new TrawlClient('http://trawl.invalid', fetcher), userAgent: 'host-agent' });
    expect((await tracker.fetch(NUMBER)).events).toHaveLength(2);
    expect(calls).toHaveLength(2); expect(calls.every(c => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it('does not launch a browser for limits, unavailable endpoints, changed schemas or explicit misses', async () => {
    for (const [response, kind] of [[new Response('slow', { status: 429, headers: { 'Retry-After': '60' } }), 'rate_limited'],
      [new Response('gone', { status: 404 }), 'transport'], [new Response('changed'), 'schema'], [new Response(miss()), 'indeterminate']] as const) {
      const scrape = vi.fn(); const fetcher = vi.fn(async () => response) as unknown as typeof fetch;
      const tracker = new DirectFreightTracker({ fetcher, trawl: { scrape } as unknown as TrawlClient });
      await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind }); expect(fetcher).toHaveBeenCalledTimes(1); expect(scrape).not.toHaveBeenCalled();
    }
  });

  it('keeps a redirected or mismatched browser reply from supplying a shipment', async () => {
    for (const response of [{ url: 'https://www.directfreight.com.au/', html: page() }, { url: directFreightUrl(NUMBER), html: page(rows(), '9042761935802') }]) {
      const fetcher = vi.fn(async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch;
      const scrape = vi.fn(async () => response);
      await expect(new DirectFreightTracker({ fetcher, trawl: { scrape } as unknown as TrawlClient }).fetch(NUMBER)).rejects.toMatchObject({ kind: response.url.endsWith('/') ? 'transport' : 'schema' });
    }
  });

  it('retries only a network failure and cancels before dispatch', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('connection failed')).mockResolvedValueOnce(new Response(page())) as unknown as typeof fetch;
    expect((await new DirectFreightTracker({ fetcher }).fetch(NUMBER)).events).toHaveLength(2); expect(fetcher).toHaveBeenCalledTimes(2);
    const caller = new AbortController(); caller.abort();
    await expect(new DirectFreightTracker({ fetcher }).fetch(NUMBER, { signal: caller.signal })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
