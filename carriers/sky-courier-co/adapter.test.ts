import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;
const positive = fixture('delivered');

it('restores the official guide form and reports only the confirmed current status', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(positive));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: number.replaceAll('-', '').toLowerCase() });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://casillero.skycourier.com.co/api/tracking/${number}`,
    expect.objectContaining({ headers: expect.objectContaining({ Referer: 'https://casillero.skycourier.com.co/track' }) }),
  );
  expect(result).toEqual({
    status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
    last_status_text: 'Entregado', provider_code: 'ENTREGADO', summary_only: true, events: [],
  });
});

it('checks the exact own guide and recognizes the carrier’s no-result reply', () => {
  const invalid = 'SKY-0000-00000';
  expect(() => parseTracking(fixture('missing'), invalid, 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(positive, invalid, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking('{}', invalid, 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
