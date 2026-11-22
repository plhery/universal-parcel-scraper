import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { CorreosGuatemalaTracker } from './adapter.js';
import { CORREOS_GUATEMALA_PAGE, normalizeCorreosGuatemalaNumber, parseCorreosGuatemala } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = 'RT631347091DE';
const RETURNING = 'CH220800969US';
const CUSTOMS = 'CH259243263US';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
// The page without the full history it carries in a comment.
const stepsOnly = (html: string) => html.replace('<h2>Historial Completo:</h2>', '<h2>Historial</h2>');

describe('Correos de Guatemala guest adapter', () => {
  it('posts one item code as the tracking form does, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new CorreosGuatemalaTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' rt 631 347 091 de ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(CORREOS_GUATEMALA_PAGE);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: `tracking=${DELIVERED}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Entregado el 30/10/2026, gracias por tu confianza.',
      last_update: null, last_update_local: '2026-10-30T14:37:00', destination_country: 'GT' });
  });

  it('reads the office scans of the full history with their clocks, codes and offices', () => {
    const result = parseCorreosGuatemala(page('delivered.html'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.location, event.stage])).toEqual([
      ['2026-10-30T14:37:00', '37', 'Atencion al Cliente Zona 1 Central', 'delivered'],
      ['2026-10-30T14:36:03', '32', 'Atencion al Cliente Zona 1 Central', 'in_transit'],
      ['2026-10-30T14:31:50', '1106', 'GUATEMALA CITY AVION', 'in_transit'],
      ['2026-10-28T11:00:03', '1106', 'REBUT', 'in_transit'],
      ['2026-10-09T08:05:18', '1106', 'Carteros DGCT', 'in_transit'],
      ['2026-10-08T10:05:55', '36', 'Carteros DGCT', 'failed_attempt'],
      ['2026-10-08T08:29:09', '36', 'Carteros DGCT', 'failed_attempt'],
      ['2026-10-05T16:31:17', '31', 'GUATEMALA CITY AVION', 'customs'],
      ['2026-10-05T16:30:49', '30', 'GUATEMALA CITY AVION', 'in_transit'],
    ]);
    expect(result.events![0]!.description).toBe('Envio Entregado');
    expect(result.events!.every(event => !event.time)).toBe(true);
  });

  it('falls back to the days of the steps the page shows when the full history is missing or reshaped', () => {
    for (const html of [stepsOnly(page('delivered.html')), page('delivered.html').replace('<th>Fuente</th>', '<th>Origen</th>')]) {
      const result = parseCorreosGuatemala(html, DELIVERED);
      expect(result.events!.map(event => [event.local_time, event.description, event.stage])).toEqual([
        ['2026-10-30', 'Correspondencia entregado.', 'delivered'],
        ['2026-10-30', 'Correspondencia en proceso de entrega.', 'in_transit'],
        ['2026-10-08', 'Intento fallido de entrega.', 'failed_attempt'],
        ['2026-10-05', 'Correspondencia ingreso a revisión aduanera.', 'customs'],
        ['2026-10-05', 'Correspondencia ingreso a Guatemala', 'in_transit'],
      ]);
      expect(result).toMatchObject({ status: 'delivered', last_update_local: '2026-10-30' });
    }
  });

  it('takes the status line for a return and a customs hold, and drops the return country', () => {
    const returning = parseCorreosGuatemala(page('returning.html'), RETURNING);
    expect(returning).toMatchObject({ current_stage: 'returned', last_status_text: 'Tu Paquete se encuentra en proceso de devolución.',
      last_update_local: '2024-12-13T10:17:20' });
    expect(returning.destination_country).toBeUndefined();
    expect(returning.events![0]).toMatchObject({ provider_code: '8', location: 'GUATEMALA CA COLIS', stage: 'in_transit' });
    expect(parseCorreosGuatemala(stepsOnly(page('returning.html')), RETURNING).events![0]).toMatchObject({
      local_time: '2024-12-13', description: 'Paquete devuelto a su país de origen.', stage: 'returned' });
    const customs = parseCorreosGuatemala(page('customs.html'), CUSTOMS);
    expect(customs).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'Paquete retenido en Aduana.',
      last_update_local: '2026-09-30T13:48:25', destination_country: 'GT' });
  });

  it('reports an unknown item as not found and requires the whole item code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new CorreosGuatemalaTracker({ fetcher }).fetch('RR987654326GT')).rejects.toMatchObject({ kind: 'not_found' });
    const html = page('delivered.html');
    expect(() => parseCorreosGuatemala(html, 'RT631347092DE')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCorreosGuatemala(html.replace('2026-10-05 16:30:49.933', '2026-02-30 16:30:49.933'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosGuatemala(stepsOnly(html).replace('30/10/2026</h6>', '31/02/2026</h6>'), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosGuatemala(page('not-found.html').replace('No se encontro', 'Servicio no disponible'), 'RR987654326GT'))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosGuatemala('<html><title>Mantenimiento</title></html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['RT63134709DE', 'RT6313470911DE', '631347091', 'RT631347091D']) {
      expect(() => normalizeCorreosGuatemalaNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseCorreosGuatemala('<html><title>Request Rejected</title><body>The requested URL was rejected.</body></html>', DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new CorreosGuatemalaTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps scan codes, steps and status lines, and leaves others without a stage', () => {
    expect(statusMap.stage('31', '')).toBe('customs');
    expect(statusMap.stage('', 'Correspondencia retenido en Aduana.')).toBe('customs');
    expect(statusMap.stage('', 'Entregado el 09/12/2024, gracias por tu confianza.')).toBe('delivered');
    expect(statusMap.stage('999', '')).toBeUndefined();
    const result = parseCorreosGuatemala(page('delivered.html').replace('<td>37</td>', '<td>999</td>')
      .replace('Entregado el 30/10/2026, gracias por tu confianza.', 'Consulte en su oficina.'), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '999', description: 'Envio Entregado' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Consulte en su oficina.' });
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('correos-guatemala');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'correos-guatemala', number: DELIVERED });
    expect(tracked.source).toBe('correos-guatemala');
    expect(tracked.result.status).toBe('delivered');
  });
});
