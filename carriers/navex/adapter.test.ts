import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CARRIERS } from '../../core/catalog/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError, UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, NAVEX_TRACKING, NavexTracker } from './adapter.js';
import { navexRequestNumber } from './number.js';
import { parseNavex } from './parser.js';
import { navexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's own example number, and a number it holds nothing for.
const RETURNED = '173890871951';
const UNKNOWN = '173890879999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => answer());
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Navex HTTP adapter', () => {
  it('asks the tracking page about the one number, through the supplied transport', async () => {
    const fetcher = answering(() => html(fixture('returned')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new NavexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${RETURNED} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'returned' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${NAVEX_TRACKING}?track=${RETURNED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'navex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a returned parcel’s history newest first, in Tunisian time, with its depots, merchant and destination', () => {
    const result = parseNavex(fixture('returned'), RETURNED);
    expect(result).toMatchObject({
      current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Retour traité', last_update: '2026-06-01T01:00:00+01:00', expected_delivery: null,
      sender_name: 'Ward Tn', receiver_address: 'Thala, Kasserine',
    });
    expect(result).not.toHaveProperty('delivered_at');
    // Fourteen rows, two of them the same scan.
    expect(result.events).toHaveLength(13);
    expect(result.events!.slice(2, 4)).toEqual([
      { time: '2026-04-17T00:45:00+01:00', description: 'Retour expéditeur', stage: 'returned', stage_source: 'carrier_map' },
      { time: '2026-04-15T14:23:00+01:00', description: 'En préparation pour retour', location: 'Tunis', stage: 'returned',
        stage_source: 'carrier_map' },
    ]);
    expect(result.events!.map((event) => event.stage)).toEqual(['returned', 'returned', 'returned', 'returned', 'returned',
      'out_for_delivery', 'exception', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'registered', 'registered']);
    expect(result.events!.at(-1)).toEqual({ time: '2026-04-13T14:33:00+01:00', description: 'Commande créée', stage: 'registered',
      stage_source: 'carrier_map' });
    // The notes under the rows and the masked recipient are not kept.
    const text = JSON.stringify(result);
    for (const dropped of ['Injoignable', 'Accepter', 'Console', 'M*****', '—']) expect(text).not.toContain(dropped);
  });

  it('reads a delivery from the shared rules, and keeps a wording no rule reads without a stage', () => {
    const first = /(<div class="timeline-item first">\s*<div class="label"[^>]*>\s*<i[^>]*><\/i>)Retour traité/;
    const delivered = parseNavex(fixture('returned').replace(first, '$1Livré'), RETURNED);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-06-01T01:00:00+01:00' });
    const unread = parseNavex(fixture('returned').replace(first, '$1Xyzzy'), RETURNED);
    expect(unread).toMatchObject({ current_stage: 'returned', last_status_text: 'Xyzzy' });
    expect(unread.events![0]).toEqual({ time: '2026-06-01T01:00:00+01:00', description: 'Xyzzy' });
    const empty = fixture('returned').replace(/<div class="timeline">[\s\S]*<\/div>\s*<\/div>\s*<div class="footer">/,
      '<div class="timeline"></div></div><div class="footer">');
    expect(() => parseNavex(empty, RETURNED)).toThrow(NoHistoryError);
  });

  it('reads the notice for the number shown back as not found, and nothing else', async () => {
    expect(() => parseNavex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A page about another number, or one without a notice or a parcel, is no answer about this one.
    expect(() => parseNavex(fixture('not-found'), RETURNED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const bare = fixture('not-found').replace(/<div class="alert error">[\s\S]*?<\/div>/, '');
    expect(() => parseNavex(bare, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const other = fixture('not-found').replace('Aucun colis trouvé pour ce numéro de suivi.', 'Service indisponible.');
    expect(() => parseNavex(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    await expect(carrier(answering(() => html(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('binds the answer to the card for the whole number asked', () => {
    const swapped = fixture('returned').replace(`<div class="value">${RETURNED}</div>`, '<div class="value">173890871950</div>');
    expect(() => parseNavex(swapped, RETURNED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed page or clock, and reads a browser check as a challenge', () => {
    expect(() => parseNavex('<html><body><h1>Navex</h1></body></html>', RETURNED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const clock of ['31/04/2026 à 00:45', '17/04/2026 à 24:00', '2026-04-17 00:45', '17/04/2026']) {
      expect(() => parseNavex(fixture('returned').replace('17/04/2026 à 00:45', clock), RETURNED), clock)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseNavex(CHALLENGE, RETURNED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: RETURNED });
    await expect(lookup(() => html(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Too Many Requests', { status: 429, headers: { 'Retry-After': '60' } })))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://navex.tn/' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks again once when Navex cannot be reached', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(html(fixture('returned')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new NavexTracker({ fetcher, recorder }).fetch(RETURNED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'returned' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: RETURNED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Navex does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1234567', '1738908719A1', 'NAV173890871951', '1'.repeat(21), `${'1'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: RETURNED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known number with its last instant and an unknown one as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture('returned'))).mockResolvedValueOnce(html(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(RETURNED)).resolves.toEqual({ known: true, lastActivityAt: '2026-06-01T00:00:00.000Z', finished: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('1234567')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('answers a number filed under Navex', async () => {
    const fetcher = answering(() => html(fixture('returned')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: RETURNED, carrier: 'navex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'navex', source: 'navex', result: { current_stage: 'returned' } });
  });
});

describe('Navex numbers and links', () => {
  it('takes the digits alone', () => {
    for (const number of [RETURNED, ` ${RETURNED} `, '1738 9087 1951', '173-890-871-951']) expect(navexRequestNumber(number)).toBe(RETURNED);
  });

  it('claims no number, so recognition never offers Navex', () => {
    expect(detectCarrierMatch(RETURNED).candidates).not.toContain('navex');
    expect(recognitionCandidates(RETURNED).map(({ carrier: id }) => id)).not.toContain('navex');
  });

  it('links to the page for one number, and reads that page’s address back', () => {
    expect(CARRIERS.navex.trackingUrl?.(RETURNED)).toBe(`https://app.navex.tn/track.php?track=${RETURNED}`);
    expect(parseTrackingInput(`https://app.navex.tn/track.php?track=${RETURNED}`)).toMatchObject({ trackingNumber: RETURNED, carrier: 'navex' });
  });
});

describe('Navex status vocabulary', () => {
  it('stages every recorded wording as the map does', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(navexStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'navex', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('livre', 'Retour traité')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'navex', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});
