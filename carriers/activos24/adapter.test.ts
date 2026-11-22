import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { courierPortalTrackingUrl } from '../logisimple/portal.js';
import { activos24, parseActivos24 } from './parser.js';

const load = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

it('reads the public shipment card, with its scan clocks and without the proof of delivery', () => {
  const result = parseActivos24(load('delivered'), '035065897641');
  expect(result.events).toHaveLength(7);
  expect(result.events?.[0]).toMatchObject({ description: 'Entregue', local_time: '2026-06-01T11:02:00', stage: 'delivered' });
  expect(result.events?.map((event) => event.stage)).toEqual(
    ['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'registered', 'registered']);
  expect(result).toMatchObject({ status: 'delivered', last_update_local: '2026-06-01T11:02:00', expected_delivery: null });
  expect(JSON.stringify(result)).not.toMatch(/Recebido/);
});

it('reads a no-match notice as not found only when its form echoes the whole number', () => {
  expect(() => parseActivos24(load('unknown'), '001023900321')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  for (const name of ['unknown', 'delivered']) {
    expect(() => parseActivos24(load(name), '999999999999')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  }
});

it('asks the older portal version’s tracking page', () => {
  expect(courierPortalTrackingUrl(activos24, '035065897641')).toBe('https://activos24.com/pt/seguir-encomenda?tracking=035065897641');
});
