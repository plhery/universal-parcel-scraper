import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { carrierTrackingNumber, formatTrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TIUI_GUIDE, TiuiTracker, tiuiGuideUrl } from './adapter.js';
import { parseTiui, tiuiFolio } from './parser.js';
import { tiuiStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// The public sample, whose reply the delivered fixture keeps.
const DELIVERED = numbers.records[0]!.number;
const UNKNOWN = '99-99-9999';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const delivered = () => JSON.parse(fixture('delivered')) as Record<string, unknown> & { Movimientos: Record<string, unknown>[] };
const reply = (body: unknown = delivered(), code = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Tiui tracking adapter', () => {
  it("reads a delivered folio's movements, newest first, at the instants Tiui wrote them", () => {
    const result = normalizeCarrierResult(parseTiui(delivered(), DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: '2023-06-25T01:57:27.640Z', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.stage])).toEqual([
      ['2023-06-25T01:57:27.640Z', '13', 'Entregado', 'delivered'],
      ['2023-06-24T20:28:47.272Z', '9', 'Tu envío está en ruta de entrega', 'out_for_delivery'],
      ['2023-06-24T19:59:59.378Z', '20', 'Estamos preparando la ruta', 'in_transit'],
      ['2023-06-24T09:56:32.601Z', '21', 'No alcanzamos a visitar tu domicilio.', 'in_transit'],
      ['2023-06-24T09:56:24.659Z', '9', 'Tu envío está en ruta de entrega', 'out_for_delivery'],
      ['2023-06-24T09:56:13.507Z', '20', 'Estamos preparando la ruta', 'in_transit'],
      ['2023-06-24T09:56:05.765Z', '19', 'Tu envío está en CEDIS Tiui CDMX recolección', 'in_transit'],
      ['2023-06-24T09:55:56.565Z', '18', 'Envío recolectado', 'accepted'],
      ['2023-06-23T20:50:33.028Z', '17', 'En camino a recolección', 'registered'],
      ['2023-06-22T04:38:10.074Z', '16', 'Envío documentado recolección', 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time === undefined && event.location === undefined)).toBe(true);
    // The sender, recipient, merchant, product and delivery photos stay out.
    expect(JSON.stringify(result)).not.toMatch(/Prueba|example|Calle|5500000000|Evidencia|Producto/i);
  });

  it('asks the guide service for the folio with its hyphens, as typed with spaces or not', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    await expect(carrier(fetcher).track({ number: ` ${DELIVERED.replaceAll('-', ' - ')} ` })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${TIUI_GUIDE}${DELIVERED}`]);
    expect(tiuiGuideUrl(UNKNOWN)).toBe('https://tiuiamigo.tiui.mx/api/guia/99-99-9999');
  });

  it('keeps the hyphens of a Tiui folio alone, so numbers of the same shape elsewhere normalize as before', () => {
    expect(carrierTrackingNumber(' 12-345-6789 ', 'tiui')).toBe('12-345-6789');
    expect(directTrackingNumber('tiui', '12 - 345 - 6789')).toBe('12-345-6789');
    expect(formatTrackingNumber('12-345-6789', 'tiui')).toBe('12-345-6789');
    // Seino's 3-3-4 and Flip Post's 2-3-3 shapes, and Tiui's own when no carrier is named.
    for (const [number, chosen] of [['123-456-7890', 'seino'], ['12-345-678', 'flippost'], ['12-345-6789', undefined]] as const) {
      expect(carrierTrackingNumber(number, chosen)).toBe(normalizeTrackingNumber(number));
      expect(formatTrackingNumber(number, chosen)).toBe(normalizeTrackingNumber(number));
    }
    // A Tiui number that is not a folio normalizes too.
    expect(carrierTrackingNumber('1234567890', 'tiui')).toBe('1234567890');
    expect(directTrackingNumber('tiui', 'ab-12')).toBe('AB12');
  });

  it('keeps a movement neither map knows without a stage, and a wording the shared rules know with theirs', () => {
    const body = delivered();
    body.Movimientos = [{ ...body.Movimientos[0], EstatusNuevo: 99, estatusnuevoname: 'Revisión de dirección' }];
    const result = parseTiui(body, DELIVERED);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Revisión de dirección' });
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events![0]).toMatchObject({ provider_code: '99' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(tiuiStage('98', 'Entregado')).toMatchObject({ stage: 'delivered' });
  });

  it('answers not found only for the service\'s own notice, and a folio without movements as listed', async () => {
    await expect(carrier(vi.fn<typeof fetch>(async () => reply(fixture('not-found'), 404))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(new TiuiTracker({ fetcher: vi.fn<typeof fetch>(async () => reply('<html>Not Found</html>', 404)) }).fetch(UNKNOWN))
      .rejects.toMatchObject({ kind: 'transport' });
    const listed = { ...delivered(), Movimientos: [] };
    expect(() => parseTiui(listed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('rejects a reply for another folio as inconclusive', () => {
    expect(() => parseTiui({ ...delivered(), Folio: UNKNOWN }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('fails on a reply without its folio, movements or a movement\'s time, code and wording instead of guessing', () => {
    const withoutFolio = delivered();
    delete withoutFolio.Folio;
    expect(() => parseTiui(withoutFolio, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTiui({ ...delivered(), Movimientos: null }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [{ FechaRegistro: '2023-06-25' }, { EstatusNuevo: '13' }, { estatusnuevoname: ' ' }]) {
      const body = delivered();
      body.Movimientos[0] = { ...body.Movimientos[0], ...change };
      expect(() => parseTiui(body, DELIVERED), JSON.stringify(change)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTiui([], DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a browser check, a rate limit or a refusal apart from a missing folio', async () => {
    const tracker = (response: Response) => new TiuiTracker({ fetcher: vi.fn<typeof fetch>(async () => response) });
    await expect(tracker(reply('<html>Just a moment...</html>', 403, { 'cf-mitigated': 'challenge' })).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker(reply('denied', 403)).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'transport' });
    await expect(tracker(reply('slow down', 429)).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new UpstreamNetworkError('Tiui', 'socket hang up'))
      .mockResolvedValueOnce(reply());
    await expect(new TiuiTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects anything but a folio with its hyphens without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const typed of [DELIVERED.replaceAll('-', ''), '12-345', '12345-123-1', '1-2-1234567', 'AB-12-3456', `${DELIVERED},${UNKNOWN}`, '']) {
      expect(() => tiuiFolio(typed), typed).toThrow(InvalidInputError);
      await expect(carrier(fetcher).track({ number: typed })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded code to its stage', () => {
    for (const entry of statuses.entries) {
      expect(tiuiStage(entry.code, entry.wording)?.stage, entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'tiui', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'tiui', providerCode: null, description: 'Entregado' })).toEqual({ kind: 'unknown' });
  });
});
