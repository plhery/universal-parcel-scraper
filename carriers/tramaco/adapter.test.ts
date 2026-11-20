import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { TramacoTracker } from './adapter.js';
import { normalizeTramacoNumber, parseTramaco, tramacoTrackingUrl } from './parser.js';
import { ignoredTramacoWording, publicTramacoWording, tramacoStage } from './status.js';

const NUMBER = '984726193850612', OTHER = '968427105396284';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as {
  cuerpoRespuesta: { codigo: string; mensaje: string }; transaccion: { guia: string };
  lstSalidaTrackGuiaWs: { descripcion: string; fechaHora: string; estado: string }[];
};
const missing = readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8');
const parse = (value: unknown = fixture, status = 200) => parseTramaco(JSON.stringify(value), NUMBER, status);

describe('Tramaco guest guide milestones', () => {
  it('reads the whole guide and only the native client’s parcel milestones', () => {
    const result = parse();
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-02-12T10:03:00', expected_delivery: null });
    expect(result.events).toHaveLength(6);
    expect(result.events?.[0]).toMatchObject({ time: '2026-02-12T10:03:00', description: 'GUIA ENTREGADA', stage: 'delivered' });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'out_for_delivery', 'in_transit', 'in_transit', 'registered']);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|0000000000|CONTENEDOR|INICIO RUTA|INGRESO DE RUTA|latitud|longitud/);
    expect(result.delivered_at).toBeUndefined();
  });

  it('does not let later document-container or route bookkeeping undo delivery', () => {
    expect(ignoredTramacoWording('CS - GUIA COLOCADA EN CONTENEDOR CONTRATOS CONTRATOS QUITO MATRIZ-QUITO')).toBe(true);
    expect(ignoredTramacoWording('CS - GUIA COLOCADA EN CONTENEDOR CONTRATOS AGENCIA MANTA AGENCIA MANTA')).toBe(true);
    expect(ignoredTramacoWording('CI - GUIA RETIRADA DE CONTENEDOR CONTRATOS CONTRATOS QUITO MATRIZ-QUITO')).toBe(true);
    expect(ignoredTramacoWording('CS - GUIA COLOCADA EN CONTENEDOR DE CARGA')).toBe(false);
    expect(ignoredTramacoWording('DR - INGRESO DE RUTA')).toBe(true);
    expect(ignoredTramacoWording('INICIO RUTA DE RETIRO')).toBe(true);
    const onlyDocuments = { ...fixture, lstSalidaTrackGuiaWs: fixture.lstSalidaTrackGuiaWs.filter(row => ignoredTramacoWording(row.descripcion)) };
    expect(() => parse(onlyDocuments)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ ...fixture, lstSalidaTrackGuiaWs: [] })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('removes the delivery signer and identity tail rather than copying it as an original description', () => {
    expect(publicTramacoWording('GUIA ENTREGADA -SYNTHETIC SIGNER - 0000000000')).toBe('GUIA ENTREGADA');
    expect(tramacoStage('GUIA ENTREGADA -SYNTHETIC SIGNER - 0000000000')).toMatchObject({ stage: 'delivered' });
    expect(publicTramacoWording('DR - SALIENDO A ENTREGA')).toBe('DR - SALIENDO A ENTREGA');
    expect(tramacoStage('GUIA ENTREGADA - RECHAZADA')).toBeNull();
    expect(tramacoStage('GUIA ENTREGADA - DEVOLUCION')).toBeNull();
  });

  it('requires successful native structure and the exact returned transaction guide', () => {
    for (const value of [null, [], {}, { ...fixture, cuerpoRespuesta: { codigo: '0', mensaje: 'EXEPCION' } },
      { ...fixture, transaccion: {} }, { ...fixture, transaccion: { guia: Number(NUMBER) } },
      { ...fixture, lstSalidaTrackGuiaWs: null }]) {
      expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parse({ ...fixture, transaccion: { guia: OTHER } })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes only the native whole-guide-bound HTTP 502 missing notice', () => {
    expect(() => parseTramaco(missing, NUMBER, 502)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTramaco(missing, OTHER, 502)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTramaco('<html>Bad Gateway</html>', NUMBER, 502)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseTramaco(missing, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTramaco(missing.replace('No se encontró', 'Synthetic failure'), NUMBER, 502)).toThrow(expect.objectContaining({ kind: 'transport' }));
  });

  it('preserves minute wall clocks and rejects invalid calendars or new milestone shapes', () => {
    for (const clock of ['31/02/2026 10:03', '12/02/2026 25:03', '2026-02-12T10:03:00Z', '12/02/26 10:03']) {
      const value = structuredClone(fixture);value.lstSalidaTrackGuiaWs[2]!.fechaHora = clock;
      expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const value = structuredClone(fixture);value.lstSalidaTrackGuiaWs[2]!.descripcion = 'SYNTHETIC NEW MILESTONE';
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTramaco('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('bounds history without changing the truncation contract', () => {
    const row = fixture.lstSalidaTrackGuiaWs[2]!;
    expect(parse({ ...fixture, lstSalidaTrackGuiaWs: Array.from({ length: 101 }, () => row) }))
      .toMatchObject({ history_truncated: true });
    expect(parse({ ...fixture, lstSalidaTrackGuiaWs: Array.from({ length: 101 }, () => row) }).events).toHaveLength(100);
    expect(() => parse({ ...fixture, lstSalidaTrackGuiaWs: Array.from({ length: 501 }, () => row) }))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses one supplied guest GET, without accounts, map, phone or document requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));expect(url.origin).toBe('https://www.tramaco.com.ec');
      expect(url.pathname).toBe('/apis/tracking_web.php');expect([...url.searchParams]).toEqual([['campo', 'guia'], ['valor', NUMBER]]);
      expect(init?.method ?? 'GET').toBe('GET');expect(init?.body).toBeUndefined();expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('X-Requested-With')).toBe('XMLHttpRequest');
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);expect(new Headers(init?.headers).has('Cookie')).toBe(false);
      return new Response(JSON.stringify(fixture));
    });
    expect((await new TramacoTracker({ fetcher }).fetch(NUMBER)).events).toHaveLength(6);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(tramacoTrackingUrl(NUMBER)).toContain('campo=guia');
  });

  it('preserves rate limits, redirects, budgets and cancellation', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('limited', { status: 429, headers: { 'Retry-After': '5' } }));
    await expect(new TramacoTracker({ fetcher: limited }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 5000 });
    const redirected = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://other.invalid/' } }));
    await expect(new TramacoTracker({ fetcher: redirected }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(new TramacoTracker({ fetcher }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(new TramacoTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort(Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const value of ['', '1'.repeat(14), '1'.repeat(16), 'https://other.invalid']) expect(() => normalizeTramacoNumber(value)).toThrow();
    expect(normalizeTramacoNumber(NUMBER.replace(/(.{5})/g, '$1 '))).toBe(NUMBER);
  });

  it('serves the selected carrier through the SDK while preserving native local clocks and repeat policy', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(fixture)));
    const answer = await createTracker({ fetcher, env: {}, providers: [] }).track({ number: NUMBER, carrier: 'tramaco' }, { budgetMs: 5000 });
    expect(answer).toMatchObject({ source: 'tramaco', carrier: 'tramaco', result: { current_stage: 'delivered', last_update_local: '2026-02-12T10:03:00' } });
    expect(answer.result.events).toHaveLength(5);
    expect(answer.result.events?.[0]?.time).toBe('2026-02-12T10:03:00');
    expect(JSON.stringify(answer.result)).not.toMatch(/SYNTHETIC SIGNER|0000000000|CONTENEDOR/);
  });
});
