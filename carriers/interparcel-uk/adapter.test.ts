import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, INTERPARCEL_UK, InterparcelUkTracker, interparcelUkUrl } from './adapter.js';
import { normalizeInterparcelNumber, parseInterparcel } from './interparcel.js';
import { interparcelStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples in numbers.json.
const TO_FRANCE = 'GB6234015339';
const TO_GUERNSEY = 'GB5206570633';
const UNKNOWN = 'GB0000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const CHECK = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
/** The tracking page of a reference: each sample's page, and the empty track form for any other. */
const tracking = (number: string) => [TO_FRANCE, TO_GUERNSEY].includes(number) ? fixture(number) : fixture('not-found').replaceAll(UNKNOWN, number);
const numberOf = (url: unknown) => new URL(String(url)).pathname.split('/')[2]!;
const direct = () => vi.fn<typeof fetch>(async url => page(tracking(numberOf(url))));
const carrier = (fetcher: typeof fetch, trawl: TrawlClient | null = null) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl, browserExecutablePath: null });
const parse = (html: string, number: string) => parseInterparcel(INTERPARCEL_UK, html, number);
/**
 * A fetcher for the site that Cloudflare checks, and for a browser service that renders the
 * tracking page in the address it is asked for. The browser step sends its requests through the
 * adapter's fetcher.
 */
const checked = (render: (url: string) => string = url => tracking(numberOf(url))) => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).startsWith('http://browser.test/')) return page(CHECK, { status: 403 });
    const { url: address } = JSON.parse(String(init!.body)) as { url: string };
    return Response.json({ tier: 3, statusCode: 200, url: address, html: render(address) });
  });
  return { fetcher, trawl: new TrawlClient('http://browser.test', fetcher) };
};

type SummaryRow = [code: string, description: string, clock: string, location: string];
type DetailedRow = [day: string, time: string, description: string, location: string];
/** A sample's page with other rows in its summary and its detailed list. */
const withRows = (summary: readonly SummaryRow[], rows: readonly DetailedRow[]) => {
  const $ = load(fixture(TO_FRANCE));
  $('#abbreviatedEvents').html(summary.map(([code, description, clock, location]) => `<div><div class="leftDate"></div>
    <div><div class="trackRoundel status${code}"></div></div>
    <div><div>${description}</div><div class="rightDate">${clock}</div><div>${location}</div></div></div>`).join(''));
  $('#allEvents tbody').html(`<tr><td>Date</td><td>Time</td><td>Event</td><td>Location</td></tr>${
    rows.map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}`);
  return $.html();
};

