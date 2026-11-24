import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, COPE_LOOKUP } from './adapter.js';
import { normalizeCopeNumber, parseCope } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples in numbers.json, and an invented number the tests give their replies to.
const SAMPLE = 'GFT012578';
const PICKED_UP = 'GFT006460';
const OTHER = 'ZZQ0000001';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture(SAMPLE);
const NOT_FOUND = fixture('not-found');
const ROW = /\s*<tr>\s*<td nowrap="nowrap">[^<]*<\/td>\s*<td nowrap="nowrap">[^<]*<\/td>\s*<td nowrap="nowrap">[^<]*<\/td>\s*<td nowrap="nowrap">[^<]*<\/td>\s*<\/tr>/g;
const row = (cells: string[]) => `<tr>${cells.map((cell) => `<td nowrap="nowrap">${cell}</td>`).join('')}</tr>`;
/** The sample's reply under another number, with its rows or its estimate replaced when given. */
const reply = (changes: { number?: string; rows?: string[][]; estimate?: string } = {}): string => {
  let html = DELIVERED.replaceAll(SAMPLE, changes.number ?? OTHER);
  if (changes.rows) {
    html = html.replace(ROW, '').replace(/(<tbody>\s*)(<\/tbody>\s*<\/table>\s*<\/body>)/, `$1${changes.rows.map(row).join('')}$2`);
  }
  if (changes.estimate !== undefined) html = html.replace('<strong>20/05/2026</strong>', `<strong>${changes.estimate}</strong>`);
  return html;
};
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('COPE numbers', () => {
  it('takes the sender’s letter code and its digits, in capitals', () => {
    expect(normalizeCopeNumber(` ${SAMPLE.toLowerCase().slice(0, 3)} ${SAMPLE.slice(3)} `)).toBe(SAMPLE);
    expect(normalizeCopeNumber('BRU1414966')).toBe('BRU1414966');
    for (const other of ['', '012578', 'GFT', 'GFT012578A', 'GFT01', 'ABCDEFG12345', 'G'.repeat(65)]) {
      expect(() => normalizeCopeNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('COPE tracking adapter', () => {
  it('posts the number to the theme’s action, as the tracking pop-up’s script does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(COPE_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ action: 'get_consignment', consignment_code: SAMPLE });
    expect(new Headers(init.headers).get('x-requested-with')).toBe('XMLHttpRequest');
    expect(carrier(fetcher)).toMatchObject({ id: 'cope-sensitive-freight', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads eSmart’s empty page for an unknown number as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(html(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, error pages, redirects and empty replies apart from a missing consignment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://www.cope.com.au/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('0', { status: 400 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Server Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html(''))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('<html><body><h1>Maintenance</h1></body></html>'))).toMatchObject({ kind: 'schema' });
  });
});

describe('COPE replies', () => {
  it('reads the public sample: its rows newest first, on their wall clock', () => {
    expect(parseCope(DELIVERED, SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'PROOF OF DELIVERY',
      last_status_text: 'Delivery at receiver', last_update: null, last_update_local: '2026-05-21T13:14:00',
      expected_delivery: null, service_name: 'TAIL GATE-ROAD',
      events: [
        { local_time: '2026-05-21T13:14:00', description: 'Delivery at receiver', provider_code: 'PROOF OF DELIVERY', location: 'ELLENBROOK WA', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-05-21T10:26:00', description: 'Articles loaded for delivery', provider_code: 'ON BOARD FOR DELIVERY', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-05-21T10:25:00', description: 'Articles in movement', provider_code: 'IN TRANSIT', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-05-12T16:28:00', description: 'Job dispatched', provider_code: 'ALLOCATED', stage: 'registered', stage_source: 'carrier_map' },
        { local_time: '2026-05-12T16:11:00', description: 'Job created', provider_code: 'NEW', location: 'BROADMEADOWS VIC', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('keeps two rows of one minute in the carrier’s order', () => {
    const events = parseCope(fixture(PICKED_UP), PICKED_UP).events!;
    expect(events.map((event) => event.provider_code)).toEqual(['PROOF OF DELIVERY', 'ON BOARD FOR DELIVERY', 'IN TRANSIT', 'PICKED UP', 'ALLOCATED', 'NEW']);
    expect(events[3]).toMatchObject({ local_time: '2025-11-13T17:28:00', stage: 'accepted' });
  });

  it('gives the estimate while the consignment is on its way, and reads an unknown stage by its wording', () => {
    const rows = [['12/05/2026 16:11', 'BROADMEADOWS VIC', 'Job created', 'NEW'], ['13/05/2026 08:02', 'PERTH AIRPORT WA', 'Articles arrived at depot', 'AT DEPOT']];
    const result = parseCope(reply({ rows }), OTHER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', provider_code: 'AT DEPOT', expected_delivery: '2026-05-20' });
    expect(result.events![0]).toMatchObject({ location: 'PERTH AIRPORT WA', stage: 'in_transit', stage_source: expect.stringMatching(/^wording:/) });
    expect(parseCope(reply({ rows, estimate: '01/05/2026' }), OTHER).expected_delivery).toBeNull();
    expect(parseCope(reply({ rows, estimate: '' }), OTHER).expected_delivery).toBeNull();
  });

  it('leaves out an activity that names who took the consignment', () => {
    const result = parseCope(reply({ rows: [['21/05/2026 13:14', 'ELLENBROOK WA', 'Signed by SYNTHETIC RECEIVER', 'PROOF OF DELIVERY']] }), OTHER);
    expect(result.events![0]).toMatchObject({ description: 'PROOF OF DELIVERY', stage: 'delivered' });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC/);
  });

  it('binds the reply to the number asked', () => {
    expect(() => parseCope(reply(), 'ZZQ0000002')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCope(reply({ rows: [] }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a changed reply', () => {
    const emptyHead = NOT_FOUND.replace(/(<tbody>\s*)(<\/tbody>\s*<\/table>\s*<\/body>)/, `$1${row(['12/05/2026 16:11', '', 'Job created', 'NEW'])}$2`);
    for (const changed of ['', '<html></html>', DELIVERED.replace('Current Stage', 'Stage now'), DELIVERED.replace('<td>Activity</td>', '<td>Event</td>'),
      DELIVERED.replace(/<table id="tableContent" style[^>]*>/, '<table>'), emptyHead,
      reply({ rows: [['2026-05-12 16:11', '', 'Job created', 'NEW']] }), reply({ rows: [['31/02/2026 16:11', '', 'Job created', 'NEW']] }),
      reply({ rows: [['12/05/2026 16:11', '', '', 'NEW']] }), reply({ rows: [['12/05/2026 16:11', 'Job created', 'NEW']] })]) {
      expect(() => parseCope(changed, OTHER), changed.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('COPE statuses', () => {
  it('maps each stage the tracker was seen to give', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'cope-sensitive-freight', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('Unknown', 'anything')).toBeUndefined();
  });
});
