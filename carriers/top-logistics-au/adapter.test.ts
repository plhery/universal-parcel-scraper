import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TLA_LOOKUP } from './adapter.js';
import { normalizeTlaNumber, parseTla } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and an invented number the frame does not know.
const SAMPLE = 'TPL600042194';
const OTHER = 'TPL000000000';

const DELIVERED = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A synthetic page with the frame's layout: a day's heading, then its scans, then the couriers.
const day = (heading: string) => `<hr /><p class="card-text"><span style="font-weight: bold;">${heading}</span></p>`;
const scan = (line: string) => `<p class="card-text">&emsp;&emsp;&ensp;${line}</p>`;
const page = (rows: string, couriers = '', reference = SAMPLE) => `<html><body>
  <div class="container-fluid d-none d-lg-block"><div class="card"><div class="card-header"><h5>Most Recent Status:</h5></div></div>
  <div class="card"><div class="card-header"><h5>Details (Reference Number: ${reference})</h5></div>
  <div class="card-body">${rows}<hr /><p class="card-text">Website to track</p>${couriers}</div></div></div></body></html>`;
const ON_ITS_WAY = day('11-06-2026&emsp;Thu') + scan('10:00&emsp;&ensp;Arrived at warehouse') + scan('11:37&emsp;&ensp;Shipment despatched to courier');

describe('Top Logistics Australia numbers', () => {
  it('takes letters and digits with at least one digit, in capitals', () => {
    expect(normalizeTlaNumber(` ${SAMPLE.slice(0, 3).toLowerCase()} ${SAMPLE.slice(3)} `)).toBe(SAMPLE);
    for (const other of ['', 'TPL12', 'ABCDEFGHIJ', `${SAMPLE};TPL1`, 'TPL/600042194', `${'T'.repeat(40)}1`, 'T'.repeat(65)]) {
      expect(() => normalizeTlaNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Top Logistics Australia tracking adapter', () => {
  it('reads the tracking frame the site’s search opens for the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`${TLA_LOOKUP}?s=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get('referer')).toBe(`https://toplogistics.com.au/?s=${SAMPLE}`);
    expect(carrier(fetcher)).toMatchObject({ id: 'top-logistics-au', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('leaves the empty HTTP 500 an unknown number gets open, since a failed lookup gives the same', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html('', { status: 500 }));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps challenges, refusals, redirects and changed replies apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 500 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 401 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://toplogistics.com.au/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    // The frame's reply to lookups sent close together from one address.
    expect(await answer(() => html('Access Limited'))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('<html><body>Maintenance</body></html>'))).toMatchObject({ kind: 'schema' });
    for (const response of [() => html('', { status: 500 }), () => html(challenge), () => html('<html></html>')]) {
      expect(await answer(response)).not.toMatchObject({ kind: 'not_found' });
    }
  });
});

describe('Top Logistics Australia replies', () => {
  it('reads the public sample: sea freight, customs and the courier’s delivery, on the wall clocks the page shows', () => {
    const result = parseTla(DELIVERED, SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'DELIVERED',
      last_update: null, last_update_local: '2026-06-12T12:00:00', expected_delivery: null,
    });
    expect(result.events).toHaveLength(13);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2026-06-12T12:00:00', description: 'DELIVERED', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-06-12T07:43:00', description: 'ON BOARD FOR DELIVERY', stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    // A scan without a time keeps its day.
    expect(result.events).toContainEqual({ local_time: '2026-06-07', description: 'Sea arrived YM ESSENCE/101S', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events).toContainEqual({ local_time: '2026-06-03T12:05:00', description: 'Reported To Customs', stage: 'customs', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-05-13T20:35:00', description: 'Shipment info received', stage: 'registered', stage_source: 'carrier_map' });
    // The courier, Allied Express, tracks the parcel under the same number, and detection does not offer it for the number.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('names the courier only when it is one catalog carrier that detection offers for the courier’s number', () => {
    const auspost = (reference: string) => `AUSPOST:<a href="https://auspost.com.au" target="_blank">${reference}</a><br />`;
    expect(parseTla(page(ON_ITS_WAY, auspost('33ABC1234567')), SAMPLE)).toMatchObject({
      current_stage: 'in_transit', last_status_text: 'Shipment despatched to courier', last_update_local: '2026-06-11T11:37:00',
      delivery_carrier: 'australia-post', delivery_tracking_number: '33ABC1234567',
    });
    const unoffered = parseTla(page(ON_ITS_WAY, auspost('ZZ0000001')), SAMPLE);
    expect(unoffered).toMatchObject({ delivery_tracking_number: 'ZZ0000001' });
    expect(unoffered).not.toHaveProperty('delivery_carrier');
    for (const couriers of [`${auspost('33ABC1234567')}${auspost('33ABC7654321')}`, `<a href="https://auspost.com.au">33ABC1234567</a>`,
      'SOMEONE:<a href="https://example.com">33ABC1234567</a>']) {
      const result = parseTla(page(ON_ITS_WAY, couriers), SAMPLE);
      expect(result, couriers).not.toHaveProperty('delivery_carrier');
    }
  });

  it('keeps a scan wording the map does not know visible', () => {
    const result = parseTla(page(day('12-06-2026&emsp;Fri') + scan('09:00&emsp;&ensp;Parked')), SAMPLE);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Parked', last_update_local: '2026-06-12T09:00:00' });
    expect(result.events).toEqual([{ local_time: '2026-06-12T09:00:00', description: 'Parked' }]);
  });

  it('answers a parcel listed without scans as having no history', () => {
    expect(() => parseTla(page(''), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a page for another parcel', () => {
    // The frame also matches other references, and then shows another parcel.
    expect(() => parseTla(page(ON_ITS_WAY, '', 'AMQ0000001'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTla(DELIVERED, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed page', () => {
    for (const changed of ['', '<html></html>', page(scan('10:00&emsp;&ensp;Arrived at warehouse')), page(day('31-02-2026&emsp;Tue') + scan('10:00 x')),
      page(day('11-06-2026&emsp;Thu') + scan('25:00&emsp;&ensp;Arrived at warehouse')), page(day('11-06-2026') + scan('10:00 x')),
      page(day('11-06-1926&emsp;Fri') + scan('10:00 x')), page(day('11-06-2026&emsp;Thu') + scan('Arrived at warehouse'))]) {
      expect(() => parseTla(changed, SAMPLE), changed.slice(-200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Top Logistics Australia statuses', () => {
  it('maps each scan wording the frame was seen to give', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'top-logistics-au', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'Sea vessel dispatched OTHER SHIP/7N')).toBe('in_transit');
    expect(statusMap.stage(null, 'Shipment despatched to courier [ AUSPOST:33ABC1234567 ]')).toBe('in_transit');
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
