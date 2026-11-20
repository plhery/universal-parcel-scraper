import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseMovements, parseShipment } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const lookup = fixture('shipment');
const history = fixture('movements');
const empty = fixture('missing');
const number = numbers.records[0]!.number;
const shipment = `SA-${number.slice(6)}`;
const container = 'GCNU1441066';

it('looks up a published SA bill and binds both identifiers in the movement grid', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(lookup))
    .mockImplementationOnce(async () => new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `https://my.aclcargo.com/myacl/ShipmentTracking/SearchGrid?ShipmentNumber=${shipment}`);
  expect(fetcher.mock.calls[1]?.[0]).toBe(
    `https://my.aclcargo.com/myacl/ShipmentTracking/Latest?shipmentNumber=${shipment}&containerId=${container}&displaytype=`);
  expect(result).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Received Empty', last_update_local: '2026-11-11T09:29:00',
  });
  expect(result.events).toHaveLength(8);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[4]).toMatchObject({ description: 'Discharged Full From Vessel', stage: 'in_transit' });
  expect(result.events?.[6]).toMatchObject({ description: 'Received for Export', stage: 'accepted' });
});

it('distinguishes an empty carrier grid from a mismatched or changed reply', () => {
  expect(() => parseShipment(empty, 'SA-00000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseShipment(lookup, 'SA-00000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseMovements(history, shipment, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseMovements(history.replace('ArrayStore', 'OtherStore'), shipment, container))
    .toThrow(expect.objectContaining({ kind: 'schema' }));
});
