import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;
const history = fixture('history');

it('looks up physical equipment and returns the movement dates without a delivery inference', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'http://elines.hedehk.com/cargoDynamicNewEN',
    expect.objectContaining({ method: 'POST', body: new URLSearchParams({ billno: '', cntr: number }) }),
  );
  expect(result).toMatchObject({
    status: 'unknown', last_status_text: 'RETURN BY CONSIGNEE', last_update_local: '2026-11-07T11:38:00',
  });
  expect(result.events).toHaveLength(16);
  expect(result.events?.[0]?.stage).toBeUndefined();
  expect(result.events?.find(event => event.provider_code === 'DTC')).toMatchObject({ stage: 'in_transit', location: 'USLAX' });
});

it('accepts the native no-result state only for the requested container', () => {
  const invalid = 'ABCU0000000';
  expect(() => parseTracking(fixture('missing'), invalid)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(history, invalid)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking('<title>Cargo Tracking</title>', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
