import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TFMXPRESS_TRACKER } from './adapter.js';
import { parseEzyFms, type EzyFmsTenant } from './ezyfms.js';
import { normalizeTfmxpressNumber, parseTfmxpress, TFMXPRESS } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and the invented number fixtures/not-found.html answers.
const SAMPLE = 'HSETUC17592';
const UNKNOWN = 'HSETQZ48213';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, status: string, depot: string, signed = '') =>
  `<tr><td>${clock}</td><td>${status}</td><td>${depot}</td><td style="text-align:center; vertical-align:middle;">${signed}</td></tr>`;
/** The public sample's page with only these rows, oldest first. */
const withRows = (...rows: string[]) => fixture('delivered').replace(/(<tbody>)[\s\S]*?(<\/tbody>)/, `$1${rows.join('')}$2`);

describe('TFMXpress numbers', () => {
  it('takes letters and digits with a digit, as long as the form takes', () => {
    expect(normalizeTfmxpressNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeTfmxpressNumber('12345678')).toBe('12345678');
    for (const other of ['', 'HS1', 'HSETUCABCDE', `${'A'.repeat(20)}1`, 'HSETUC_17592', 'X'.repeat(70)]) {
      expect(() => normalizeTfmxpressNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('TFMXpress tracking adapter', () => {
  it('posts the number with an empty postcode, as the tracker’s form does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.ezyfms.com/tfm/Tracker.asp');
    expect(TFMXPRESS_TRACKER).toBe(String(url));
    expect(init).toMatchObject({ method: 'POST', body: `CN=${SAMPLE}&PC=`, redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'tfmxpress', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number the tracker does not take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'HSETUC' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads "The tracking information is not available." for the number asked as not found', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('not-found')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, verification pages, error pages and redirects apart from a missing number', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Runtime Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Service Unavailable</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/' } }))).toMatchObject({ kind: 'transport' });
  });
});

describe('TFMXpress pages', () => {
  it('reads the public sample: wall clocks on the depot’s city, newest first, the ETA date and the delivery', () => {
    const result = parseTfmxpress(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'POD REGISTERED',
      last_update: '2024-11-12T11:54:46+10:30', last_update_local: '2024-11-12T11:54:46', expected_delivery: '2024-11-11',
      delivered_at: '2024-11-12T11:54:45+10:30',
    });
    expect(result.events).toHaveLength(7);
    expect(result.events![1]).toEqual({ time: '2024-11-12T11:54:45+10:30', local_time: '2024-11-12T11:54:45', time_zone: 'Australia/Adelaide',
      time_zone_basis: 'place', description: 'DELIVERED', location: 'ADELAIDE', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events![2]).toMatchObject({ local_time: '2024-11-12T08:24:18', description: 'LOAD FOR DELIVERY', stage: 'out_for_delivery' });
    expect(result.events![5]).toMatchObject({ time: '2024-11-11T14:11:32+11:00', time_zone: 'Australia/Melbourne', description: 'UNLOADED IN DEPOT',
      location: 'MELBOURNE', stage: 'in_transit' });
    expect(result.events!.at(-1)).toEqual({ time: '2024-11-11T08:05:39+11:00', local_time: '2024-11-11T08:05:39', time_zone: 'Australia/Melbourne',
      time_zone_basis: 'place', description: 'PICKED UP', location: 'MELBOURNE', stage: 'accepted', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('drops the signature and the signatory, and reads a depot no city names on the carrier’s clock', () => {
    const result = parseTfmxpress(withRows(
      row('03/01/2025 12:05:00 PM', 'PICKED UP', 'BRISBANE', '<img id=\'1\' src=\'net/rest/signature/?sig=1\' /><br /><span>SIGNATORY</span>'),
      row('04/01/2025 12:30:00 AM', 'CARD LEFT', 'TOWNSVILLE AGENT'),
    ), SAMPLE);
    expect(JSON.stringify(result)).not.toMatch(/SIGNATORY|signature/);
    expect(result.events![1]).toEqual({ time: '2025-01-03T12:05:00+10:00', local_time: '2025-01-03T12:05:00', time_zone: 'Australia/Brisbane',
      time_zone_basis: 'place', description: 'PICKED UP', location: 'BRISBANE', stage: 'accepted', stage_source: 'carrier_map' });
    // A wording the map does not know goes to the shared rules.
    expect(result.events![0]).toEqual({ time: '2025-01-04T00:30:00+11:00', local_time: '2025-01-04T00:30:00', time_zone: 'Australia/Melbourne',
      time_zone_basis: 'carrier', description: 'CARD LEFT', location: 'TOWNSVILLE AGENT', stage: 'failed_attempt', stage_source: 'wording:language' });
    expect(result).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'CARD LEFT' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('serves another tenant by its path, zone and depots', () => {
    const tenant: EzyFmsTenant = { ...TFMXPRESS, carrier: 'other', provider: 'Other', path: 'other', zone: 'Australia/Perth', depotZones: {} };
    expect(parseEzyFms(tenant, withRows(row('05/01/2025 09:00:00 AM', 'UNLOADED IN DEPOT', 'MELBOURNE')), SAMPLE).events![0])
      .toMatchObject({ time: '2025-01-05T09:00:00+08:00', time_zone: 'Australia/Perth', time_zone_basis: 'carrier' });
  });

  it('refuses a page for another number, and a changed page', () => {
    expect(() => parseTfmxpress(fixture('delivered'), 'HSETUC17593')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTfmxpress(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const page of [
      withRows(row('31/02/2024 08:05:39 AM', 'PICKED UP', 'MELBOURNE')),
      withRows(row('11/11/2024 13:05:39 PM', 'PICKED UP', 'MELBOURNE')),
      withRows(row('2024-11-11 08:05:39', 'PICKED UP', 'MELBOURNE')),
      withRows(row('11/11/2024 08:05:39 AM', '', 'MELBOURNE')),
      withRows('<tr><td>11/11/2024 08:05:39 AM</td><td>PICKED UP</td></tr>'),
      fixture('delivered').replace('<th>Status</th>', '<th>Event</th>'),
      fixture('delivered').replace('id="frmTracker"', 'id="frmSearch"'),
      '',
    ]) expect(() => parseTfmxpress(page, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTfmxpress(fixture('not-found').replace('The tracking information is not available.', 'Please enter correct destination postcode.'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTfmxpress(withRows(), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
  });

  it('answers each wording statuses.json records by its stage', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'tfmxpress', providerCode: '', description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    expect(statusMapAnswer({ carrier: 'tfmxpress', providerCode: '', description: 'CARD LEFT' })).toEqual({ kind: 'unknown' });
  });
});
