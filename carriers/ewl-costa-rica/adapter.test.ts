import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');
const number = 'ANA5922554BD';

describe('EWL Costa Rica public guide tracking', () => {
  it('keeps all eight local scans and orders the same-minute movement after pickup', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'ENTREGADO', last_update: null, last_update_local: '2026-06-26T12:48',
    });
    expect(result.events?.map(({ description, local_time, stage }) => [description, local_time, stage])).toEqual([
      ['ENTREGADO', '2026-06-26T12:48', 'delivered'],
      ['EN RUTA DE ENTREGA', '2026-06-25T16:35', 'out_for_delivery'],
      ['RECIBIDO EN SEDE', '2026-06-25T16:10', 'in_transit'],
      ['EN TRANSITO A SEDE', '2026-06-25T16:09', 'in_transit'],
      ['EN BODEGA', '2026-06-25T16:08', 'in_transit'],
      ['EN TRANSITO A BODEGA', '2026-06-25T16:07', 'in_transit'],
      ['RECOLECTADO', '2026-06-25T16:07', 'accepted'],
      ['POR RECOLECTAR', '2026-06-25T14:28', 'registered'],
    ]);
  });

  it('distinguishes the native empty tables from a changed tracker, wrong guide or browser check', () => {
    expect(() => parseTracking(fixture('not-found'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('<p>Unknown tracking reply</p>', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(example, 'ZZZZ000000000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('26-06-2026', '31-06-2026'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('queries the public HTML tracker with the uppercased guide as its only input', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: number.toLowerCase() })).resolves.toMatchObject({ status: 'delivered' });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://ewl-cr.com/api/tracking?tracking=ANA5922554BD');
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Accept')).toBe('text/html');
  });
});
