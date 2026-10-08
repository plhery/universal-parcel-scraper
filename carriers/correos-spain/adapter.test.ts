import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndeterminateError, NotFoundError, SchemaError, InvalidInputError } from '../../core/errors/index.js';
import {
  normalizeCorreosSpainTrackingNumber,
  correosSpainTrackingUrl,
  parseCorreosSpainExpeditionResponse,
  parseCorreosSpainTrackingResponse,
  CorreosSpainTracker,
} from './adapter.js';
import { classifyCorreosSpainStatus } from './status.js';

// All identifiers and timestamps below are synthetic. Event codes and Spanish
// wordings reuse the vendor's fixed texts confirmed against a real parcel by
// the prior-art client, so classification exercises production prose rather
// than paraphrases.
const TRACKING_NUMBER = 'PR123456789012345C';
// An expedition code and the parcel code it stands for: the same fifteen
// characters, then the parcel's seven further digits and its own check letter.
const EXPEDITION = 'PL00ZZ000000001Z';
const PARCEL = 'PL00ZZ0000000010100000Y';
const DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function event(code: string, fecha: string, horEvento: string, resumen: string) {
  return { codEvento: code, fecEvento: fecha, horEvento, desTextoResumen: resumen, desTextoAmpliado: resumen };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(DELIVERED), ...overrides };
}

function response(value: unknown, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Correos Spain tracking normalization', () => {
  it('accepts Correos-issued codes case-insensitively and rejects the rest', () => {
    expect(normalizeCorreosSpainTrackingNumber('pr123456789012345c')).toBe(TRACKING_NUMBER);
    expect(normalizeCorreosSpainTrackingNumber('PQ0011223344ES')).toBe('PQ0011223344ES');
    for (const raw of ['ABC', '123', '']) {
      expect(() => normalizeCorreosSpainTrackingNumber(raw)).toThrow(InvalidInputError);
    }
    expect(correosSpainTrackingUrl(TRACKING_NUMBER)).toBe(
      'https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=PR123456789012345C',
    );
  });
});

