import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const bill = fixture('bill');
const missing = fixture('missing');
const number = numbers.records[0]!.number;
const unprefixed = number.slice(4);
const unknown = 'ZZZZZZ00000X';

it('tracks an exact house bill and preserves the carrier’s date and sequence', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bill));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://vip.translinkshipping.com/AjaxCT/CargoTracking.cspx?HBLNO=${unprefixed}`, expect.anything());
  expect(result).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Unloaded From Vessel',
    last_update_local: '2026-11-18',
  });
  expect(result.events).toHaveLength(9);
  expect(result.events?.[0]).toMatchObject({ local_time: '2026-11-18', location: 'Long Beach, CA', stage: 'in_transit' });
  expect(result.events?.[1]?.description).toBe('Carrier and Customs Released');
  expect(result.events?.[8]).toMatchObject({ local_time: '2026-10-17', location: 'Yantian, GD' });
  expect(result.events?.every(event => event.time === undefined)).toBe(true);
});

it('requires the whole bill and its own container panel', () => {
  expect(() => parseTracking(missing, unknown)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(missing, unprefixed)).toThrow(expect.objectContaining({ kind: 'schema' }));
  expect(() => parseTracking(bill, unknown)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(bill.replace('id="cnts_CSNU8939628"', 'id="cnts_ABCU0000000"'), unprefixed))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('leaves the carrier’s blue estimates out of confirmed scans', () => {
  const scheduled = bill.replace('Unloaded From Vessel', '<span style="color: Blue">Unloaded From Vessel</span>');
  const result = parseTracking(scheduled, unprefixed);
  expect(result.events).toHaveLength(8);
  expect(result.last_status_text).toBe('Carrier and Customs Released');
});

it('keeps a transshipment gate-out in transit and stages the final delivery dispatch', () => {
  const result = parseTracking(fixture('transshipment'), numbers.records[1]!.number.slice(4));
  expect(result).toMatchObject({
    status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update_local: '2026-11-05',
  });
  expect(result.events).toHaveLength(27);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[1]).toMatchObject({
    description: 'Picked up at Final Destination for Delivery', location: 'Edmonton, AB', stage: 'out_for_delivery',
  });
  expect(result.events?.find(event => event.description === 'Out Gate to Consignee'))
    .toMatchObject({ location: 'Hong Kong', stage: 'in_transit' });
});
