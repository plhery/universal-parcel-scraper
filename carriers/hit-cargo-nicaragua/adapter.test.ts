import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, HitCargoTracker, hitCargoTrackingUrl } from './adapter.js';
import { normalizeHitCargoNumber, parseHitCargo } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples in numbers.json.
const AIR = '926791';
const SEA = '910500';
const UNKNOWN = '000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8').trim();
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const CHECK = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
/** The reply for a guía: a sample's, and the not-found reply quoting any other. */
const reply = (number: string) => ([AIR, SEA].includes(number) ? { status: 200, body: fixture(number) }
  : { status: 404, body: fixture('not-found').replace(`\\"${UNKNOWN}\\"`, `\\"${number}\\"`) });
const numberOf = (url: unknown) => new URL(String(url)).pathname.split('/').pop()!;
/** The page a browser draws around a JSON reply. */
const drawn = (body: string) => `<html><head></head><body><pre>${body.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre></body></html>`;
const direct = () => vi.fn<typeof fetch>(async url => { const { status, body } = reply(numberOf(url)); return json(body, { status }); });
const carrier = (fetcher: typeof fetch, trawl: TrawlClient | null = null) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl, browserExecutablePath: null });
/**
 * A fetcher for the tracker that Cloudflare checks, and for a browser service that opens the
 * address it is asked for. The browser step sends its requests through the adapter's fetcher.
 */
const checked = (render: (url: string) => { status: number; html: string } = url => {
  const { status, body } = reply(numberOf(url));
  return { status, html: drawn(body) };
}) => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).startsWith('http://browser.test/')) return new Response(CHECK, { status: 403, headers: { 'Content-Type': 'text/html' } });
    const { url: address } = JSON.parse(String(init!.body)) as { url: string };
    const { status, html } = render(address);
    return Response.json({ tier: 3, statusCode: status, url: address, html });
  });
  return { fetcher, trawl: new TrawlClient('http://browser.test', fetcher) };
};

describe('HIT Cargo adapter', () => {
  it('reads the package’s status and events, with wall clocks and the tracker’s own instants apart', async () => {
    const fetcher = direct();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new HitCargoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 926 791 ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.hit-cargo.com/track/${AIR}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Entregado',
      last_update: null, last_update_local: '2026-06-17T15:47:00', weight_kg: 1.27, service_name: 'Aéreo', events: [
        { local_time: '2026-06-17T15:47:00', description: 'Delivered / Entregado', location: 'MGA', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-06-16T19:37:00', description: 'Recibido en Oficina Metrocentro', location: 'MGA', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-06-14T09:24:03.370Z', description: 'Recibido', location: 'MIA', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2026-06-12T14:31:00', description: 'Recibido', location: 'MIA', stage: 'accepted', stage_source: 'carrier_map' },
      ] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hit-cargo-nicaragua', step: 'direct', outcome: 'ok' }));
  });

  it('reads a sea package without its weight, and stages by the events when the status leaves it open', () => {
    expect(parseHitCargo(fixture(SEA), SEA)).toMatchObject({ current_stage: 'delivered', weight_kg: null, service_name: 'Marítimo',
      last_update_local: '2026-06-17T15:47:00', events: [{ description: 'Delivered / Entregado' }, {}, {}, { description: 'Recibido en Bodega Santa Maria' }, {}] });
    const partial = fixture(SEA).replace('"status":"entregado","statusLabel":"Entregado"', '"status":"parcial","statusLabel":"En preparación"');
    expect(parseHitCargo(partial, SEA)).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'En preparación' });
    // The newest event's instant, when the tracker wrote one.
    const newest = fixture(AIR).replace('"2026-06-17T15:47:00+00:00","description":"Delivered', '"2026-06-17T21:47:12.5+00:00","description":"Delivered');
    const read = parseHitCargo(newest, AIR);
    expect(read).toMatchObject({ last_update: '2026-06-17T21:47:12.500Z' });
    expect(read.events?.[0]).toEqual({ time: '2026-06-17T21:47:12.500Z', description: 'Delivered / Entregado', location: 'MGA', stage: 'delivered', stage_source: 'carrier_map' });
    expect(read).not.toHaveProperty('last_update_local');
  });

  it('opens the reply in the browser service when Cloudflare checks the direct read', async () => {
    const { fetcher, trawl } = checked();
    const result = await carrier(fetcher, trawl).track({ number: AIR });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([hitCargoTrackingUrl(AIR), 'http://browser.test/scrape']);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toMatchObject({ url: hitCargoTrackingUrl(AIR), skipHttp: true, maxTier: 3 });
    expect(result).toMatchObject({ current_stage: 'delivered', service_name: 'Aéreo' });
  });

  it('reads the not-found reply, directly or through the browser, and checks the guía it quotes', async () => {
    await expect(carrier(direct()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const service = checked();
    await expect(carrier(service.fetcher, service.trawl).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseHitCargo(fixture('not-found'), '000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHitCargo(fixture(AIR), SEA)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = fixture(AIR).replace(/"events":\[.*\]\}/, '"events":[]}');
    expect(() => parseHitCargo(empty, AIR)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('keeps a check, a rate limit and an outage apart from a missing package', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: AIR });
    await expect(answer(new Response(CHECK, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(new Response(CHECK))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(json('{"ok":false,"error":{"code":"RATE_LIMITED"}}', { status: 429, headers: { 'Retry-After': '60' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 });
    await expect(answer(new Response('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // A route the tracker no longer has is no missing package.
    await expect(answer(json('{"ok":false,"error":{"code":"NOT_FOUND","message":"Route \\"/track/926791\\" does not exist."}}', { status: 404 })))
      .rejects.toMatchObject({ kind: 'schema' });
    // The browser service is asked once, and its own check is a challenge too.
    const service = checked(() => ({ status: 200, html: CHECK }));
    await expect(carrier(service.fetcher, service.trawl).track({ number: AIR })).rejects.toMatchObject({ kind: 'challenge' });
    expect(service.fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries once when the first read does not reach the site', async () => {
    const fetcher = direct();
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: AIR }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads a changed reply as a schema change', () => {
    expect(() => parseHitCargo('<html><body>Maintenance</body></html>', AIR)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHitCargo('{"ok":true}', AIR)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHitCargo(fixture(AIR).replace('"2026-06-16T19:37:00+00:00"', '"16/06/2026 19:37"'), AIR)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHitCargo(fixture(AIR).replace('"description":"Recibido en Oficina Metrocentro"', '"description":""'), AIR)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes guías of digits alone', () => {
    expect(normalizeHitCargoNumber(' 926 791 ')).toBe(AIR);
    for (const bad of ['1234', '123456789', 'TBA123456', '926-791', '']) {
      expect(() => normalizeHitCargoNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the codes and wordings statuses.json records', () => {
    for (const entry of statuses.entries as ReadonlyArray<{ code?: string; wording: string; stage?: string; note: string }>) {
      const answer = statusMapAnswer({ carrier: 'hit-cargo-nicaragua', providerCode: entry.code ?? null, description: entry.wording });
      expect(answer, `${entry.code ?? ''} ${entry.wording}`).toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: entry.note });
    }
    expect(statusMapAnswer({ carrier: 'hit-cargo-nicaragua', providerCode: null, description: 'Factura #1 generada' })).toEqual({ kind: 'unknown' });
  });
});