describe('Correos Spain response parsing', () => {
  it('accepts numeric result codes and rejects structured or boolean codes', () => {
    expect(parseCorreosSpainTrackingResponse([envelope({ error: { codError: 0 } })], TRACKING_NUMBER).status).toBe('delivered');
    for (const codError of [[0], { value: 0 }, false, Infinity]) {
      expect(() => parseCorreosSpainTrackingResponse([envelope({ error: { codError } })], TRACKING_NUMBER)).toThrow(SchemaError);
    }
  });

  it('returns delivered history newest-first with Madrid timestamps', () => {
    const result = parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Entregado',
      last_update: '2026-04-29T13:12:42+02:00',
      expected_delivery: null,
    });
    expect(result.events?.map((item) => [item.description, item.stage, item.time])).toEqual([
      ['Entregado', 'delivered', '2026-04-29T13:12:42+02:00'],
      ['En reparto', 'out_for_delivery', '2026-04-29T08:46:00+02:00'],
      ['Clasificado', 'in_transit', '2026-04-28T15:52:17+02:00'],
      ['Admitido', 'accepted', '2026-04-27T23:03:58+02:00'],
    ]);
  });

  it('maps documented event codes and reports unmapped ones as unknown', () => {
    const cases: Array<[string, string, string]> = [
      ['A090000V', 'pending', 'registered'],
      ['A010000V', 'in_transit', 'accepted'],
      ['P101110V', 'in_transit', 'in_transit'],
      ['H01I350V', 'out_for_delivery', 'ready_for_pickup'],
      ['G01L020V', 'out_for_delivery', 'ready_for_pickup'],
      ['H010930R', 'exception', 'failed_attempt'],
      ['O140000V', 'exception', 'returned'],
      ['X120000V', 'delivered', 'delivered'],
      ['C010000V', 'in_transit', 'in_transit'],
      ['H250000V', 'out_for_delivery', 'out_for_delivery'],
      ['ADV0000V', 'in_transit', 'accepted'],
      ['H01R390V', 'exception', 'failed_attempt'],
      ['H01R420V', 'exception', 'failed_attempt'],
      ['L03D320R', 'exception', 'returned'],
      ['A170000V', 'pending', 'registered'],
      ['E000001V', 'in_transit', 'customs'],
      ['I020000V', 'exception', 'returned'],
      ['I01H230V', 'exception', 'returned'],
      ['L03D240R', 'exception', 'returned'],
    ];
    for (const [code, status, stage] of cases) {
      expect(classifyCorreosSpainStatus(code)).toEqual({ status, stage });
      const result = parseCorreosSpainTrackingResponse([envelope({
        eventos: [event(code, '29/04/2026', '13:12:42', 'Resumen')],
      })], TRACKING_NUMBER);
      expect(result).toMatchObject({ status, current_stage: stage });
    }
    expect(classifyCorreosSpainStatus('Z999999Z')).toBeUndefined();
    const unknown = parseCorreosSpainTrackingResponse([envelope({
      eventos: [event('Z999999Z', '29/04/2026', '13:12:42', 'Algo nuevo')],
    })], TRACKING_NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Algo nuevo' });
    // No explicit mapping means no stage at all: the sync classifies the raw
    // wording and records where the final stage came from.
    expect(unknown.events?.[0]).toMatchObject({ description: 'Algo nuevo' });
    expect(unknown.events?.[0]?.stage).toBeUndefined();
  });

  it('binds the envelope codEnvio and honors the codError result', () => {
    expect(() => parseCorreosSpainTrackingResponse([envelope({ codEnvio: 'PR123456789012346C' })], TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseCorreosSpainTrackingResponse([envelope({ codEnvio: undefined })], TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseCorreosSpainTrackingResponse([envelope({ error: { codError: '3', desError: 'Sin Trazabilidad en Minerva.' }, eventos: null })], TRACKING_NUMBER))
      .toThrow(NotFoundError);
    expect(() => parseCorreosSpainTrackingResponse([], TRACKING_NUMBER)).toThrow(SchemaError);
    expect(() => parseCorreosSpainTrackingResponse([envelope({ error: undefined })], TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseCorreosSpainTrackingResponse(null, TRACKING_NUMBER)).toThrow(SchemaError);
  });

  it('names the single parcel of an expedition and leaves several inconclusive', () => {
    const shipment = (shipmentCode: string, expeditionCode = EXPEDITION) => ({ shipmentCode, expeditionCode, events: [] });
    expect(parseCorreosSpainExpeditionResponse({ type: 'expeditions', shipment: [shipment(PARCEL)] }, EXPEDITION)).toBe(PARCEL);
    expect(parseCorreosSpainExpeditionResponse({ shipment: [shipment('pl00zz 0000000010100000y'), shipment(PARCEL)] }, EXPEDITION)).toBe(PARCEL);
    expect(() => parseCorreosSpainExpeditionResponse({ shipment: [shipment(PARCEL), shipment('PL00ZZ0000000020100000F')] }, EXPEDITION))
      .toThrow(IndeterminateError);
    // Another expedition's parcel, an empty list and a missing code are no answer about this one.
    for (const payload of [{ shipment: [shipment(PARCEL, 'PL00ZZ000000002S')] }, { shipment: [] }, { shipment: [shipment('')] },
      { shipment: [null] }, { shipment: 'none' }, {}, null]) {
      expect(() => parseCorreosSpainExpeditionResponse(payload, EXPEDITION)).toThrow(SchemaError);
    }
  });

  it('binds a parcel found through its expedition to that expedition', () => {
    const parcel = (codExpedicion: unknown) => [envelope({ codEnvio: PARCEL, codExpedicion })];
    expect(parseCorreosSpainTrackingResponse(parcel(EXPEDITION), PARCEL, EXPEDITION).status).toBe('delivered');
    for (const other of ['PL00ZZ000000002S', null, undefined]) {
      expect(() => parseCorreosSpainTrackingResponse(parcel(other), PARCEL, EXPEDITION)).toThrow(SchemaError);
    }
    // A parcel asked for by its own code needs no expedition.
    expect(parseCorreosSpainTrackingResponse(parcel(null), PARCEL).status).toBe('delivered');
  });

  it('keeps codError-0 parcels without events as unknown with the envelope summary', () => {
    const result = parseCorreosSpainTrackingResponse([envelope({
      eventos: [], resumen_ultimo: 'En camino',
    })], TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'En camino', events: [] });
  });

  it('skips unusable rows without losing the shipment', () => {
    const result = parseCorreosSpainTrackingResponse([envelope({
      eventos: [
        event('I01H210V', '29/04/2026', '13:12:42', 'Entregado'),
        event('I01H210V', '29/04/2026', '13:12:42', 'Entregado'),
        event('I01H210V', 'not-a-date', '13:12:42', 'Entregado'),
        event('I01H210V', '29/04/2026', '13:12:42', ''),
        'not a record',
      ],
    })], TRACKING_NUMBER);
    // Empty wording falls back to the code, so two rows survive the sparse input.
    expect(result.events?.map((item) => item.description)).toEqual(['Entregado', 'I01H210V']);
  });

  it('retains weight and parcel data, never the customer name or raw keys', () => {
    const result = parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER);
    expect(result.receiver_name).toBeUndefined();
    expect(result).toMatchObject({
      weight_kg: 1.5,
      dimensions_text: '30 x 20 x 10 cm',
      delivered_at: '2026-04-29T13:12:42+02:00',
    });
    const serialized = JSON.stringify(result);
    for (const secret of ['nombre_cliente', 'Example Customer', 'nom_codired', 'peso', 'largo', 'ancho', 'alto']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('reads sides given in metres as centimetres', () => {
    const metres = parseCorreosSpainTrackingResponse([envelope({ largo: '0.3', ancho: '0.2', alto: '0.045' })], TRACKING_NUMBER);
    expect(metres.dimensions_text).toBe('30 x 20 x 4.5 cm');
    const thin = parseCorreosSpainTrackingResponse([envelope({ largo: '2', ancho: '30', alto: '0.5' })], TRACKING_NUMBER);
    expect(thin.dimensions_text).toBe('2 x 30 x 0.5 cm');
  });

  it('never retains the customer address, phone or signature blocks', () => {
    const serialized = JSON.stringify(parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER));
    for (const secret of [
      'Calle Ejemplo 1', '+340000000000', 'Example Signature',
      'direccion_cliente', 'telefono_cliente', 'firma_receptor', 'desTextoAmpliado',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('exposes the office name only while awaiting collection', () => {
    const pickup = parseCorreosSpainTrackingResponse([envelope({
      nom_codired: 'MADRID SUC 37. LA ELIPA',
      eventos: [event('H01I350V', '29/04/2026', '13:12:42', 'En oficina')],
    })], TRACKING_NUMBER);
    expect(pickup).toMatchObject({ pickup_point: 'MADRID SUC 37. LA ELIPA' });
    const held = parseCorreosSpainTrackingResponse([envelope({
      nom_codired: 'MADRID SUC 37. LA ELIPA',
      eventos: [event('G01L020V', '29/04/2026', '13:12:42', 'A disposición del destinatario')],
    })], TRACKING_NUMBER);
    expect(held).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'MADRID SUC 37. LA ELIPA' });
    const delivered = parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER);
    expect(delivered.pickup_point).toBeUndefined();
  });

  it('produces every capability carrier.json declares', () => {
    expect(CAPABILITIES).toEqual(['history', 'pickup_point', 'weight', 'dimensions', 'delivered_at']);
    const delivered = parseCorreosSpainTrackingResponse([envelope()], TRACKING_NUMBER);
    expect(delivered.events?.length).toBeGreaterThan(0);
    expect(delivered.weight_kg).toBe(1.5);
    expect(delivered.dimensions_text).toBe('30 x 20 x 10 cm');
    expect(delivered.delivered_at).toBe('2026-04-29T13:12:42+02:00');
    // The office is only a pickup signal while the parcel awaits collection.
    const pickup = parseCorreosSpainTrackingResponse([envelope({
      eventos: [event('H01I350V', '29/04/2026', '13:12:42', 'En oficina')],
    })], TRACKING_NUMBER);
    expect(pickup.pickup_point).toBe('OFICINA EXAMPLE CENTRAL');
  });
});

describe('CorreosSpainTracker fetch', () => {
  it('calls the localizador endpoint with web-channel params', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(String(input));
      return response([envelope()]);
    });
    const result = await new CorreosSpainTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER);
    expect(result.status).toBe('delivered');
    expect(seen).toEqual([
      'https://localizador.correos.es/canonico/eventos_envio_servicio/PR123456789012345C?codAplicacion=60&codCanal=3&codIdioma=ES&indUltEvento=N',
    ]);
  });

  it('resolves an expedition code through the public search, then tracks its parcel', async () => {
    const seen: string[] = [];
    const search = 'https://api1.correos.es/digital-services/searchengines/api/v1/envios?text=PL00ZZ000000001Z&language=ES';
    const localizador = (code: string) => `https://localizador.correos.es/canonico/eventos_envio_servicio/${code}?codAplicacion=60&codCanal=3&codIdioma=ES&indUltEvento=N`;
    let found: Response = response({ type: 'expeditions', shipment: [{ shipmentCode: PARCEL, expeditionCode: EXPEDITION }] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(String(input));
      return String(input) === search ? found.clone() : response([envelope({ codEnvio: PARCEL, codExpedicion: EXPEDITION })]);
    });
    const tracker = new CorreosSpainTracker({ timeoutMs: 1_000 });
    expect((await tracker.fetch('pl00zz000000001z')).status).toBe('delivered');
    expect(seen).toEqual([search, localizador(PARCEL)]);
    // The search answers 204 for a code it does not know; the localizador is not asked.
    seen.length = 0;
    found = new Response(null, { status: 204 });
    await expect(tracker.fetch(EXPEDITION)).rejects.toThrow(NotFoundError);
    expect(seen).toEqual([search]);
    found = response({}, 503);
    await expect(tracker.fetch(EXPEDITION)).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    // A code the search returns as its own parcel is tracked without an expedition binding.
    seen.length = 0;
    found = response({ type: 'envio', shipment: [{ shipmentCode: EXPEDITION, expeditionCode: EXPEDITION }] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(String(input));
      return String(input) === search ? found.clone() : response([envelope({ codEnvio: EXPEDITION, codExpedicion: null })]);
    });
    expect((await tracker.fetch(EXPEDITION)).status).toBe('delivered');
    expect(seen).toEqual([search, localizador(EXPEDITION)]);
  });

  it('surfaces transport and schema failures distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 503));
    await expect(new CorreosSpainTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('not json', 200));
    await expect(new CorreosSpainTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toThrow(TypeError);
    expect(() => new CorreosSpainTracker({ timeoutMs: 0 })).toThrow(TypeError);
    await expect(new CorreosSpainTracker({ timeoutMs: 1_000 }).fetch('ABC'))
      .rejects.toThrow(InvalidInputError);
  });
});