describe('Interparcel UK adapter', () => {
  it('reads the courier’s scans, with the summary’s status letters and the wall clocks of the page', async () => {
    const fetcher = direct();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new InterparcelUkTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' gb-6234015339 ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://uk.interparcel.com/tracking/${TO_FRANCE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2025-11-13T11:47:00', expected_delivery: null,
      service_name: 'FedEx International Connect Plus® Drop Off', destination_country: 'FR', signed_by: 'D. Do' });
    expect(result.events!.map(event => [event.local_time, event.provider_code ?? null, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2025-11-13T11:47:00', 'D', 'Delivered', 'Pleudihen-sur-rance, FR', 'delivered'],
      ['2025-11-13T07:09:00', 'O', 'On FedEx vehicle for delivery', 'St Jacques De La Lande, FR', 'out_for_delivery'],
      ['2025-11-13T05:28:00', 'T', 'At local FedEx facility', 'St Jacques De La Lande, FR', 'in_transit'],
      ['2025-11-12T21:38:00', null, 'On the way', 'Lieusaint, FR', 'in_transit'],
      ['2025-11-12T19:48:00', null, 'Arrived at FedEx hub', 'Lieusaint, FR', 'in_transit'],
      ['2025-11-12T18:45:00', null, 'Departed FedEx hub', 'Marly La Ville, FR', 'in_transit'],
      ['2025-11-12T16:31:00', null, 'On the way', 'Marly La Ville, FR', 'in_transit'],
      // Two summary rows share a clock and a place: each letter goes on the row in its words.
      ['2025-11-12T11:58:00', 'I', 'International shipment release – Import', 'Marly La Ville, FR', null],
      ['2025-11-12T11:58:00', 'T', 'Shipment arriving On Time', 'Marly La Ville, FR', 'in_transit'],
      ['2025-11-12T11:55:00', null, 'Arrived at FedEx hub', 'Marly La Ville, FR', 'in_transit'],
      ['2025-11-12T02:36:00', null, 'Departed FedEx hub', 'Kingsbury, GB', 'in_transit'],
      ['2025-11-12T01:56:00', null, 'On the way', 'Kingsbury, GB', 'in_transit'],
      ['2025-11-12T00:24:00', 'I', 'International shipment release – Export', 'Kingsbury, GB', null],
      ['2025-11-12T00:24:00', 'T', 'On the way', 'Kingsbury, GB', 'in_transit'],
      ['2025-11-11T14:14:00', null, 'Picked up', 'Leeds, GB', 'accepted'],
      ['2025-11-11T14:14:00', null, 'On the way', 'Leeds, GB', 'in_transit'],
      ['2025-11-10T20:35:00', null, 'At FedEx origin facility', 'Leeds, GB', 'in_transit'],
      ['2025-11-10T12:16:00', null, 'Picked up', 'Leeds, GB', 'accepted'],
      // Interparcel's own steps take place "Online", which names no place.
      ['2025-11-10T10:11:00', 'I', 'Shipment information sent to FedEx', null, null],
      ['2025-11-10T10:11:00', 'B', 'Shipment has been booked', null, 'registered'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.time_zone === undefined)).toBe(true);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'interparcel-uk', step: 'direct', outcome: 'ok' }));
  });

  it('opens the page in the browser service when Cloudflare checks the direct read', async () => {
    const { fetcher, trawl } = checked();
    const result = await carrier(fetcher, trawl).track({ number: TO_GUERNSEY });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([interparcelUkUrl(TO_GUERNSEY), 'http://browser.test/scrape']);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toMatchObject({ url: interparcelUkUrl(TO_GUERNSEY), skipHttp: true, maxTier: 3 });
    // The page names no service for this booking, and its summary leaves the booking out.
    expect(result).not.toHaveProperty('service_name');
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivered', last_update_local: '2021-12-19T10:44:00', destination_country: 'GG' });
    expect(result.events!.map(event => [event.local_time, event.provider_code ?? null, event.description, event.stage ?? null, event.stage_source ?? null])).toEqual([
      ['2021-12-19T10:44:00', 'D', 'Delivered', 'delivered', 'carrier_map'],
      ['2021-12-18T10:09:00', 'T', 'Arrived in destination country', 'in_transit', 'carrier_map'],
      ['2021-12-17T04:40:00', null, 'Exported from the UK', null, null],
      ['2021-12-17T04:10:00', null, 'Prepared for export', null, null],
      ['2021-12-16T23:50:00', null, 'Sorted for export', 'in_transit', 'wording:language'],
      ['2021-12-16T19:36:00', null, 'On route to hub', null, null],
      // The courier came to collect and found nobody: the parcel had not left its sender.
      ['2021-12-15T15:04:00', 'B', 'Collection attempted - customer not available', 'registered', 'carrier_map'],
      ['2021-12-07T16:27:00', null, 'Shipment has been booked', 'registered', 'carrier_map'],
    ]);
  });

  it('dates each detailed row by its weekday, across the turn of a year', () => {
    const late = parse(withRows(
      [['D', 'Delivered', '2nd January, 2026 9:15am', 'Leeds, GB'], ['B', 'Shipment has been booked', '30th December, 2025 4:05pm', 'Online']],
      [['Fri 2nd Jan', '09:15', 'Delivered', 'Leeds, GB'], ['Wed 31st Dec', '18:00', 'Departed FedEx hub', 'Kingsbury, GB'],
        ['Tue 30th Dec', '16:05', 'Shipment has been booked', 'Online']]), TO_FRANCE);
    expect(late.events!.map(event => event.local_time)).toEqual(['2026-01-02T09:15:00', '2025-12-31T18:00:00', '2025-12-30T16:05:00']);
    // A summary that has only reached the booking still dates the scans of the next year.
    const early = parse(withRows([['B', 'Shipment has been booked', '30th December, 2025 4:05pm', 'Online']],
      [['Fri 2nd Jan', '09:15', 'On the way', 'Leeds, GB'], ['Tue 30th Dec', '16:05', 'Shipment has been booked', 'Online']]), TO_FRANCE);
    expect(early).toMatchObject({ last_update_local: '2026-01-02T09:15:00', current_stage: 'in_transit' });
    // A summary row without detailed rows is read alone, at its own clock.
    expect(parse(withRows([['T', 'Parcel is in transit', '1st December, 2025 12:30pm', 'Leeds, GB']], []), TO_FRANCE).events)
      .toEqual([{ local_time: '2025-12-01T12:30:00', description: 'Parcel is in transit', location: 'Leeds, GB', provider_code: 'T', stage: 'in_transit', stage_source: 'carrier_map' }]);
    expect(() => parse(withRows([['D', 'Delivered', '2nd January, 2026 9:15am', 'Leeds, GB']], [['Sun 2nd Jan', '09:15', 'Delivered', 'Leeds, GB']]), TO_FRANCE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the empty track form as not found, and checks the reference the page answers for', async () => {
    await expect(carrier(direct()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const service = checked();
    await expect(carrier(service.fetcher, service.trawl).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parse(fixture('not-found'), 'GB0000000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(fixture(TO_FRANCE), TO_GUERNSEY)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(withRows([], []), TO_FRANCE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('keeps a check, a rate limit and an outage apart from a missing parcel', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: TO_FRANCE });
    await expect(answer(page(CHECK, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page(CHECK))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(page('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // The browser service is asked once, and its own check is a challenge too.
    const service = checked(() => CHECK);
    await expect(carrier(service.fetcher, service.trawl).track({ number: TO_FRANCE })).rejects.toMatchObject({ kind: 'challenge' });
    expect(service.fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries once when the first read does not reach the site', async () => {
    const fetcher = direct();
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: TO_FRANCE }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads a changed page as a schema change', () => {
    expect(() => parse('<html><body>Maintenance</body></html>', TO_FRANCE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(fixture(TO_FRANCE).replace('Tracking Number:</span> GB6234015339', '</span>'), TO_FRANCE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(fixture(TO_FRANCE).replace('trackRoundel statusD', 'trackRoundel'), TO_FRANCE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(fixture(TO_FRANCE).replace('13th November, 2025 11:47am', '13/11/2025 11:47'), TO_FRANCE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(fixture(TO_FRANCE).replace('>11:47<', '>11.47<'), TO_FRANCE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes GB and ten digits', () => {
    expect(normalizeInterparcelNumber(INTERPARCEL_UK, 'gb-6234 015339')).toBe(TO_FRANCE);
    for (const bad of ['AU4046552724', '6234015339', 'GB623401533', 'GB62340153390', 'GBX234015339', '']) {
      expect(() => normalizeInterparcelNumber(INTERPARCEL_UK, bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the letters and wording statuses.json records', () => {
    for (const entry of statuses.entries as ReadonlyArray<{ code?: string; wording: string; stage?: string; note: string }>) {
      const code = entry.code ?? null;
      const stage = entry.stage;
      expect(statusMapAnswer({ carrier: 'interparcel-uk', providerCode: code, description: entry.wording }), entry.wording)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: entry.note });
      expect(interparcelStage(code, entry.wording)?.stage ?? null, entry.wording).toBe(stage ?? null);
    }
    expect(statusMapAnswer({ carrier: 'interparcel-uk', providerCode: 'X', description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
