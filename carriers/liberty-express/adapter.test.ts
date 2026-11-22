import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LIBERTY_SEARCH, LIBERTY_TRACKING, LibertyTracker } from './adapter.js';
import { libertyTrackingUrl, normalizeLibertyNumber, parseLiberty, parseLibertyForm, parseLibertySearch } from './parser.js';
import { libertyStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's package label, and the warehouse receipt the tracker resolves it to.
const LABEL = 'WR01-5028292620001';
const RECEIPT = 'WR01-502829262';
const UNKNOWN = 'WR01-999999990';
const TOKEN = 'CfDJ8SYNTHETICTRACKINGFORMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbb-cccc';
const ANTIFORGERY = '.AspNetCore.Antiforgery.Synthetic01';
const TRACKING = `${LIBERTY_TRACKING}?nGuia=${RECEIPT}&fromMobileApp=False&fromReactApp=False`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const edited = (html: string, from: string | RegExp, to: string) => {
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The page has no ${String(from)}`);
  return next;
};
const changed = (name: string, from: string | RegExp, to: string) => edited(fixture(name), from, to);
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { Location: location } });
const search = (cookies = [`${ANTIFORGERY}=syntheticCookie_1; path=/; samesite=strict; httponly`, '__cf_bm=synthetic; path=/']) =>
  new Response(fixture('form'), { headers: [['Content-Type', 'text/html; charset=utf-8'],
    ...cookies.map((cookie) => ['Set-Cookie', cookie] as [string, string])] });
const found = () => redirect(`/Tracking?nGuia=${RECEIPT}&fromMobileApp=False&fromReactApp=False`);
/** A transport that serves the search page, then `post` for the form, then `tracking` for the page it redirects to. */
const site = (post: () => Response = found, tracking: () => Response = () => page(fixture('ready-for-pickup')), first = search) =>
  vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return post();
    return String(url) === LIBERTY_SEARCH ? first() : tracking();
  });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const timeline = (html: string, number = LABEL) => parseLiberty(html, number).events!
  .map((event) => [event.local_time, event.stage ?? null, event.description]);

describe('Liberty Express HTTP adapter', () => {
  it('opens a session on the search page, posts the number with its token and reads the tracking page it is sent to', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LibertyTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' wr01 5028292620001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [[searchUrl, searchInit], [postUrl, postInit], [trackingUrl, trackingInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit], [string, RequestInit]];
    expect(searchUrl).toBe('https://iqpack.libertyexpress.com/SearchGuide');
    expect(searchInit).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(searchInit.headers).has('Cookie')).toBe(false);
    expect(postUrl).toBe(LIBERTY_SEARCH);
    expect(postInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      body: `hreflang=&FromMobileApp=False&FromReactApp=False&NGuia=${LABEL}&__RequestVerificationToken=${TOKEN}` });
    // Only the anti-forgery cookie goes back; the CDN's are left out.
    expect(postInit.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0',
      Cookie: `${ANTIFORGERY}=syntheticCookie_1`, Origin: 'https://iqpack.libertyexpress.com', Referer: LIBERTY_SEARCH });
    expect(trackingUrl).toBe(TRACKING);
    expect(trackingInit).toMatchObject({ redirect: 'manual' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'liberty-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the history newest first, each row on its wall clock, with the status above it', () => {
    expect(timeline(fixture('ready-for-pickup'))).toEqual([
      ['2026-11-06T12:46:31', 'ready_for_pickup', 'Disponible para su retiro'],
      ['2026-11-06T12:44:42', 'in_transit', 'En Auditoria para entrega'],
      ['2026-11-06T12:33:06', 'in_transit', 'Transferido'],
      ['2026-11-05T16:01:54', 'in_transit', 'Recibido en centro de distribucion local'],
      ['2026-10-29T16:54:56', null, 'Facturado OnLine'],
      ['2026-10-29T11:03:47', 'in_transit', 'A bordo, para ser transportado a su destino'],
      ['2026-10-29T09:36:51', 'in_transit', 'Empacado, listo para ser embarcado'],
      ['2026-10-27T15:10:15', 'accepted', 'Recibido en centro de distribucion'],
    ]);
    const result = parseLiberty(fixture('ready-for-pickup'), RECEIPT);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Disponible para su retiro', last_update: null, last_update_local: '2026-11-06T12:46:31', expected_delivery: null });
    expect(result).not.toHaveProperty('timezone');
    expect(result.events!.every((event) => !event.time && !event.location)).toBe(true);
  });

  it('orders rows by clock and keeps the order of rows that share one', () => {
    const html = changed('ready-for-pickup', '2026-11-06T12:44:42', '2026-11-06T12:46:31')
      .replace('datetime="2026-10-27T15:10:15"', 'datetime="2026-11-07T08:00"');
    expect(timeline(html).slice(0, 3)).toEqual([
      ['2026-11-07T08:00:00', 'accepted', 'Recibido en centro de distribucion'],
      ['2026-11-06T12:46:31', 'ready_for_pickup', 'Disponible para su retiro'],
      ['2026-11-06T12:46:31', 'in_transit', 'En Auditoria para entrega'],
    ]);
  });

  it('takes the stage from the newest staged row when the status above has no mapped wording', () => {
    const result = parseLiberty(changed('ready-for-pickup', '<h2>Disponible para su retiro</h2>', '<h2>Facturado OnLine</h2>'), LABEL);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', last_status_text: 'Facturado OnLine' });
    const unknown = changed('ready-for-pickup', '<h2>Disponible para su retiro</h2>', '<h2>Estado nuevo</h2>')
      .replace(/<h3>[^<]+<\/h3>/g, '<h3>Facturado OnLine</h3>');
    expect(parseLiberty(unknown, LABEL)).toMatchObject({ status: 'unknown', last_status_text: 'Estado nuevo' });
    expect(parseLiberty(unknown, LABEL)).not.toHaveProperty('current_stage');
  });

  it('reads the search page with its notice as not found, bound to the number in its field', async () => {
    expect(() => parseLibertySearch(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLibertySearch(fixture('not-found'), 'WR01-999999991')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = changed('not-found', /El n&#xFA;mero de la gu&#xED;a no existe[^<]*/, 'Ocurrió un error');
    expect(() => parseLibertySearch(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(site(() => page(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a redirect to another receipt, the message page or another route', async () => {
    expect(libertyTrackingUrl(`https://iqpack.libertyexpress.com/Tracking?nGuia=${RECEIPT}`, LABEL)).toBe(TRACKING);
    expect(() => libertyTrackingUrl('/Tracking?nGuia=WR01-502829263', LABEL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => libertyTrackingUrl('/Message', LABEL)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => libertyTrackingUrl('https://example.com/Tracking?nGuia=WR01-502829262', LABEL)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => libertyTrackingUrl(null, LABEL)).toThrow(expect.objectContaining({ kind: 'transport' }));
    await expect(carrier(site(() => redirect('/Message'))).track({ number: LABEL })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(site(found, () => redirect('/Message'))).track({ number: LABEL })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(site(found, () => redirect('/Home'))).track({ number: LABEL })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('refuses a tracking page for another receipt or without its parts', () => {
    expect(() => parseLiberty(changed('ready-for-pickup', `<strong>${RECEIPT}</strong>`, '<strong>WR01-502829263</strong>'), LABEL))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLiberty(changed('ready-for-pickup', `<strong>${RECEIPT}</strong>`, '<strong></strong>'), LABEL))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLiberty(changed('ready-for-pickup', 'class="tr-timeline"', 'class="tr-list"'), LABEL))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLiberty(changed('ready-for-pickup', '2026-11-06T12:46:31', '2026-02-30T12:46:31'), LABEL))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLiberty(changed('ready-for-pickup', '<h3>Transferido</h3>', '<h3></h3>'), LABEL))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = changed('ready-for-pickup', /<ol class="tr-timeline">[\s\S]*<\/ol>/, '<ol class="tr-timeline"></ol>');
    expect(() => parseLiberty(empty, LABEL)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate', reason: 'listed' }));
    expect(() => parseLiberty('<html><title>Just a moment...</title></html>', LABEL)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('reads the search form and refuses a changed one or a missing session', async () => {
    expect(parseLibertyForm(fixture('form'))).toBe(TOKEN);
    expect(() => parseLibertyForm(changed('form', 'name="NGuia"', 'name="Guia"'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLibertyForm(changed('form', TOKEN, 'short'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLibertyForm('<div class="cf-turnstile"></div>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const fetcher = site(found, undefined, () => search(['__cf_bm=synthetic; path=/']));
    await expect(carrier(fetcher).track({ number: LABEL })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps refusals, rate limits and outages apart from a missing receipt', async () => {
    await expect(carrier(site(() => new Response('', { status: 400 }))).track({ number: LABEL })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(site(undefined, undefined, () => page('<title>Just a moment...</title>', { status: 403 }))).track({ number: LABEL }))
      .rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(carrier(site(() => page('', { status: 403 }))).track({ number: LABEL })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(found, () => page('', { status: 403 }))).track({ number: LABEL })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(() => page('', { status: 429 }))).track({ number: LABEL })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(site(found, () => page('', { status: 404 }))).track({ number: LABEL })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(undefined, undefined, () => page('', { status: 404 }))).track({ number: LABEL }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(() => page('<html>changed</html>'))).track({ number: LABEL })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('retries once in a new session when the site cannot be reached', async () => {
    let failed = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (!failed) {
        failed = true;
        throw new TypeError('fetch failed');
      }
      if (init?.method === 'POST') return found();
      return String(url) === LIBERTY_SEARCH ? search() : page(fixture('ready-for-pickup'));
    });
    await expect(carrier(fetcher).track({ number: LABEL })).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('recognizes a receipt the tracker holds and refuses other numbers before any request', async () => {
    await expect(carrier(site()).recognize!(LABEL)).resolves.toMatchObject({ known: true });
    await expect(carrier(site(() => page(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toMatchObject({ known: false });
    const fetcher = site();
    await expect(carrier(fetcher).track({ number: '502829262' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('normalizes receipts and package labels to the form the search takes', () => {
    expect(normalizeLibertyNumber('WR01502829262')).toBe(RECEIPT);
    expect(normalizeLibertyNumber('wr01-502829262-0001')).toBe(LABEL);
    expect(normalizeLibertyNumber('WR02-123456789')).toBe('WR02-123456789');
    for (const bad of ['WR01-50282926', 'WR01-50282926200', 'WR1-502829262', 'WX01-502829262', 'W'.repeat(65)]) {
      expect(() => normalizeLibertyNumber(bad)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('leaves the shape it shares with BM Cargo receipts to an explicit choice', () => {
    for (const number of [RECEIPT, LABEL]) expect(detectCarrierMatch(number).candidates).not.toContain('liberty-express');
  });

  it('maps every recorded wording, and leaves the invoice without a stage on purpose', () => {
    for (const entry of statuses.entries) {
      expect(libertyStage(entry.wording)?.stage ?? null).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'liberty-express', description: entry.wording }))
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: expect.any(String) });
    }
    expect(statusMap.stage(null, normalizeStatusWording('Estado nuevo'))).toBeUndefined();
  });
});
