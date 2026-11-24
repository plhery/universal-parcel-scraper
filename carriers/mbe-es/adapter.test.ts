import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, mbeEsTrackingUrl } from './adapter.js';
import { normalizeMbeEsNumber, parseMbeEs } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's page as a browser renders it, an invented code's, and Akamai's refusal of an HTTP client.
const SAMPLE = 'ES0061-0L-000000VTHP';
const INVENTED = 'ES9999-0X-000000AAAA';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
const ACCESS_DENIED = fixture('access-denied');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const refused = () => html(ACCESS_DENIED, { status: 403 });
const trawlOf = (page: string, url = mbeEsTrackingUrl(SAMPLE)) => ({ scrape: vi.fn(async () => ({ html: page, url })) }) as unknown as TrawlClient & { scrape: ReturnType<typeof vi.fn> };
const carrier = (fetcher: typeof fetch, trawl: TrawlClient | null = null) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl, browserExecutablePath: null });
/** The sample's page with its scans in this order, newest first. */
const withScans = (rows: string[]) => DELIVERED.replace(/(<tbody>[\s\S]*?<\/tr>)[\s\S]*(<\/tbody>)/,
  (_whole, head: string, tail: string) => `${head}${rows.map((row) => `<tr><td>${row.split('|')[0]}</td><td>${row.split('|')[1]}</td></tr>`).join('')}${tail}`);

describe('MBE Spain codes', () => {
  it('takes the code with or without its hyphens, and writes them back as the tracker needs', () => {
    expect(normalizeMbeEsNumber(SAMPLE)).toBe(SAMPLE);
    expect(normalizeMbeEsNumber(' es00610l000000vthp ')).toBe(SAMPLE);
    expect(mbeEsTrackingUrl('ES00610L000000VTHP')).toBe(`https://www.mbe.es/es/tracking?c=${SAMPLE}`);
    for (const other of ['', '1Z21E7X76890915153', 'ES0061-0L-000000VTH', 'FR0061-0L-000000VTHP', 'ES006A-0L-000000VTHP', `${SAMPLE}%`]) {
      expect(() => normalizeMbeEsNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('MBE Spain tracking adapter', () => {
  it('reads the page an HTTP client gets, when Akamai lets it through', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(DELIVERED));
    await expect(carrier(fetcher).track({ number: 'ES00610L000000VTHP' })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.mbe.es/es/tracking?c=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'mbe-es', recordsSteps: true, steps: ['direct', 'retry', 'trawl'] });
  });

  it('takes Akamai’s refusal to the browser service, which opens the same page', async () => {
    const trawl = trawlOf(DELIVERED);
    await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => refused()), trawl).track({ number: SAMPLE }))
      .resolves.toMatchObject({ status: 'delivered', events: expect.any(Array) });
    expect(trawl.scrape).toHaveBeenCalledOnce();
    expect(trawl.scrape.mock.calls[0]![0]).toMatchObject({ url: mbeEsTrackingUrl(SAMPLE), contentWaitForSelector: '.tracking-res' });
  });

  it('reads the tracker’s notice as not found, through the browser service too', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => html(NOT_FOUND))).track({ number: INVENTED }))
      .rejects.toMatchObject({ kind: 'not_found' });
    const trawl = trawlOf(NOT_FOUND, mbeEsTrackingUrl(INVENTED));
    await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => refused()), trawl).track({ number: INVENTED }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, error pages, redirects and another page apart from a missing shipment', async () => {
    const answer = async (response: () => Response, trawl: TrawlClient | null = null) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()), trawl)
      .track({ number: INVENTED }, { budgetMs: trawl ? 60_000 : 2000 }).catch((error: unknown) => error);
    expect(await answer(refused)).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(ACCESS_DENIED))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>500</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.mbe.es/es' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html><body><h1>Mantenimiento</h1></body></html>'))).toMatchObject({ kind: 'schema' });
    // The browser landing on another address is no answer for the code.
    expect(await answer(refused, trawlOf(NOT_FOUND, 'https://www.mbe.es/es'))).toMatchObject({ kind: 'transport' });
  });
});

describe('MBE Spain replies', () => {
  it('reads the public sample: the courier’s scans newest first, its places moved to the location, their wall clocks kept', () => {
    const result = parseMbeEs(DELIVERED, SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'ENTREGADO',
      last_update: null, last_update_local: '2026-11-13T10:45:00', expected_delivery: null,
    });
    expect(result.events).toHaveLength(9);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2026-11-13T10:45:00', description: 'ENTREGADO', location: 'ALGETE', original_description: 'ALGETE - ENTREGADO', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-11-13T10:39:00', description: 'Listo para entrega hoy', location: 'Coslada', original_description: 'Coslada - Listo para entrega hoy',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-11-12T16:17:00', description: 'El remitente creó una etiqueta; UPS aún no ha recibido el paquete.',
      stage: 'registered', stage_source: 'carrier_map' });
    // The signer stays behind.
    expect(JSON.stringify(result)).not.toContain('FIRMANTE');
  });

  it('reads a shipment on its way by its newest staged scan, and one without scans as listed', () => {
    expect(parseMbeEs(withScans(['2026-11-13 02:30|Zaragoza - Escaneo nuevo', '2026-11-12 20:12|Barcelona - Ha llegado a las instalaciones']), SAMPLE))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Escaneo nuevo' });
    expect(() => parseMbeEs(withScans([]), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses an answer for another code, and a changed page', () => {
    expect(() => parseMbeEs(DELIVERED, INVENTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const changed of [
      '<html><body>Mantenimiento</body></html>',
      DELIVERED.replace('<span>Tracking</span>', '<span>Seguimiento</span>'),
      DELIVERED.replace('>Código<', '>Referencia<'),
      withScans(['13-11-2026 10:45|ALGETE - ENTREGADO']),
      NOT_FOUND.replace(/La búsqueda del código de envío no ha dado ningún resultado/, 'Error'),
    ]) {
      expect(() => parseMbeEs(changed, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('stages every wording the tracker relayed', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'mbe-es', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
  });
});
