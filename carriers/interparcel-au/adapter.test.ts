import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { normalizeInterparcelNumber, parseInterparcel } from '../interparcel-uk/interparcel.js';
import { adapter, INTERPARCEL_AU, InterparcelAuTracker, interparcelAuUrl } from './adapter.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples in numbers.json.
const COURIERS_PLEASE = 'AU4046552724';
const STARTRACK = 'AU8046336296';
const UNKNOWN = 'AU0000000000';
// The reference the empty form was captured for.
const CAPTURED = 'ZZZ0000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const CHECK = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
/** The tracking page of a reference: each sample's page, and the empty track form for any other. */
const tracking = (number: string) => [COURIERS_PLEASE, STARTRACK].includes(number) ? fixture(number) : fixture('not-found').replaceAll(CAPTURED, number);
const numberOf = (url: unknown) => new URL(String(url)).pathname.split('/')[2]!;
const carrier = (fetcher: typeof fetch, trawl: TrawlClient | null = null) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl, browserExecutablePath: null });
/** A site that Cloudflare checks, and a browser service that renders the page it is asked for. */
const checked = () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).startsWith('http://browser.test/')) return page(CHECK, { status: 403 });
    const { url: address } = JSON.parse(String(init!.body)) as { url: string };
    return Response.json({ tier: 3, statusCode: 200, url: address, html: tracking(numberOf(address)) });
  });
  return { fetcher, trawl: new TrawlClient('http://browser.test', fetcher) };
};

describe('Interparcel Australia adapter', () => {
  it('reads the courier’s scans on the Australian site, with the summary’s status letters', async () => {
    const fetcher = vi.fn<typeof fetch>(async url => page(tracking(numberOf(url))));
    const result = await new InterparcelAuTracker({ fetcher, userAgent: 'SyntheticHost/1.0' }).fetch('au 4046552724');
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://au.interparcel.com/tracking/${COURIERS_PLEASE}`);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Parcel has been delivered',
      last_update: null, last_update_local: '2025-05-14T11:38:00', service_name: 'Couriers Please Box', destination_country: 'AU' });
    expect(result.events!.map(event => [event.local_time, event.provider_code ?? null, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2025-05-14T11:38:00', 'D', 'Parcel has been delivered', '0091 (PEMULWUY)', 'delivered'],
      ['2025-05-14T07:57:00', 'O', 'Parcel been loaded for delivery', '0091 (PEMULWUY)', 'out_for_delivery'],
      ['2025-05-14T04:05:00', 'T', 'Parcel has been accepted in Depot', '9415 (CWC SYD)', 'in_transit'],
      ['2025-05-13T16:17:00', null, 'Parcel is in transit (Melbourne - Sydney) CPS0500244806', '9707 (MEL)', 'in_transit'],
      ['2025-05-13T16:03:00', null, 'Cube/Weigh - Accepted in Depot Length 32.5cm Width 25cm Height 16.5cm', '9421 (DANDYSORT)', 'accepted'],
      ['2025-05-13T15:21:00', null, 'Parcel has been picked up', '0187 (MEL-M)', 'accepted'],
      ['2025-05-12T09:01:00', 'B', 'Shipment has been booked', null, 'registered'],
    ]);
  });

  it('opens the page in the browser service when Cloudflare checks the direct read', async () => {
    const { fetcher, trawl } = checked();
    const result = await carrier(fetcher, trawl).track({ number: STARTRACK });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([interparcelAuUrl(STARTRACK), 'http://browser.test/scrape']);
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivered with signature', service_name: 'StarTrack Express' });
    // The courier repeats a scan word for word; it is kept once. The summary words the rows its
    // own way, so its letters go on the courier's rows at the same clock and place.
    expect(result.events!.map(event => [event.local_time, event.provider_code ?? null, event.description, event.stage ?? null])).toEqual([
      ['2025-04-28T17:24:00', 'D', 'Delivered with signature', 'delivered'],
      ['2025-04-28T13:28:00', 'O', 'Onboard for delivery', 'out_for_delivery'],
      ['2025-04-24T22:43:00', 'T', 'In transit to next facility', 'in_transit'],
      ['2025-04-24T18:44:00', null, 'Item processed at sorting facility', 'in_transit'],
      ['2025-04-24T18:25:00', null, 'In transit to STARTRACK SYDNEY', 'in_transit'],
      ['2025-04-24T14:30:00', null, 'Picked up from Sender', 'accepted'],
      ['2025-04-24T10:58:00', 'B', 'Shipment has been booked', 'registered'],
    ]);
  });

  it('reads the empty track form as not found, directly and through the browser service', async () => {
    await expect(carrier(vi.fn<typeof fetch>(async url => page(tracking(numberOf(url))))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const service = checked();
    await expect(carrier(service.fetcher, service.trawl).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseInterparcel(INTERPARCEL_AU, fixture(COURIERS_PLEASE), STARTRACK)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes AU and ten digits', () => {
    expect(normalizeInterparcelNumber(INTERPARCEL_AU, 'au-8046336296')).toBe(STARTRACK);
    for (const bad of ['GB6234015339', '8046336296', 'AU804633629', '']) {
      expect(() => normalizeInterparcelNumber(INTERPARCEL_AU, bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the letters statuses.json records with the shared map', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'interparcel-au', providerCode: code, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
  });
});
