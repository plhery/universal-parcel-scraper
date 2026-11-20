import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const history = fixture('history');

it('uses the public lookup to return dated movements for the complete shipment number', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('dps-cargo', number.toLowerCase()) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://dpscargo.co.id/api/lacak',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ resi: number }) }));
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'DELIVERED', last_update: '2026-08-06T22:35:00.000Z' });
  expect(result.events).toHaveLength(9);
  expect(result.events?.[0]).toMatchObject({ provider_code: 'DELIVERED', stage: 'delivered' });
  expect(result.events?.find(event => event.provider_code === 'DITERIMA')).not.toHaveProperty('stage');
  expect(result.events?.find(event => event.provider_code === 'BERANGKAT')).toMatchObject({ stage: 'in_transit' });
});

it('distinguishes a carrier not-found reply from another shipment and an unrelated page', () => {
  expect(() => parseTracking(fixture('missing'), 'DPS-000000-000000', 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, 'DPS-000000-000000', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking('{}', number, 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
