import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { normalizeFynexNumber, parseFynex } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };
import { TSS_SMART_UNKNOWN } from './tssSmart.js';

// The public sample in numbers.json and an invented number of the same shape.
const SAMPLE = '1092972';
const OTHER = '9999991';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const EMPTY = fixture('empty');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered sample's panel with its scan rows replaced.
const withRows = (rows: string) => DELIVERED.replace(/(<table[^>]*class="status-table">[\s\S]*?<\/tr>)[\s\S]*?(<\/table>)/, `$1${rows}$2`);
const row = (day: string, time: string, place: string, activity: string) => `<tr><td align="left" class="text-center">
   ${day}  <div class="second-line">${time}</div>
    </td><td align="left" class="text-left">${place}&nbsp;</td><td align="left" class="text-left">${activity}</td></tr>`;
// MAX Express's and DDU Express's panel for a number they do not know.
const UNKNOWN = EMPTY.replace(/(<div class="tracking-panel">)\s*(<\/div>)/, '$1<div class="alert alert-danger">\n\tInvalid airwaybill or booking number</div>$2');

describe('FyNEX numbers', () => {
  it('takes 5 to 30 letters and digits with at least one digit, in capitals', () => {
    expect(normalizeFynexNumber(` ${SAMPLE.slice(0, 3)} ${SAMPLE.slice(3)} `)).toBe(SAMPLE);
    expect(normalizeFynexNumber('fy12345')).toBe('FY12345');
    for (const other of ['', '1234', 'ABCDEFG', `${SAMPLE},${OTHER}`, '109/2972', '1'.repeat(31), '1'.repeat(65)]) {
      expect(() => normalizeFynexNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('FyNEX tracking adapter', () => {
  it('posts the number as the tracking page’s form does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://fynexcourierdubai.com/tracking/');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(String(init.body)).toBe(`trackno=${SAMPLE}`);
    expect(carrier(fetcher)).toMatchObject({ id: 'fynex', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('leaves the empty panel FyNEX shows for an unknown number open', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(html(EMPTY))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps challenges, refusals, redirects and changed pages apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>403 Forbidden</h1>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('', { status: 301, headers: { Location: 'https://fynexcourierdubai.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<!doctype html><html><body>FyNEX</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    // A panel with something other than a shipment or the build's not-found answer is a changed page.
    expect(await answer(() => html(EMPTY.replace('<div class="tracking-panel">', '<div class="tracking-panel"><p>Server busy</p>'))))
      .toMatchObject({ kind: 'schema' });
  });
});

describe('FyNEX replies', () => {
  it('reads the delivered sample’s scans with their wall clocks and places', () => {
    const result = parseFynex(DELIVERED, SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment Delivered', last_update: null, last_update_local: '2025-10-09T20:04:00',
      destination_country: 'AE', service_name: 'Domestic Above 30 Kg', weight_kg: 100, expected_delivery: null,
    });
    expect(result.events).toEqual([
      { local_time: '2025-10-09T20:04:00', description: 'Shipment Delivered', location: 'Al Ain', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2025-10-04T18:37:00', description: 'Shipment out for delivery', location: 'Al Ain', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2025-10-04T15:22:00', description: 'Shipment Collected at Despatch Center', location: 'Fynex Courier', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    // No offset is invented, and who signed is never read.
    for (const event of result.events!) expect(event.time).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/Received By|Signed/i);
  });

  it('cuts the receiver from a delivery scan and keeps scans newest first', () => {
    const result = parseFynex(withRows([
      row('04 Oct 2025', '03:22 PM', 'Fynex Courier', 'Shipment Collected at Despatch Center'),
      row('09 Oct 2025', '12:04 AM', 'Al Ain', 'Shipment Delivered Received By JANE PLACEHOLDER'),
      row('09 Oct 2025', '12:04 AM', 'Al Ain', 'Shipment Delivered Received By JANE PLACEHOLDER'),
    ].join('')), SAMPLE);
    expect(result.events!.map((event) => [event.local_time, event.description])).toEqual([
      ['2025-10-09T00:04:00', 'Shipment Delivered'],
      ['2025-10-04T15:22:00', 'Shipment Collected at Despatch Center'],
    ]);
    expect(JSON.stringify(result)).not.toContain('PLACEHOLDER');
  });

  it('keeps an unmapped wording visible without inventing a stage', () => {
    const result = parseFynex(withRows(row('05 Oct 2025', '10:00 AM', 'Al Ain', 'Consignee requested hold for collection')), SAMPLE);
    expect(result.events![0]).toMatchObject({ description: 'Consignee requested hold for collection' });
  });

  it('accepts only the panel for the number asked', () => {
    expect(() => parseFynex(DELIVERED, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFynex(DELIVERED.replace(`Tracking Number: ${SAMPLE}`, 'Tracking Number:'), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the build’s explicit answer as not found and an empty panel as open', () => {
    expect(TSS_SMART_UNKNOWN.test('Invalid airwaybill or booking number')).toBe(true);
    expect(() => parseFynex(UNKNOWN, OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFynex(EMPTY, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a shipment without scans, bad times and broken rows apart from a missing one', () => {
    expect(() => parseFynex(withRows(''), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    expect(() => parseFynex(withRows(row('31 Sep 2025', '10:00 AM', 'Al Ain', 'Shipment out for delivery')), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFynex(withRows(row('04 Oct 2025', '13:00 PM', 'Al Ain', 'Shipment out for delivery')), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFynex(withRows('<tr><td>04 Oct 2025</td></tr>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFynex(withRows(row('04 Oct 2025', '10:00 AM', 'Al Ain', '')), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('maps every wording seen live', () => {
    for (const entry of statuses.entries) {
      const result = parseFynex(withRows(row('05 Oct 2025', '10:00 AM', 'Al Ain', entry.wording)), SAMPLE);
      expect(result.events![0], entry.wording).toMatchObject({ stage: entry.stage, stage_source: 'carrier_map' });
    }
  });
});
