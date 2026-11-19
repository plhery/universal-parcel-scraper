import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseRapex } from './parser.js';

const load = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

it('reads the public shipment card, preserving its scan clocks and warehouses', () => {
  const result = parseRapex(load('delivered'), '090079192043');
  expect(result.events).toHaveLength(8);
  expect(result.events?.[0]).toMatchObject({ description: 'Entregue', local_time: '2024-07-30T15:40:00', location: 'SEIXAL', stage: 'delivered' });
  expect(result.events?.[1]?.stage).toBe('out_for_delivery');
  expect(result.expected_delivery).toBeNull();
});

it('requires a whole number on both the result card and the no-match notice', () => {
  expect(() => parseRapex(load('unknown'), '000000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  for (const name of ['unknown', 'delivered']) {
    expect(() => parseRapex(load(name), '999999999999')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  }
});

it('reads a state its map lacks by the shared wording rules', () => {
  // Synthetic: the sample's newest state reworded.
  const result = parseRapex(load('delivered').replace('#48AD01">Entregue</span>', '#48AD01">Devolvido ao remetente</span>'), '090079192043');
  expect(result.events?.[0]).toMatchObject({ stage: 'returned', stage_source: 'wording:language' });
});
