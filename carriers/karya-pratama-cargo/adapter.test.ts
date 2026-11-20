import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const history = fixture('history');

it('checks the full receipt number and reads the dated warehouse and port milestones', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://api.karyapratamacargo.co.id/api/index.php?route=tracking%2Ftrack&no_resi=${number}`,
    expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
  );
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'Tiba di Pelabuhan Kota/Kab Tujuan', last_update_local: '2026-08-24T16:06:11',
  });
  expect(result.events).toHaveLength(2);
  expect(result.events?.[0]).toMatchObject({ stage: 'in_transit', location: expect.any(String) });
  expect(result.events?.[1]).toMatchObject({ stage: 'registered' });
});

it('distinguishes the carrier’s no-result reply from another shipment', () => {
  expect(() => parseTracking(fixture('missing'), '000000', 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, '000000', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking('{}', number, 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
