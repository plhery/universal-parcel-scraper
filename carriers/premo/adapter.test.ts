import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, premoTrackingUrl } from './adapter.js';
import { normalizePremoNumber, parsePremo, PREMO_TRACKER } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The first two public samples in numbers.json, the one in no-events.html, and an invented number the page does not know.
const SAMPLE = '00373402216232626881';
const PARTNER = '00373402216215907075';
const QUIET = '00373402216130853945';
const OTHER = 'PR9900000000017';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const HANDED_ON = fixture('partner');
const NO_EVENTS = fixture('no-events');
const NOT_FOUND = fixture('not-found');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered sample's page with its form asking for another number, or with its events replaced.
const asking = (number: string, page = DELIVERED) => page.replace(`value="${SAMPLE}"`, `value="${number}"`);
const withEvents = (items: string) => DELIVERED.replace(/(<ul class="package-tracking-events__list">)[\s\S]*?(<\/ul>)/, `$1${items}$2`);
const item = (code: string, heading: string, date: string) => `<li class="package-tracking-events__list-item">
<div class="package-tracking-event" data-api-key="${code}"><div class="package-tracking-event__header"><div class="package-tracking-event__header-content">
<h3 class="package-tracking-event__heading">${heading}</h3><p class="package-tracking-event__date">${date}</p></div></div>
<div class="package-tracking-event__content"><p>SYNTHETIC HELP TEXT</p></div></div></li>`;

describe('Premo numbers', () => {
  it('takes 6 to 40 letters and digits with at least one digit, in capitals', () => {
    expect(normalizePremoNumber(` ${SAMPLE.slice(0, 4)} ${SAMPLE.slice(4)} `)).toBe(SAMPLE);
    expect(normalizePremoNumber(OTHER.toLowerCase())).toBe(OTHER);
    for (const other of ['', '12345', 'ABCDEFGHIJ', `${SAMPLE},${OTHER}`, 'PR99/00000017', `${'A'.repeat(40)}1`, '1'.repeat(65)]) {
      expect(() => normalizePremoNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('opens the tracking page with the number as its id', () => {
    expect(premoTrackingUrl(SAMPLE)).toBe(`${PREMO_TRACKER}?id=${SAMPLE}`);
  });
});

describe('Premo tracking adapter', () => {
  it('reads the tracking page the search form opens for the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`https://www.premo.se/paketsparning?id=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'premo', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the page’s not-found answer as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(html(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, refusals, redirects and changed pages apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>403 Forbidden</h1>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://www.premo.se/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>Sidan finns inte</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<!doctype html><html><body>Premo</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    // Another error the page shows leaves the answer open.
    expect(await answer(() => html(asking(OTHER, NOT_FOUND.replace('error-message--no-package', 'error-message--server')))))
      .toMatchObject({ kind: 'indeterminate' });
  });
});

describe('Premo replies', () => {
  it('reads the delivered sample: booked, reloaded at Premo’s terminal and delivered, on Stockholm’s wall clocks', () => {
    expect(parsePremo(DELIVERED, SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Ditt paket har nu levererats med Premos tidningsbud', last_update: null,
      last_update_local: '2026-10-20T00:47:00', expected_delivery: null,
      events: [
        { local_time: '2026-10-20T00:47:00', description: 'Ditt paket har nu levererats med Premos tidningsbud', provider_code: '13',
          stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-10-19T14:43:00', description: 'Paketet har ankommit till vår terminal och lastas om för att delas ut',
          provider_code: '2', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-10-10T23:35:00', description: 'Vi är redo och väntar på att ditt paket ska överlämnas till oss',
          provider_code: '1', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads two failed rounds and the hand-over to a partner carrier the page does not name', () => {
    const result = parsePremo(HANDED_ON, PARTNER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Paketet levereras av samarbetstransportör',
      last_update_local: '2026-09-07T11:47:00' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['26', 'in_transit'], ['57', 'failed_attempt'], ['28', 'in_transit'], ['57', 'failed_attempt'], ['2', 'in_transit'], ['1', 'registered'],
    ]);
    // The help text under an event is not read.
    expect(JSON.stringify(result)).not.toContain('utdelningsförsök');
  });

  it('stages every code and heading the map lists', () => {
    for (const entry of statuses.entries) {
      const page = withEvents(item(entry.code, entry.wording, 'måndag 2030-01-14 kl. 09:05'));
      expect(parsePremo(page, SAMPLE).events?.[0], entry.code).toMatchObject({ provider_code: entry.code, stage: entry.stage, stage_source: 'carrier_map' });
      const uncoded = page.replace(/ data-api-key="[^"]*"/, '');
      expect(parsePremo(uncoded, SAMPLE).events?.[0], entry.code).toMatchObject({ stage: entry.stage, stage_source: 'carrier_map' });
    }
  });

  it('turns an oldest-first list round and keeps an event the map does not know visible', () => {
    const page = withEvents(item('1', 'Vi &#xE4;r redo', 'fredag 2030-01-11 kl. 08:00') + item('99', 'Zzz', 'måndag 2030-01-14 kl. 09:05'));
    const result = parsePremo(page, SAMPLE);
    expect(result.events?.map((event) => event.provider_code)).toEqual(['99', '1']);
    expect(result).toMatchObject({ status: 'pending', last_status_text: 'Zzz', last_update_local: '2030-01-14T09:05:00' });
    expect(result.events?.[0]).toEqual({ local_time: '2030-01-14T09:05:00', description: 'Zzz', provider_code: '99' });
    expect(result.events?.[1]).toMatchObject({ description: 'Vi är redo', stage: 'registered' });
  });

  it('reads a number in other case and spacing as the page’s', () => {
    expect(parsePremo(DELIVERED, ` ${SAMPLE.slice(0, 6)} ${SAMPLE.slice(6)}`)).toMatchObject({ current_stage: 'delivered' });
  });

  it('refuses a page for another number, an empty list, a page without events or its answer, and a bad clock', () => {
    expect(() => parsePremo(asking(OTHER), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePremo(withEvents(''), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePremo(NO_EVENTS, QUIET)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePremo(NO_EVENTS, QUIET)).not.toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePremo(withEvents(item('2', 'Paketet har ankommit', 'måndag 2030-02-30 kl. 09:05')), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePremo(withEvents(item('2', 'Paketet har ankommit', 'i morgon')), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePremo(withEvents(item('x1', 'Paketet har ankommit', 'måndag 2030-01-14 kl. 09:05')), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePremo(withEvents(item('2', '', 'måndag 2030-01-14 kl. 09:05')), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
