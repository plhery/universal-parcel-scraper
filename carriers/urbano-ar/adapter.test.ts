import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UrbanoArTracker, normalizeUrbanoNumber, parseUrbanoDetail, parseUrbanoLookup, urbanoLookupUrl, urbanoResult } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SAMPLE = numbers.records[0]!.number;
const UNKNOWN = '22730000000099999990';
const lookupDelivered = fixture('lookup-delivered.html');
const detailDelivered = fixture('detail-delivered.html');
const lookupNotFound = fixture('lookup-not-found.html');

function fetcher(pages: { lookup: string; detail?: string; lookupStatus?: number }, seen: { url: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    if (url.startsWith('https://apis.urbano.com.ar/cespecifica/?')) {
      return new Response(pages.lookup, { status: pages.lookupStatus ?? 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    }
    return new Response(pages.detail ?? '', { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
  });
}

describe('Urbano Argentina numbers', () => {
  it('splits a number the way the tracking form does', () => {
    expect(normalizeUrbanoNumber(SAMPLE)).toEqual({ number: SAMPLE, shipper: '002273', code: '0000000043041054' });
    expect(normalizeUrbanoNumber('dvpq0101 0000000043041054')).toMatchObject({ shipper: '002273', code: '0000000043041054' });
    expect(urbanoLookupUrl(normalizeUrbanoNumber(SAMPLE)))
      .toBe('https://apis.urbano.com.ar/cespecifica/?shi_codigo=002273&cli_codigo=0000000043041054');
  });

  it('rejects numbers the form cannot split', () => {
    for (const raw of ['', '2273', 'ABCD12345', '2273-', 'x'.repeat(80)]) {
      expect(() => normalizeUrbanoNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Urbano Argentina pages', () => {
  it('reads the delivered sample with its scans, newest first and on wall clocks', () => {
    const asked = normalizeUrbanoNumber(SAMPLE);
    const result = urbanoResult(parseUrbanoLookup(lookupDelivered, asked), [parseUrbanoDetail(detailDelivered)]);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Su envio fue entregado', last_update: null,
      last_update_local: '2023-05-09T15:49:00',
    });
    const events = result.events ?? [];
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({ provider_code: 'DL', location: 'PARANA', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[1]).toMatchObject({ provider_code: 'EI', local_time: '2023-05-09T15:49:00' });
    expect(events.at(-1)).toMatchObject({ provider_code: 'AS', description: 'Su envio esta en viaje a sucursal', stage: 'in_transit' });
    const text = JSON.stringify(result);
    for (const personal of ['***', 'LOCALIDAD', 'Nombre', 'cliId']) expect(text).not.toContain(personal);
  });

  it('reads the invented code\'s row as not found', () => {
    const asked = normalizeUrbanoNumber(UNKNOWN);
    const rows = parseUrbanoLookup(lookupNotFound, asked);
    expect(() => urbanoResult(rows, [])).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('reads a registered code without a guide as listed without history', () => {
    const asked = normalizeUrbanoNumber(UNKNOWN);
    const listed = lookupNotFound.replace('&quot;cliId&quot;:&quot;0&quot;', '&quot;cliId&quot;:&quot;84713166&quot;');
    expect(listed).not.toBe(lookupNotFound);
    expect(() => urbanoResult(parseUrbanoLookup(listed, asked), [])).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('refuses a page for another number', () => {
    expect(() => parseUrbanoLookup(lookupDelivered, normalizeUrbanoNumber(UNKNOWN))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a block page as a challenge and a changed page as a schema change', () => {
    const asked = normalizeUrbanoNumber(SAMPLE);
    const blocked = '<html><head><title>Just a moment...</title></head><body></body></html>';
    expect(() => parseUrbanoLookup(blocked, asked)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseUrbanoDetail(blocked)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseUrbanoLookup('<html><head><title>Seguimiento de pieza</title></head><body></body></html>', asked))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUrbanoLookup(lookupDelivered.replace('&quot;producto&quot;', '&quot;producto&quot;:'), asked))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUrbanoDetail(detailDelivered.replace('09-05-2023', '31-02-2023'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUrbanoDetail(detailDelivered.replace('<th>Hora</th>', '<th>Time</th>'))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Urbano Argentina tracker', () => {
  it('opens the lookup page, then posts the row back for its scans', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const tracker = new UrbanoArTracker({ fetcher: fetcher({ lookup: lookupDelivered, detail: detailDelivered }, seen) });
    const result = await tracker.fetch(SAMPLE);
    expect(result.current_stage).toBe('delivered');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe('https://apis.urbano.com.ar/cespecifica/?shi_codigo=002273&cli_codigo=0000000043041054');
    expect(seen[1]!.url).toBe('https://apis.urbano.com.ar/cespecifica/class/especifica_controller.php');
    const body = new URLSearchParams(String(seen[1]!.init?.body));
    expect(body.get('accion')).toBe('getDetalle');
    expect(JSON.parse(body.get('param1')!)).toMatchObject({ shipper: '002273', cliCodigo: '0000000043041054', producto: 'PQ' });
  });

  it('asks nothing more for an unknown code', async () => {
    const seen: { url: string }[] = [];
    const tracker = new UrbanoArTracker({ fetcher: fetcher({ lookup: lookupNotFound }, seen) });
    await expect(tracker.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(seen).toHaveLength(1);
  });

  it('keeps refusals and outages apart from not found', async () => {
    await expect(new UrbanoArTracker({ fetcher: fetcher({ lookup: 'Forbidden', lookupStatus: 403 }) }).fetch(SAMPLE))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(new UrbanoArTracker({ fetcher: fetcher({ lookup: 'busy', lookupStatus: 429 }) }).fetch(SAMPLE))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(new UrbanoArTracker({ fetcher: fetcher({ lookup: 'down', lookupStatus: 503 }) }).fetch(SAMPLE))
      .rejects.toMatchObject({ kind: 'maintenance' });
    await expect(new UrbanoArTracker({ fetcher: fetcher({ lookup: lookupDelivered, detail: '' }) }).fetch(SAMPLE))
      .rejects.not.toMatchObject({ kind: 'not_found' });
  });
});
