import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BfeExpressTracker, bfeRequestBody } from './adapter.js';
import { parseBfe } from './parser.js';
import { sameInstantIdentityPolicy } from './identity.js';
import { bfeWording, statusMap } from './status.js';

const NUMBER = 'CK598000000000001';
const KEY = 'Vnj25FYu3mIjbNUS'; // gitleaks:allow
const reply = (name = 'delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const rows = (value: { supplierTrackingDetails: { trackingDetails: Record<string, unknown>[] }[] }[]) => value[0]!.supplierTrackingDetails[0]!.trackingDetails;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const refusal = (clock: string) => json({ TicketId: 'synthetic', UtcDateTime: clock, Errors: [{ Sn: null, Code: '200F1006', Message: 'Query illegal!' }] }, 400);
/** The number a request asks for, decrypted as the service does, and the clock it was signed at. */
const asked = (init: RequestInit | undefined) => {
  const { securityKey, securityValue } = JSON.parse(String(init?.body)) as { securityKey: string; securityValue: string };
  const digest = securityKey.slice(0, 32);
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(digest, 'utf8'), Buffer.from(KEY, 'utf8'));
  return { number: Buffer.concat([decipher.update(Buffer.from(securityValue, 'hex')), decipher.final()]).toString('utf8'), stamp: securityKey.slice(32) };
};

