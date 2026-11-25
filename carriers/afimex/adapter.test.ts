import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, AFIMEX_PAGE, AFIMEX_RESULTS } from './adapter.js';
import { normalizeAfimexNumber, parseAfimex, readAfimexToken } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and the invented code of the not-found fixture.
const SAMPLE = '98805739';
const OTHER = '99000017';
const TOKEN = 'SyntheticFormToken0123456789abcdefghijKL';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
// The tracking page's form, as the page carries it, with a synthetic token.
const PAGE = `<html><body><form action="/rastrea-envio-resultado-v2" method="post">
  <input type="hidden" name="_token" value="${TOKEN}"><textarea name="guias"></textarea></form></body></html>`;
const html = (body: string, init: ResponseInit = {}, cookies: string[] = []) => {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=UTF-8', ...init.headers as Record<string, string> });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(body, { ...init, headers });
};
const SESSION = ['XSRF-TOKEN=synthetic-xsrf; path=/; samesite=lax', 'afimex_session=synthetic-session; path=/; httponly; samesite=lax'];
const page = () => html(PAGE, {}, SESSION);
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const tracker = (results: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async (url) => (
  String(url) === AFIMEX_PAGE ? page() : results())));

describe('Afimex numbers', () => {
  it('takes the eight-digit tracking code', () => {
    expect(normalizeAfimexNumber(` ${SAMPLE.slice(0, 4)} ${SAMPLE.slice(4)} `)).toBe(SAMPLE);
    for (const other of ['', '9880573', '988057390', 'A8805739', '3-1-988057390101N', `${SAMPLE}\n${OTHER}`, '1'.repeat(65)]) {
      expect(() => normalizeAfimexNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Afimex tracking adapter', () => {
  it('opens the tracking page’s session and posts the code with its form token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === AFIMEX_PAGE ? page() : html(DELIVERED)));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [pageUrl, pageInit] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(pageUrl).toBe(AFIMEX_PAGE);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual' });
    const [url, init] = fetcher.mock.calls[1]! as [string, RequestInit];
    expect(url).toBe(AFIMEX_RESULTS);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(String(init.body)).toBe(`_token=${TOKEN}&guias=${SAMPLE}`);
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(headers.get('cookie')).toBe('XSRF-TOKEN=synthetic-xsrf; afimex_session=synthetic-session');
    expect(carrier(fetcher)).toMatchObject({ id: 'afimex', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s “Sin Datos” as not found', async () => {
    await expect(tracker(() => html(NOT_FOUND)).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, expired sessions, moved routes and changed pages apart from a missing parcel', async () => {
    const answer = async (results: () => Response) => tracker(results).track({ number: OTHER }, { budgetMs: 2000 })
      .catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>Forbidden</h1>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    // Laravel's "Page Expired" refuses the session, which says nothing about the parcel.
    expect(await answer(() => html('<title>Page Expired</title>', { status: 419 }))).toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(await answer(() => html('', { status: 302, headers: { Location: AFIMEX_PAGE } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html><body><p>Mantenimiento</p></body></html>'))).toMatchObject({ kind: 'schema' });
    // A card for another guide is not an answer for this one.
    expect(await answer(() => html(DELIVERED))).toMatchObject({ kind: 'indeterminate' });
  });

  it('needs the page’s session and token before posting', async () => {
    const run = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await run(() => html(PAGE))).toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(await run(() => html('<html><body>Sin formulario</body></html>', {}, SESSION))).toMatchObject({ kind: 'schema' });
    expect(await run(() => html('<div class="g-recaptcha"></div>', {}, SESSION))).toMatchObject({ kind: 'challenge' });
    expect(readAfimexToken(PAGE)).toBe(TOKEN);
  });

  it('keeps the session cookie and the token out of failures', async () => {
    const error = await tracker(() => html('', { status: 500 })).track({ number: OTHER }, { budgetMs: 2000 })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'UpstreamHttpError', status: 500 });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(/synthetic-session|SyntheticFormToken/);
  });
});

describe('Afimex results', () => {
  it('reads the delivered sample’s timeline with its wall clocks, offices and stages', () => {
    const result = parseAfimex(DELIVERED, SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'ENTREGADA',
      last_update: null, last_update_local: '2022-02-17T10:41:00', expected_delivery: null,
    });
    const events = result.events ?? [];
    expect(events).toHaveLength(9);
    expect(events[0]).toEqual({
      local_time: '2022-02-17T10:41:00', description: 'ENTREGADA', location: 'CIUDAD VICTORIA', stage: 'delivered', stage_source: 'carrier_map',
    });
    expect(events[1]).toMatchObject({ local_time: '2022-02-17T07:44:00', description: 'EN RUTA', stage: 'out_for_delivery' });
    expect(events.at(-2)).toMatchObject({ local_time: '2022-02-16T17:21:00', description: 'DOCUMENTADA', location: 'MATAMOROS', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ local_time: '2021-09-21T15:17:00', description: 'VENDIDA', location: 'MONTERREY', stage: 'registered' });
  });

  it('never reads the recipient, couriers, operators, signature or delivery place', () => {
    const projected = JSON.stringify(parseAfimex(DELIVERED, SAMPLE));
    expect(projected).not.toMatch(/PERSONA|LOGIN|UNIDAD|Recibe|Driver|base64|latitud|Observaciones/);
  });

  it('turns an oldest-first timeline round', () => {
    // A synthetic page in the tracker's shape, its scans oldest first.
    const scan = (time: string, wording: string, office: string) => `<div><div class="timeline-item"><span class="time"> ${time}</span>
      <h3 class="timeline-header"><bold>${wording}</bold> :</h3><div class="timeline-body"><div class="row">
      <div class="col-md-12 pb-1"><div class="col-md-6">${office}</div></div></div></div></div></div>`;
    const synthetic = `<section id="guias"><div class="card-header"><p class="orange">${OTHER}</p>
      <p class="gray bold">Estatus: <span>EN RUTA<br />Ultima actualización: Jan 02, 2030 a 09:00 am</span></p></div></section>
      <section id="linea_de_tiempo"><p class="gray bold">Número DE GUÍA: <bold class="orange">${OTHER}</bold></p><div class="timeline">
      <div class="time-label"><span>2030-01-01</span></div>${scan('08:00:00', 'DOCUMENTADA', 'MONTERREY')}
      <div class="time-label"><span>2030-01-02</span></div>${scan('09:00:00', 'EN RUTA', 'SALTILLO')}</div></section>`;
    const result = parseAfimex(synthetic, OTHER);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_update_local: '2030-01-02T09:00:00' });
    expect(result.events!.map((event) => event.description)).toEqual(['EN RUTA', 'DOCUMENTADA']);
  });

  it('refuses invalid scan times and pages without results', () => {
    expect(() => parseAfimex(DELIVERED.replace('2022-02-17', '2022-02-30'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAfimex(DELIVERED.replace('10:41:00', '25:41:00'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAfimex(DELIVERED.replace(/<section id="linea_de_tiempo">/, '<section id="otra">'), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAfimex('<html><body></body></html>', SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Afimex statuses', () => {
  it('stages every wording seen by the map, whole', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'afimex', description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'ENTREGADA A MEDIAS')).toBeUndefined();
  });
});
