import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording, statusGapNote } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, kongaTrackingUrl } from './adapter.js';
import { kongaClock, normalizeKongaNumber, parseKonga } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample, whose reply is `delivered.html`, and the synthetic number `not-found.html` answers.
const SAMPLE = 'F568440379001';
const UNKNOWN = 'F123456789001';
// Invented: a line number no order reaches.
const OTHER = 'F990000000017';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (text: string, clock: string) => `<li class=""><b>${text} </b><p>${clock}</p></li>`;
/** The public sample's page with only these rows. */
const withRows = (...rows: string[]) => fixture('delivered').replace(/(<ul id="order-tree"[^>]*>)[\s\S]*?(<\/ul>)/, `$1${rows.join('')}$2`);
const failure = (run: () => unknown) => { try { run(); } catch (error) { return error; } return undefined; };

describe('Konga Logistics numbers', () => {
  it('takes F and twelve digits, R and nine digits, and KEXP and sixteen hexadecimal characters', () => {
    expect(normalizeKongaNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeKongaNumber('R990000017')).toBe('R990000017');
    expect(normalizeKongaNumber('kexp0000000000000a17')).toBe('KEXP0000000000000A17');
    for (const other of ['', 'F56844037900', 'F5684403790011', 'G568440379001', 'R99000001', 'KEXP0000000000000G17', 'KEXP0000000000000A1', 'X'.repeat(70)]) {
      expect(() => normalizeKongaNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Konga Logistics tracking adapter', () => {
  it('asks the tracker’s page for the number, with the lookup’s signal and the host’s User-Agent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://logistics.konga.com/track?order_number=F568440379001');
    expect(kongaTrackingUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) });
    const named = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('delivered')));
    await adapter({ fetcher: named, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'Host/1.0' }).track({ number: SAMPLE });
    expect(named.mock.calls[0]![1]).toMatchObject({ headers: expect.objectContaining({ 'User-Agent': 'Host/1.0' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'konga-kxpress', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number Konga does not issue without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'F123' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads only the tracker’s own notice as not found', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('not-found')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, verification pages, error pages, moved routes and other replies apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429, headers: { 'Retry-After': '30' } }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<div class="cf-turnstile"></div>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Error</title>', { status: 500 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    for (const status of [404, 410]) expect(await answer(() => html('<pre>Cannot GET /track</pre>', { status }))).toMatchObject({ kind: 'transport', status });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html(''))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('"Invalid order number provided"', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('<html><body>Service Unavailable</body></html>'))).toMatchObject({ kind: 'schema' });
  });

  it('reads once more after a network failure, and ends with the budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(async () => html(fixture('delivered')));
    await expect(carrier(flaky).track({ number: SAMPLE }, { budgetMs: 5000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const hanging = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = performance.now();
    const ended = await carrier(hanging).track({ number: SAMPLE }, { budgetMs: 50 }).catch((error: unknown) => error);
    // The request's own timeout and the lookup's deadline end together; either way the lookup stops with its budget.
    expect(ended).toMatchObject({ kind: expect.stringMatching(/^(?:budget|transport)$/) });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(hanging.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('Konga Logistics pages', () => {
  it('reads the public sample: wall clocks newest first, the place from each sentence, the delivery', () => {
    const result = parseKonga(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered to Customer', last_update: null, last_update_local: '2023-06-03T16:08:00', expected_delivery: null,
    });
    expect(result.events!.map((event) => event.local_time)).toEqual([
      '2023-06-03T16:08:00', '2023-06-03T13:17:00', '2023-06-03T13:16:00', '2023-06-03T11:51:00', '2023-06-03T11:50:00',
      '2023-06-01T20:54:00', '2023-05-31T18:41:00', '2023-05-31T15:50:00', '2023-05-31T12:21:00', '2023-05-31T12:21:00',
    ]);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2023-06-03T16:08:00', description: 'Delivered to Customer', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2023-06-03T13:17:00', description: 'Your order is ready for collection', stage: 'ready_for_pickup', stage_source: 'carrier_map' },
    ]);
    expect(result.events![3]).toEqual({
      local_time: '2023-06-03T11:51:00', location: 'KXPRESS PORT HACOURT XC, Port Harcourt', stage: 'in_transit', stage_source: 'carrier_map',
      description: 'Order has left KXPRESS PORT HACOURT XC, Port Harcourt to KONGA PORT HARCOURT STORE, Port Harcourt',
    });
    expect(result.events![6]).toMatchObject({ location: 'KXPRESS Central Distribution Center, Ogba, Ogba', stage: 'in_transit' });
    // Two rows of one minute keep the page's order: the station took the parcel in after booking it.
    expect(result.events!.slice(-2)).toEqual([
      { local_time: '2023-05-31T12:21:00', description: 'Shipment received at Kxpress Surulere, Surulere', location: 'Kxpress Surulere, Surulere', stage: 'accepted', stage_source: 'carrier_map' },
      { local_time: '2023-05-31T12:21:00', description: 'Shipment Created Kxpress Surulere, Surulere', location: 'Kxpress Surulere, Surulere', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('still reads the page with the scripts Cloudflare injects', () => {
    const injected = fixture('delivered')
      .replace('<body>', '<body><script>(function(w,i,g){w[g]=w[g]||[]})(window,\'GTM-EXAMPLE\',\'google_tags_first_party\');</script>')
      .replace('</body>', '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon=\'{"spa":2}\'></script>\n</body>');
    expect(parseKonga(injected, SAMPLE)).toEqual(parseKonga(fixture('delivered'), SAMPLE));
  });

  it('keeps a wall clock in local_time, and text that does not read as one in provider_time_text', () => {
    expect(kongaClock('Sat, Jun 03, 2023, 04:08 PM')).toEqual({ local_time: '2023-06-03T16:08:00' });
    // 12 AM is midnight, 12 PM noon.
    expect(kongaClock('Sat, Jun 03, 2023, 12:05 AM')).toEqual({ local_time: '2023-06-03T00:05:00' });
    expect(kongaClock('Sat, Jun 03, 2023, 12:05 PM')).toEqual({ local_time: '2023-06-03T12:05:00' });
    expect(kongaClock('Sat, Jun 03, 2023, 11:59 PM')).toEqual({ local_time: '2023-06-03T23:59:00' });
    expect(kongaClock('Thu, Jun 1, 2023, 8:54 AM')).toEqual({ local_time: '2023-06-01T08:54:00' });
    for (const text of ['Sun, Jun 03, 2023, 04:08 PM', 'Fri, Feb 30, 2024, 04:08 PM', 'Sat, Jun 03, 2023, 13:08 PM', 'Sat, Jun 03, 2023, 00:08 AM',
      'Sat, Jun 03, 2023, 04:60 PM', 'Sat, Jun 03, 2023, 16:08', '2023-06-03 16:08']) {
      expect(kongaClock(text), text).toEqual({ provider_time_text: text });
    }
    expect(kongaClock('')).toEqual({});
  });

  it('sorts rows newest first and stably, keeping a row without a clock under the row above it', () => {
    const result = parseKonga(withRows(
      row('Order has arrived at KONGA PORT HARCOURT STORE, Port Harcourt', 'Sat, Jun 03, 2023, 01:16 PM'),
      row('Delivered to Customer', 'Sat, Jun 03, 2023, 04:08 PM'),
      row('Order has left Kxpress Surulere, Surulere to KXPRESS Central Distribution Center, Ogba, Ogba', 'around noon'),
      row('Shipment received at Kxpress Surulere, Surulere', 'Wed, May 31, 2023, 12:21 PM'),
      row('Shipment Created Kxpress Surulere, Surulere', 'Wed, May 31, 2023, 12:21 PM'),
      row('Shipment Created Kxpress Surulere, Surulere', 'Wed, May 31, 2023, 12:21 PM'),
    ), SAMPLE);
    expect(result.events!.map((event) => [event.local_time ?? event.provider_time_text, event.description!.split(' ').slice(0, 2).join(' ')])).toEqual([
      ['2023-06-03T16:08:00', 'Delivered to'], ['around noon', 'Order has'], ['2023-06-03T13:16:00', 'Order has'],
      ['2023-05-31T12:21:00', 'Shipment received'], ['2023-05-31T12:21:00', 'Shipment Created'],
    ]);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2023-06-03T16:08:00' });
    const untimed = parseKonga(withRows(row('Delivered to Customer', 'today'), row('Shipment Created Kxpress Surulere, Surulere', 'Wed, May 31, 2023, 12:21 PM')), SAMPLE);
    expect(untimed.events![0]).toEqual({ provider_time_text: 'today', description: 'Delivered to Customer', stage: 'delivered', stage_source: 'carrier_map' });
    expect(untimed.last_update_local).toBe('2023-05-31T12:21:00');
  });

  it('stages a collection point, out for delivery and the status tag apart from a delivery', () => {
    const arrived = row('Order has arrived at KONGA PORT HARCOURT STORE, Port Harcourt', 'Sat, Jun 03, 2023, 01:16 PM');
    expect(parseKonga(withRows(row('Your order is ready for collection', 'Sat, Jun 03, 2023, 01:17 PM'), arrived), SAMPLE))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map' });
    // Wording the map does not hold goes to the shared rules, which do not read out for delivery as delivered.
    expect(parseKonga(withRows(row('Your order is out for delivery', 'Sat, Jun 03, 2023, 02:00 PM'), arrived), SAMPLE))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(parseKonga(withRows(arrived), SAMPLE)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    // The tag decides only when no row has a stage.
    const unread = row('Konga Logistics note 17', 'Sat, Jun 03, 2023, 02:00 PM');
    expect(parseKonga(withRows(unread), SAMPLE)).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(parseKonga(withRows(unread).replace('<button class="tag btn">Delivered</button>', ''), SAMPLE)).toMatchObject({ status: 'unknown' });
    expect(parseKonga(withRows(unread).replace('<button class="tag btn">Delivered</button>', ''), SAMPLE)).not.toHaveProperty('current_stage');
  });

  it('binds the page to the number asked', () => {
    expect(failure(() => parseKonga(fixture('delivered'), OTHER))).toMatchObject({ kind: 'indeterminate' });
    expect(failure(() => parseKonga(fixture('not-found'), OTHER))).toMatchObject({ kind: 'indeterminate' });
    expect(failure(() => parseKonga(fixture('not-found'), UNKNOWN))).toMatchObject({ kind: 'not_found' });
    expect(failure(() => parseKonga(fixture('delivered').replace(`<span class="track-no">${SAMPLE}`, `<span class="track-no">${OTHER}`), SAMPLE)))
      .toMatchObject({ kind: 'schema' });
  });

  it('refuses a changed page, and reads a listed shipment without rows as no history', () => {
    expect(failure(() => parseKonga(fixture('not-found').replace('We could not find this tracking number.', 'Something went wrong.'), UNKNOWN)))
      .toMatchObject({ kind: 'schema' });
    for (const page of [
      fixture('delivered').replace('<label id="order-label">', `<h5 id="order-num">${SAMPLE}</h5><label id="order-label">`),
      fixture('delivered').replace('id="order-tree"', 'id="order-list"'),
      withRows(`<div><b>Delivered to Customer</b><p>Sat, Jun 03, 2023, 04:08 PM</p></div>`),
      withRows('<li><p>Sat, Jun 03, 2023, 04:08 PM</p></li>'),
      withRows(row('', 'Sat, Jun 03, 2023, 04:08 PM')),
      withRows(row('Delivered to Customer', 'Sat, Jun 03, 2023, 04:08 PM').replace('</li>', '<p>again</p></li>')),
      withRows(...Array.from({ length: 301 }, (_, index) => row(`Order has arrived at Station ${index}, Lagos`, 'Sat, Jun 03, 2023, 04:08 PM'))),
    ]) expect(failure(() => parseKonga(page, SAMPLE))).toMatchObject({ kind: 'schema' });
    expect(failure(() => parseKonga(withRows(), SAMPLE))).toMatchObject({ kind: 'indeterminate', reason: 'listed' });
  });

  it('answers each wording statuses.json records by its stage, and other facilities by the same sentences', () => {
    for (const { wording, stage } of statuses.entries as { wording: string; stage?: string }[]) {
      // Plain printable text, as the page shows it once trimmed.
      expect(wording, wording).toMatch(/^[\x20-\x7e]+$/);
      expect(wording.trim().split(/\s+/).join(' ')).toBe(wording);
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
      expect(statusGapNote(statusMap, null, normalizeStatusWording(wording))).toBeUndefined();
    }
    for (const [wording, stage] of [
      ['Shipment Created Kxpress Ikeja, Ikeja', 'registered'], ['Shipment received at Kxpress Ikeja, Ikeja', 'accepted'],
      ['Order has left KXPRESS Central Distribution Center, Ogba, Ogba to KXPRESS ABUJA XC, Abuja', 'in_transit'],
      ['Order has arrived at KXPRESS ABUJA XC, Abuja', 'in_transit'],
    ] as const) expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
    expect(statusMap.stage('DLV', 'delivered to customer')).toBeUndefined();
    expect(statusMap.stage(null, 'your order is out for delivery')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});