describe('BFE Express tracking', () => {
  it('signs the request as the tracking page does', () => {
    const body = bfeRequestBody(NUMBER, new Date('2026-01-07T16:19:27.484Z'));
    const digest = createHash('md5').update(`2026010716192748${KEY}`).digest('hex');
    expect(body.securityKey).toBe(`${digest}2748`);
    expect(asked({ body: JSON.stringify(body) }).number).toBe(NUMBER);
  });

  it("reads BFE's own rows without their place, and a last mile's in Spanish as written", () => {
    const result = normalizeCarrierResult(parseBfe(reply(), NUMBER.toLowerCase()));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: '2026-01-07T12:15:00-03:00', expected_delivery: null,
      delivered_at: '2026-01-07T12:15:00-03:00', destination_country: 'UY' });
    expect(result).not.toHaveProperty('provider_code');
    expect(result.events?.map(event => [event.description, event.location, event.stage])).toEqual([
      ['Entregado', undefined, 'delivered'],
      ['Reparto en curso', undefined, 'out_for_delivery'],
      ['Tu paquete se encuentra en Oficina Ejemplo', 'Oficina Ejemplo', 'in_transit'],
      ['En espera para salir a reparto en Oficina Ejemplo', 'Oficina Ejemplo', 'in_transit'],
      // The place it goes to is not where it is.
      ['Tu paquete está en viaje a Oficina Ejemplo', undefined, 'in_transit'],
      ['Tu paquete fue recibido por en: Centro Ejemplo', 'Centro Ejemplo', 'in_transit'],
      ['Turned over to last mile facility', 'Example City', 'in_transit'],
      ['Customs declaration completed', 'Example City', 'in_transit'],
      ['Transport to next facility', 'Example City', 'in_transit'],
    ]);
    expect(result.events?.at(-1)).toMatchObject({ time: '2026-01-06T13:00:00-03:00', original_description: 'Example City, Transport to next facility' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|BFEexpress|-----/);
  });

  it("keeps BFE's planned day while the parcel is on its way", () => {
    const value = reply();
    Object.assign(value[0], { orderStatus: 'InTransit', destinctCountry: 'Unknown', planDeliveryTimeDescription: '2026-01-09' });
    rows(value).splice(0, 3);
    expect(parseBfe(value, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', expected_delivery: '2026-01-09',
      last_status_text: 'En espera para salir a reparto en Oficina Ejemplo' });
    expect(parseBfe(value, NUMBER)).not.toHaveProperty('destination_country');
    for (const day of ['2026-01-06', '2026-02-30', '09/01/2026', '', null]) {
      value[0].planDeliveryTimeDescription = day;
      expect(parseBfe(value, NUMBER).expected_delivery).toBeNull();
    }
  });

  it('orders scans by their numbers, and a clock without its offset stays a wall clock', () => {
    const value = reply();
    rows(value).reverse();
    rows(value)[0]!.dateTimeString = '2026-01-06 13:00:00';
    const result = parseBfe(value, NUMBER);
    expect(result.events?.[0]).toMatchObject({ description: 'Entregado' });
    expect(result.events?.at(-1)).toMatchObject({ local_time: '2026-01-06T13:00:00' });
    expect(result.events?.at(-1)).not.toHaveProperty('time');
    // A first leg's scans come before the last mile's.
    value[0].firstLegTrackingDetails = [{ carrierCode: 'BFEexpress', carrierCodeViewOrder: 1, trackingDetails: [
      { description: 'Example City, Arrived at Airport of destination', dateTimeString: '2026-01-05 08:03:00 (GMT-03:00)', viewOrder: 1 }] }];
    expect(parseBfe(value, NUMBER).events?.at(-1)).toMatchObject({ description: 'Arrived at Airport of destination', location: 'Example City' });
  });

  it("takes BFE's delivered status over a last scan the map does not read, and the newest read scan otherwise", () => {
    const value = reply();
    rows(value)[0]!.description = 'Example new wording';
    expect(parseBfe(value, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'Delivered',
      last_status_text: 'Delivered' });
    expect(parseBfe(value, NUMBER)).not.toHaveProperty('delivered_at');
    value[0].orderStatus = 'InTransit';
    expect(parseBfe(value, NUMBER)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Reparto en curso' });
  });

  it('keeps a number BFE does not find, or lists without a scan, inconclusive', () => {
    expect(() => parseBfe(reply('not-found'), 'NOTAPARCEL')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    const listed = reply('not-found');
    Object.assign(listed[0], { orderStatus: 'InTransit', destinctCountry: 'PE',
      lastTrackingDetail: 'Your number is being transferred. Unfortunately there is no tracking at this moment. Please check back later.' });
    expect(() => parseBfe(listed, 'NOTAPARCEL')).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseBfe(reply(), 'CK598000000000002')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBfe([], NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    const changes: ((value: ReturnType<typeof reply>) => unknown)[] = [
      () => ({ items: [] }),
      value => { value[0].orderStatus = undefined; return value; },
      value => { value[0].supplierTrackingDetails = {}; return value; },
      value => { rows(value)[0]!.description = ''; return value; },
      value => { rows(value)[0]!.dateTimeString = '07/01/2026 12:15'; return value; },
      value => { rows(value)[0]!.dateTimeString = '2026-02-30 12:15:00 (GMT-03:00)'; return value; },
      value => { rows(value)[0]!.viewOrder = '9'; return value; },
      value => { value[0].orderStatus = 'NotFound'; return value; },
    ];
    for (const change of changes) expect(() => parseBfe(change(reply()), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads whole wordings, the place included, as providers relay them', () => {
    expect(statusMap.wholeWording).toBe(true);
    for (const [wording, stage] of [
      ['example city, arrived at airport of destination', 'in_transit'],
      ['arrived at airport of destination', 'in_transit'],
      ['ar, en transporte', 'in_transit'],
      ['ar, el paquete ha sido recibido.', 'in_transit'],
      ['ar, en tránsito', 'in_transit'],
      ['ar, en camino', 'in_transit'],
      ['ar, en reparto', 'out_for_delivery'],
      ['ar, reparto en curso', 'out_for_delivery'],
      ['ar, no entregado', 'failed_attempt'],
      ['ar, local comercial cerrado', 'failed_attempt'],
      ['abc01, entregado', 'delivered'],
      ['tu paquete está en viaje a oficina ejemplo', 'in_transit'],
      ['reparto en curso', 'out_for_delivery'],
      ['entregado', 'delivered'],
      ['tu paquete está en viaje a', undefined],
      ['example city, arrived at airport', undefined],
    ] as const) expect(statusMap.stage(null, wording), wording).toBe(stage);
    // BFE's Spanish rows in Argentina start with the country, which becomes the location.
    expect(bfeWording('AR, En tránsito')).toEqual({ description: 'En tránsito', location: 'AR', original_description: 'AR, En tránsito' });
    expect(bfeWording('AR, Reparto en curso')).toEqual({ description: 'Reparto en curso', location: 'AR', original_description: 'AR, Reparto en curso' });
    // The delivery names the place of the round before it first, by its code.
    expect(bfeWording('ABC01, Entregado')).toEqual({ description: 'Entregado', location: 'ABC01', original_description: 'ABC01, Entregado' });
  });

  it('lets a row stored whole, its place at its head, keep its row once the map reads its wording', () => {
    const scan = (description: string, location = '') => ({ stage: 'in_transit', description, location, providerCode: '' });
    const { matches } = sameInstantIdentityPolicy;
    expect(matches!(scan('En camino', 'AR'), scan('AR, En camino'))).toBe(true);
    expect(matches!(scan('En camino', 'AR'), scan('UY, En camino'))).toBe(false);
    expect(matches!(scan('En tránsito', 'AR'), scan('AR, En camino'))).toBe(false);
    expect(matches!(scan('En camino', 'AR'), scan('AR, En camino', 'AR'))).toBe(false);
  });

  it('posts the signed number and signs again once on the service clock when ours is off', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(reply()));
    const now = () => Date.parse('2026-01-07T16:19:27.484Z');
    const result = await new BfeExpressTracker({ fetcher, now }).fetch(`${NUMBER.slice(0, 5)} ${NUMBER.slice(5)}`);
    expect(result.status).toBe('delivered');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://us-ec-gateway.bfeexpress.com/api/v1/trackings?lang=en-US');
    expect(init).toMatchObject({ method: 'POST', headers: expect.objectContaining({ Origin: 'https://www.bfeexpress.com' }) });
    expect(asked(init)).toEqual({ number: NUMBER, stamp: '2748' });

    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(refusal('2026-01-07T16:25:01.2345678Z')).mockResolvedValueOnce(json(reply()));
    await expect(new BfeExpressTracker({ fetcher, now }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(asked(fetcher.mock.calls[1]![1]).stamp).toBe('0123');

    // A refusal on a clock that agrees with ours is not about the clock.
    fetcher.mockReset();
    fetcher.mockResolvedValue(refusal('2026-01-07T16:19:30.0000000Z'));
    await expect(new BfeExpressTracker({ fetcher, now }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockReset();
    fetcher.mockResolvedValue(new Response('<html></html>', { status: 200 }));
    await expect(new BfeExpressTracker({ fetcher, now }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks nothing for a number BFE does not take, and recognizes by a lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(reply('not-found')));
    await expect(new BfeExpressTracker({ fetcher }).fetch('CK5')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    expect(instance.steps).toEqual(['direct']);
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(metadata.tracking.steps).toEqual(instance.steps);
    await expect(instance.track({ number: 'NOTAPARCEL' }, {})).rejects.toMatchObject({ reason: 'portal_not_found' });
  });

  it('is asked in preflight about its CK numbers, alone in its own countries', () => {
    // Colis Privé's rule fits some of them too; it is asked only where it delivers, or with no country known.
    const shared = 'CK512604827391546';
    for (const countryHint of ['PE', 'AR', 'UY']) {
      expect(recognitionAskedCarriers(shared, { countryHint }), countryHint).toEqual(['bfe-express']);
    }
    expect(recognitionAskedCarriers(shared)).toEqual(['colis-prive', 'bfe-express']);
    expect(recognitionAskedCarriers(NUMBER, { countryHint: 'PE' })).toEqual(['bfe-express']);
  });
});
