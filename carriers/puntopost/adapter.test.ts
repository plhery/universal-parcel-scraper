import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adapter } from './adapter.js';
import { normalizePuntopostNumber, parsePuntopost } from './parser.js';
import { puntopostStage, puntopostWording, statusMap } from './status.js';

const LABEL = 'MXL0000016G39';
const TRACKING = 'MXT00930J290H';
const UNKNOWN = 'MXZZZZZZZZZZZZ';
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const reply = (body: unknown, status = 200, type = 'application/json') => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
const factory = (fetcher: typeof fetch) => adapter({ fetcher, env: {}, trawl: null, browserExecutablePath: null } as never);
interface Detail { status: string; status_history: { status: string; when: string }[]; movements: unknown }
const edited = (edit: (detail: Detail) => void) => {
  const body = fixture('delivered');
  edit(body.detail as Detail);
  return body;
};

describe('PuntoPost tracking service', () => {
  it('reads the delivered sample as its page shows it, newest first, with offsets', () => {
    const result = parsePuntopost(fixture('delivered'), LABEL);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', provider_code: 'delivered', last_status_text: 'Entregado',
      last_update: '2025-12-03T13:14:17-06:00', delivered_at: '2025-12-03T13:14:17-06:00', expected_delivery: null,
      sender_name: 'Almacén Cannaland', canonical_tracking_number: TRACKING,
      pickup_point: 'Super Valle de Chalco\nCalle Nte 36, Colonia del Carmen, Valle de Chalco Solidaridad, Méx., México',
    });
    expect(result.events!.map(({ time, description, provider_code, location, stage }) => [time, description, provider_code, location, stage])).toEqual([
      ['2025-12-03T13:14:17-06:00', 'Entregado', 'delivered', 'Valle de Chalco Solidaridad', 'delivered'],
      ['2025-12-03T11:49:32-06:00', 'En PuntoPost destino Super Valle de Chalco', 'in_destination_point', 'Valle de Chalco Solidaridad', 'ready_for_pickup'],
      ['2025-12-03T08:23:50-06:00', 'En camino a PuntoPost destino Super Valle de Chalco', 'in_transit_destination', 'Azcapotzalco', 'in_transit'],
      ['2025-12-02T21:42:38-06:00', 'En Almacén CDMX', 'in_depot', 'Azcapotzalco', 'in_transit'],
      ['2025-12-02T13:53:24-06:00', 'En camino a Almacén CDMX', 'in_transit_depot', 'Coyoacán', 'in_transit'],
      ['2025-12-01T16:59:14-06:00', 'En Almacén Cannaland', 'in_origin_point', 'Coyoacán', 'accepted'],
      ['2025-11-29T09:33:18-06:00', 'Guía generada', 'created', undefined, 'registered'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads the parcel by its own code too, and only the parcel asked', () => {
    const own = parsePuntopost(fixture('delivered'), TRACKING);
    expect(own).not.toHaveProperty('canonical_tracking_number');
    expect(own.events).toHaveLength(7);
    expect(() => parsePuntopost(fixture('delivered'), 'MXL0000016G40')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the status words without movements, and the point while waiting there', () => {
    const waiting = parsePuntopost(edited(detail => {
      detail.status = 'in_destination_point';
      detail.status_history = detail.status_history.slice(0, 6);
      detail.movements = [];
    }), LABEL);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Disponible en punto de entrega', pickup_point: expect.stringMatching(/^Super Valle de Chalco\n/) });
    expect(waiting).not.toHaveProperty('delivered_at');
    expect(waiting.events!.map(event => event.description)).toEqual(['Disponible en punto de entrega', 'En ruta hacia el punto de entrega',
      'En almacén', 'En camino al almacén', 'Tu envío se ha puesto en marcha', 'Guía generada']);
    const early = parsePuntopost(edited(detail => { detail.status = 'in_depot'; }), LABEL);
    expect(early).not.toHaveProperty('pickup_point');
  });

  it('stops at a failed return as the page does, and keeps an unknown code without a stage', () => {
    const failed = parsePuntopost(edited(detail => {
      detail.status = 'return_fail_lost';
      detail.status_history.push({ status: 'return_fail_in_origin_point', when: '2025-12-20T10:00:00-06:00' },
        { status: 'return_fail_lost', when: '2025-12-21T10:00:00-06:00' });
    }), LABEL);
    expect(failed).toMatchObject({ current_stage: 'returned', last_status_text: 'Devolución al remitente',
      last_update: '2025-12-20T10:00:00-06:00' });
    const unknown = parsePuntopost(edited(detail => {
      detail.status = 'held_at_customs';
      detail.status_history.push({ status: 'held_at_customs', when: '2025-12-04T10:00:00-06:00' });
    }), LABEL);
    expect(unknown.status).toBe('unknown');
    expect(unknown).not.toHaveProperty('current_stage');
    expect(unknown.events![0]).toEqual({ time: '2025-12-04T10:00:00-06:00', description: 'held_at_customs', provider_code: 'held_at_customs' });
  });

  it('refuses changed replies and reads the service’s absence as not found', () => {
    expect(() => parsePuntopost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const body of [
      edited(detail => { detail.status = ''; }),
      edited(detail => { detail.status_history[0]!.when = '2025-11-29 09:33:18'; }),
      edited(detail => { detail.movements = {}; }),
      { detail: null }, [],
    ]) expect(() => parsePuntopost(body, LABEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes one MX number in capitals and maps every code the page words', () => {
    expect(normalizePuntopostNumber(' mxl0000016g39 ')).toBe(LABEL);
    for (const value of ['0000016G39', 'MX12', `${LABEL},${TRACKING}`, 'MX0000016G39/..']) {
      expect(() => normalizePuntopostNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(puntopostStage('return_in_depot')).toBe('returned');
    expect(puntopostStage('lost')).toBe('exception');
    expect(puntopostWording('return_fail_in_origin_point')).toBe('Devolución al remitente');
    expect(statusMap.stage('delivered', 'entregado')).toBe('delivered');
    expect(statusMap.stage(null, 'entregado')).toBeUndefined();
  });

  it('asks one bound URL and keeps refusals, moved routes and absences apart', async () => {
    const urls: string[] = [];
    const found = factory(async input => { urls.push(String(input)); return reply(fixture('delivered'))(); });
    await expect(found.track({ number: LABEL })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(urls).toEqual([`https://back.puntopost.mx/api/web/v1/parcels/${LABEL}`]);
    await expect(factory(reply(fixture('not-found'), 404)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(factory(reply('Not Found', 404, 'text/html')).track({ number: UNKNOWN })).rejects.not.toMatchObject({ kind: 'not_found' });
    await expect(factory(reply('<title>Just a moment...</title>', 403, 'text/html')).track({ number: LABEL })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(factory(reply('<title>Just a moment...</title>', 200, 'text/html')).track({ number: LABEL })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(factory(reply({ type: 'VALIDATION' }, 400)).track({ number: LABEL })).rejects.not.toMatchObject({ kind: 'not_found' });
  });
});
