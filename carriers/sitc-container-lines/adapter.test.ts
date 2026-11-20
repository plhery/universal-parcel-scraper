import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const vessel = fixture('vessel');
const missing = fixture('missing');
const number = numbers.records[0]!.number;

it('uses the guest movement search and binds every row to the full container', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(vessel));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number: `${number.slice(0, 4).toLowerCase()} ${number.slice(4)}` });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://ebusiness.sitcline.com/api/equery/cmContainerHistory/movementSearch?containerNo=${number}`,
    expect.objectContaining({ method: 'POST' }));
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'OUTBOUND PICKUP', last_update_local: '2026-10-15T13:17',
  });
  expect(result.events).toHaveLength(3);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[1]).not.toHaveProperty('stage');
  expect(result.events?.[2]).toMatchObject({ location: 'KOBE', provider_code: 'LOADED ONTO VESSEL', stage: 'in_transit' });
});

it('preserves terminal gate-out and movements of empty equipment', () => {
  const result = parseTracking(fixture('gate-out'), numbers.records[1]!.number);
  expect(result.status).toBe('in_transit');
  expect(result.events?.[1]).not.toHaveProperty('stage');
  expect(result.events?.[2]).toMatchObject({ description: 'INBOUND DELIVERY', stage: 'in_transit' });
});

it('distinguishes empty, mismatched and malformed replies', () => {
  expect(() => parseTracking(missing, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(vessel, 'ABCU0000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(vessel.replace('2026-10-15', '2026-10-32'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
