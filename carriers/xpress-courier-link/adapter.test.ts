import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, eclTrackingUrl } from './adapter.js';
import { normalizeEclNumber, parseEcl } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json and the invented number in the not-found fixtures.
const SAMPLE = '6528596';
const OTHER = '6528597';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const INTERNATIONAL = fixture('international');
const NOT_FOUND = fixture('not-found');
const NOT_FOUND_DOMESTIC = fixture('not-found-domestic');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The sample's page as the domestic service answers it, and the not-found pages for the sample's number.
const domestic = (page: string) => page.replace('value="International" selected', 'value="International" ')
  .replace('value="Domestic" >', 'value="Domestic" selected>');
const asking = (page: string, number: string) => page.replace(/name="search" placeholder="Enter Tracking Number" value="[^"]*"/,
  `name="search" placeholder="Enter Tracking Number" value="${number}"`);
// The sample's timeline replaced.
const withTimeline = (items: string) => INTERNATIONAL.replace(/(<div class="timeline">)[\s\S]*?(<\/div>\s*<\/div>\s*<\/div>\s*<\/section>)/, `$1${items}</div>$2`);
const day = (heading: string) => `<div class="timeline-date">${heading}</div>`;
const item = (time: string, title: string, place: string) => `<div class="timeline-item"><div class="timeline-marker"></div><div class="timeline-content">
<div class="timeline-time">${time}</div><div class="timeline-title">${title}</div><div class="timeline-location">${place}</div></div></div>`;

