import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, sueTrackingUrl } from './adapter.js';
import { normalizeSueNumber, parseSue, sueWallClock } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's reply, and the answer for a number far beyond the range in use.
const SAMPLE = 'SUE8910020752265FR';
const INVENTED = 'SUE9999000000017FR';
// The moment of the sample's lookup.
const LOOKUP = Date.parse('2026-11-21T21:49:01Z');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, place: string, text: string) => `<tr>\n<td>${clock}</td>\n<td>${place}</td>\n<td>${text}</td>\n</tr>`;
const HEADER = row('Date', 'Localisation', 'Details');
/** The public sample's page with only these rows under the table's header. */
const withRows = (...rows: string[]) => fixture(SAMPLE).replace(/(<div class="sue-tracking-steps">\s*<table>)[\s\S]*?(<\/table>)/, `$1${HEADER}${rows.join('')}$2`);

describe('Swiss Universal Express numbers', () => {
  it('takes SUE, thirteen digits and two letters', () => {
    expect(normalizeSueNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeSueNumber('SUE8910020752265DE')).toBe('SUE8910020752265DE');
    for (const other of ['', 'SUE891002075226FR', 'SUE89100207522651FR', 'SUE8910020752265', 'SUX8910020752265FR', '8910020752265', 'X'.repeat(70)]) {
      expect(() => normalizeSueNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('dates a row in the latest year that puts it no later than a day after the lookup', () => {
    expect(sueWallClock('03-28 at 10:39', LOOKUP)).toBe('2026-03-28T10:39:00');
    expect(sueWallClock('11-22 at 22:30', LOOKUP)).toBe('2026-11-22T22:30:00');
    expect(sueWallClock('11-23 at 08:00', LOOKUP)).toBe('2025-11-23T08:00:00');
    expect(sueWallClock('12-31 at 23:59', Date.parse('2027-01-02T08:00:00Z'))).toBe('2026-12-31T23:59:00');
    expect(sueWallClock('02-29 at 09:00', LOOKUP)).toBe('2024-02-29T09:00:00');
    for (const clock of ['13-01 at 10:00', '02-30 at 10:00', '03-28 at 24:00', '28/03 at 10:39', 'Le 28/03 à 10:39', '']) {
      expect(() => sueWallClock(clock, LOOKUP), clock).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Swiss Universal Express tracking adapter', () => {
  it('asks the tracker’s English page for the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture(SAMPLE)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://swiss-universal-express.ch/tracking/SUE8910020752265FR?lang=en');
    expect(sueTrackingUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'swiss-universal-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number outside SUE’s layout without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'SUE123FR' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).recognize!('SUE123FR')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the notice that the number is incorrect as not found, and recognizes a number with a history', async () => {
    const unknown = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture('not-found')));
    await expect(carrier(unknown).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(unknown).recognize!(INVENTED)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture(SAMPLE)));
    await expect(carrier(known).recognize!(SAMPLE)).resolves.toMatchObject({ known: true, lastActivityAt: null, lastActivityLocal: expect.stringMatching(/-03-28T10:39:00$/) });
  });

  it('keeps refusals, verification pages, error pages and redirects apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', { status: 403 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Server Error (500)</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Maintenance</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/tracking/' } }))).toMatchObject({ kind: 'transport' });
  });
});

describe('Swiss Universal Express pages', () => {
  it('reads the public sample: its rows on their wall clock, in the year the lookup puts them', () => {
    expect(parseSue(fixture(SAMPLE), SAMPLE, LOOKUP)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Your package arrived at the SUE center in Amsterdam.', last_update: null,
      last_update_local: '2026-03-28T10:39:00', expected_delivery: null,
      events: [
        { local_time: '2026-03-28T10:39:00', location: 'The Netherlands', description: 'Your package arrived at the SUE center in Amsterdam.', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-26T11:01:00', location: 'The Netherlands', description: "Your package is being prepared at the sender's warehouse.", stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads wording the map lacks by the shared rules, and the summary or the bar when no row gives a stage', () => {
    const delivered = parseSue(withRows(row('04-02 at 14:12', 'France', 'Your package has been delivered.'),
      row('03-28 at 10:39', 'The Netherlands', 'Your package arrived at the SUE center in Amsterdam.')), SAMPLE, LOOKUP);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: expect.stringMatching(/^wording:/) });
    const summary = parseSue(withRows(), SAMPLE, LOOKUP);
    expect(summary).toMatchObject({ current_stage: 'accepted', last_status_text: 'Your package is in our hands', last_update_local: '2026-03-28T10:39:00', summary_only: true, events: [] });
    const bar = parseSue(withRows().replace('Your package is in our hands', 'Synthetic status'), SAMPLE, LOOKUP);
    expect(bar).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Synthetic status' });
    const finished = withRows().replace('Your package is in our hands', 'Synthetic status')
      .replace(/sue-step-current/, 'sue-step-achieved').replace(/sue-result-step "/g, 'sue-result-step sue-step-achieved"');
    expect(parseSue(finished, SAMPLE, LOOKUP)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('refuses a page for another number, another language, and a changed page', () => {
    expect(() => parseSue(fixture(SAMPLE), INVENTED, LOOKUP)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const page of [
      fixture(SAMPLE).replace('Tracking information for', 'Suivi de votre colis'),
      fixture('not-found').replace('The number you entered is incorrect.', 'Something went wrong.').replaceAll(INVENTED, SAMPLE),
      withRows(row('03-28 at 10:39', 'The Netherlands', '')),
      withRows(row('Le 28/03 à 10:39', 'Pays-Bas', 'Votre colis est arrivé au centre SUE de Amsterdam.')),
      withRows('<tr><td>03-28 at 10:39</td><td>Your package arrived.</td></tr>'),
      fixture(SAMPLE).replace(/<div class="sue-result-sumup-diagram">[\s\S]*<\/table>\s*<\/div>/, ''),
    ]) expect(() => parseSue(page, SAMPLE, LOOKUP)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A history table without rows or a summary: SUE lists the number without saying where the parcel is.
    const listed = withRows().replace(/<div class="sue-result-sumup-title">[\s\S]*?<\/div>/, '');
    expect(() => parseSue(listed, SAMPLE, LOOKUP)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('answers each wording statuses.json records by its stage', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'swiss-universal-express', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    expect(statusMapAnswer({ carrier: 'swiss-universal-express', providerCode: null, description: 'Your package arrived at the SUE center in Geneva.' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });
});
