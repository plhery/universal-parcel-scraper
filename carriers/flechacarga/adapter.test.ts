import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { FlechaCargaTracker } from './adapter.js';
import { flechaReference, FLECHA_ENDPOINT, FLECHA_SCRIPT, parseFlecha, publicTrackingToken } from './parser.js';
import { flechaStage } from './status.js';

const NUMBER = 'R000100000001', REFERENCE = 'R-0001-1', OTHER = 'R000100000002';
const TOKEN = 'SYNTHETIC_PUBLIC_GUEST_VALUE_ONLY';
const script = (token = TOKEN) => `var token='${token}';\nfunction buscar(){ const endpoint='${FLECHA_ENDPOINT}'; }`;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as {
  estado: number; mensaje: string; template: { estado: number; titulo: string; template: string; contenttemplate: string; nrotarea: number };
};
const parse = (data: unknown = fixture, number = NUMBER) => parseFlecha(JSON.stringify(data), number);

describe('FlechaCarga legacy guest receipt history', () => {
  it('binds the complete native receipt and preserves local minute scans without contact or cargo data', () => {
    const result = parse();
    expect(result).toMatchObject({ current_stage: 'delivered', status: 'delivered', last_update: null,
      last_update_local: '2020-11-11T11:26:00', expected_delivery: null });
    expect(result.events).toHaveLength(3);
    expect(result.events?.[0]).toMatchObject({ time: '2020-11-11T11:26:00', description: 'Entregado', stage: 'delivered' });
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC PERSON|SYNTHETIC ACCOUNT|SYNTHETIC CARGO|UNUSED COPY|nrotarea/);
  });

  it('keeps branch zeroes and follows only the official Number conversion of the serial', () => {
    expect(flechaReference(' r-0001-00000001 ')).toBe(REFERENCE);
    expect(flechaReference(NUMBER)).toBe(REFERENCE);
    expect(flechaReference('R00010')).toBe('R-0001-0');
    expect(() => flechaReference('R00019999999999999999')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    for (const number of ['', '12345678', 'RR00010001', 'https://other.invalid', 'R'.repeat(81)]) expect(() => flechaReference(number)).toThrow();
  });

  it('leaves modern FLC guides inconclusive without querying an unverified route', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new FlechaCargaTracker({ fetcher }).fetch('FLC0001A00000001')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires one exact returned heading and one native history table', () => {
    expect(() => parse(fixture, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const replacement of ['Nro. de comprobante: R-0001-2', 'Nro. de comprobante: R-0001-10']) {
      const value = structuredClone(fixture); value.template.template = value.template.template.replace('Nro. de comprobante: ' + REFERENCE, replacement);
      expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const value = structuredClone(fixture); value.template.template = value.template.template.replace('</body>', '<div>Nro. de comprobante: ' + REFERENCE + '</div></body>');
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    value.template.template = fixture.template.template.replace('Fecha', 'Other date');
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires the returned network title rather than shared-platform branding alone', () => {
    const value = structuredClone(fixture); value.template.titulo = 'Synthetic Other Carrier';
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    value.template.titulo = fixture.template.titulo;
    value.template.template = value.template.template.replace('<title>Buspack - Synthetic receipt history</title>', '<title>Synthetic Other Carrier</title>');
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('finalizes only the exact number-bound missing-operation reply', () => {
    const reply = { estado: -1, mensaje: 'No se encontro la operacion con numero:' + REFERENCE };
    expect(() => parse(reply)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(reply, OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const value of [{ estado: -1, mensaje: 'Token invalido' }, { estado: -1 },
      { ...reply, template: {} }, { estado: 0, mensaje: reply.mensaje }, { estado: 1, template: {} }, null, []]) {
      expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseFlecha('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseFlecha('<html>Nothing</html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not infer pickup readiness from arrival or preserve an old delivery across a new meaning', () => {
    expect(flechaStage('En Agencia Destino')).toBe('in_transit');
    expect(flechaStage('Entregado parcialmente')).toBeUndefined();
    const value = structuredClone(fixture); value.template.template = value.template.template.replace('En camino', 'Unknown earlier event');
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects changed calendars, missing dates and row shapes', () => {
    for (const [oldText, newText] of [['28/10/2020 10:15', '31/02/2020 10:15'], ['28/10/2020 10:15', '28/10/2020 10:15:00'],
      ['<td>En camino</td>', '<td>En camino</td><td>Synthetic extra field</td>']]) {
      const value = structuredClone(fixture); value.template.template = value.template.template.replace(oldText!, newText!);
      expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const value = structuredClone(fixture); value.template.template = value.template.template.replace(/<tr><td>[\s\S]*?<\/tr>/g, '');
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports truncated histories and rejects excessive replies', () => {
    const value = structuredClone(fixture), row = '<tr><td>11/11/2020 11:26</td><td>Entregado</td></tr>';
    value.template.template = fixture.template.template.replace(/<tr><td>[\s\S]*?<\/tr>/g, '').replace('</table>', row.repeat(101) + '</table>');
    expect(parse(value)).toMatchObject({ history_truncated: true });
    expect(parse(value).events).toHaveLength(100);
    value.template.template = value.template.template.replace('</table>', row.repeat(400) + '</table>');
    expect(() => parse(value)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('extracts only the unique public constant from the current guest script without executing it', () => {
    expect(publicTrackingToken(script())).toBe(TOKEN);
    for (const text of ['', script() + '\n' + script('SYNTHETIC_DIFFERENT_TOKEN'), script().replace(FLECHA_ENDPOINT, 'https://other.invalid/'),
      script().replace('function buscar', 'function signIn'), "var token='short';"]) {
      expect(() => publicTrackingToken(text)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => publicTrackingToken('<title>Access Denied</title>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses the supplied transport and budget for a fresh script then one whole receipt query', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.has('Authorization')).toBe(false); expect(headers.has('Cookie')).toBe(false);
      const url = new URL(String(input));
      if (url.href === FLECHA_SCRIPT) return new Response(script());
      expect(url.origin + url.pathname).toBe(FLECHA_ENDPOINT);
      expect([...url.searchParams.keys()]).toEqual(['numero', 'token']);
      expect(url.searchParams.get('numero')).toBe(REFERENCE); expect(url.searchParams.get('token')).toBe(TOKEN);
      return new Response(JSON.stringify(fixture), { status: 201 });
    });
    expect((await new FlechaCargaTracker({ fetcher }).fetch(NUMBER)).events).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('re-reads the public token on the next lookup instead of retaining a stale guest value', async () => {
    let scripts = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.href === FLECHA_SCRIPT) return new Response(script(TOKEN + ++scripts));
      expect(url.searchParams.get('token')).toBe(TOKEN + scripts);
      return new Response(JSON.stringify(fixture));
    });
    const tracker = new FlechaCargaTracker({ fetcher }); await tracker.fetch(NUMBER); await tracker.fetch(NUMBER);
    expect(scripts).toBe(2); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('preserves source rate limits, redirect refusals, cancellation and exhausted budgets', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('limited', { status: 429, headers: { 'Retry-After': '5' } }));
    await expect(new FlechaCargaTracker({ fetcher: limited }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 5000 });
    expect(limited).toHaveBeenCalledTimes(1);
    const moved = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://other.invalid' } }));
    await expect(new FlechaCargaTracker({ fetcher: moved }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    expect(moved).toHaveBeenCalledTimes(1);
    const fetcher = vi.fn<typeof fetch>();
    await expect(new FlechaCargaTracker({ fetcher }).fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(new FlechaCargaTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort(Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    fetcher.mockImplementation(async () => { controller.abort(Error('between phases')); return new Response(script()); });
    await expect(new FlechaCargaTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('between phases');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serves the selected carrier through the SDK and keeps the native wall clock', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => new Response(String(input) === FLECHA_SCRIPT ? script() : JSON.stringify(fixture)));
    const result = await createTracker({ fetcher, env: {}, providers: [] }).track({ number: NUMBER, carrier: 'flechacarga' }, { budgetMs: 5000 });
    expect(result).toMatchObject({ source: 'flechacarga', result: { current_stage: 'delivered', last_update_local: '2020-11-11T11:26:00' } });
    expect(result.result.events?.[0]?.time).toBe('2020-11-11T11:26:00');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