describe('ECL numbers', () => {
  it('takes 5 to 30 letters and digits with at least one digit, in capitals', () => {
    expect(normalizeEclNumber(` ${SAMPLE.slice(0, 3)} ${SAMPLE.slice(3)} `)).toBe(SAMPLE);
    expect(normalizeEclNumber('ecl12345')).toBe('ECL12345');
    for (const other of ['', '1234', 'ABCDEFG', `${SAMPLE},${OTHER}`, '652/8596', '1'.repeat(31), '1'.repeat(65)]) {
      expect(() => normalizeEclNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('opens the tracking page with the service and the number', () => {
    expect(eclTrackingUrl(SAMPLE)).toBe(`https://xpresscourierlink.com/tracking/?txtstatus=International&search=${SAMPLE}`);
    expect(eclTrackingUrl(SAMPLE, 'Domestic')).toBe(`https://xpresscourierlink.com/tracking/?txtstatus=Domestic&search=${SAMPLE}`);
  });
});

describe('ECL tracking adapter', () => {
  it('reads the international service first, as the form does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(INTERNATIONAL));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'customs' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`https://xpresscourierlink.com/tracking/?txtstatus=International&search=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'xpress-courier-link', recordsSteps: true, steps: ['direct', 'retry', 'domestic'] });
  });

  it('asks the domestic service for a number the international one does not know', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(html(asking(NOT_FOUND, SAMPLE)))
      .mockResolvedValueOnce(html(domestic(INTERNATIONAL)));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ last_status_text: 'UNDER CUSTOM CLEARANCE PROCESS' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://xpresscourierlink.com/tracking/?txtstatus=International&search=${SAMPLE}`,
      `https://xpresscourierlink.com/tracking/?txtstatus=Domestic&search=${SAMPLE}`,
    ]);
  });

  it('reads a number both services do not know as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(NOT_FOUND)).mockResolvedValueOnce(html(NOT_FOUND_DOMESTIC));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries the domestic service once more when it cannot be reached', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(html(NOT_FOUND))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(html(NOT_FOUND_DOMESTIC));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps challenges, refusals, redirects and changed pages apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Captcha</title></head><body>Access denied by Imunify360 bot-protection.</body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>403 Forbidden</h1>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('', { status: 301, headers: { Location: 'https://xpresscourierlink.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<!doctype html><html><body>ECL</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    // The trap link every page carries is not a bot check.
    expect(await answer(() => html(`${INTERNATIONAL.replace(/<section class="tracking-results">[\s\S]*<\/section>/, '')}<a href="/imunify-bot-check">imunify-bot-check</a>`)))
      .toMatchObject({ kind: 'schema' });
  });
});


describe('ECL replies', () => {
  it('reads the sample’s scans with their wall clocks and places, never the shipper or consignee', () => {
    const result = parseEcl(INTERNATIONAL, SAMPLE, 'International');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'UNDER CUSTOM CLEARANCE PROCESS', last_update: null, last_update_local: '2025-09-03T09:31:00',
      destination_country: 'AE', expected_delivery: null,
    });
    expect(result.events).toHaveLength(11);
    expect(result.events![0]).toEqual({ local_time: '2025-09-03T09:31:00', description: 'UNDER CUSTOM CLEARANCE PROCESS', location: 'DUBAI', stage: 'customs', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2025-08-17T09:40:00', description: 'SHIPMENT INFORMATION RECEIVED', location: 'SIALKOT-PAKISTAN', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events![2]).toMatchObject({ description: 'SHIPMENT ARRIVED AT COLOMBO', location: 'COLOMBO SRI-LANKA' });
    for (const event of result.events!) expect(event.time).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PLACEHOLDER');
  });

  it('accepts only the page for the number and service asked', () => {
    expect(() => parseEcl(INTERNATIONAL, OTHER, 'International')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEcl(INTERNATIONAL, SAMPLE, 'Domestic')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEcl(NOT_FOUND, SAMPLE, 'International')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEcl(INTERNATIONAL.replace(`<p>${SAMPLE}</p>`, `<p>${OTHER}</p>`), SAMPLE, 'International'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseEcl(domestic(INTERNATIONAL), SAMPLE, 'Domestic')).toMatchObject({ destination_country: 'AE' });
  });

  it('reads the page’s not-found answer for either service', () => {
    expect(() => parseEcl(NOT_FOUND, OTHER, 'International')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEcl(NOT_FOUND_DOMESTIC, OTHER, 'Domestic')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEcl(NOT_FOUND.replace('No shipment found', 'Something went wrong'), OTHER, 'International'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a shipment without scans, bad times and broken scans apart from a missing one', () => {
    expect(() => parseEcl(withTimeline(''), SAMPLE, 'International')).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseEcl(withTimeline(day('Tuesday, September 31 2025') + item('09:31', 'IN TRANSIT', 'DUBAI')), SAMPLE, 'International'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcl(withTimeline(day('Tuesday, September 30 2025') + item('9.31', 'IN TRANSIT', 'DUBAI')), SAMPLE, 'International'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcl(withTimeline(item('09:31', 'IN TRANSIT', 'DUBAI')), SAMPLE, 'International'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEcl(withTimeline(day('Tuesday, September 30 2025') + item('09:31', '', 'DUBAI')), SAMPLE, 'International'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps scans newest first and drops repeats', () => {
    const result = parseEcl(withTimeline([
      day('Monday, August 18 2025'), item('09:24', 'SHIPMENT ARRIVED AT PROCESSING FACILITY', 'LAHORE - PAKISTAN'),
      day('Tuesday, August 19 2025'), item('10:00', 'SHIPMENT DELIVERED', 'DUBAI'), item('10:00', 'SHIPMENT DELIVERED', 'DUBAI'),
    ].join('')), SAMPLE, 'International');
    expect(result.events!.map((event) => [event.local_time, event.description])).toEqual([
      ['2025-08-19T10:00:00', 'SHIPMENT DELIVERED'],
      ['2025-08-18T09:24:00', 'SHIPMENT ARRIVED AT PROCESSING FACILITY'],
    ]);
    expect(result.current_stage).toBe('delivered');
  });

  it('maps every wording seen live', () => {
    for (const entry of statuses.entries) {
      const result = parseEcl(withTimeline(day('Tuesday, September 30 2025') + item('09:31', entry.wording, 'DUBAI')), SAMPLE, 'International');
      expect(result.events![0], entry.wording).toMatchObject({ stage: entry.stage, stage_source: 'carrier_map' });
    }
  });
});
