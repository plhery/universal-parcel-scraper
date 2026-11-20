import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { cargoRows, parseTracking } from './parser.js';

const bill = 'GB2582814';
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('binds both cargo responses to the bill and keeps actual port movements', () => {
  const result = parseTracking(cargoRows(fixture('found'), bill), bill, fixture('transport'));
  expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'DISCHARGED', last_update_local: '2026-11-07T17:09:32' });
  expect(result.events).toEqual([
    { description: 'DISCHARGED', local_time: '2026-11-07T17:09:32', location: 'BALTIMORE, MD', stage: 'in_transit', stage_source: 'carrier_map' },
    { description: 'DEPARTED', local_time: '2026-10-27T20:08:00', location: 'SOUTHAMPTON', stage: 'in_transit', stage_source: 'carrier_map' },
  ]);
  expect(result).not.toHaveProperty('expected_delivery');
});

it('handles the native empty result and refuses cargo for a different bill', () => {
  expect(() => cargoRows(fixture('missing'), bill)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => cargoRows(fixture('found'), 'ZZ0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(cargoRows(fixture('found'), bill), bill, fixture('transport').replace(bill, 'ZZ0000000')))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
