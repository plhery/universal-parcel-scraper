import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const first = fixture('31CA66270');
const second = fixture('31CA69835');
const unknown = 'ZZZZZZZZ000000000000000';

describe('Redecarga guest guide tracking', () => {
  it('replays all nine visible scans with their reported clock precision', () => {
    const answer = parseTracking(first, '31CA66270');
    expect(answer).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'Recibido en destino', last_update: null, last_update_local: '2025-05-06T07:16:05',
      expected_delivery: null,
    });
    expect(answer.events?.map(event => [event.local_time, event.description, event.stage])).toEqual([
      ['2025-05-06T07:16:05', 'Recibido en destino', 'delivered'],
      ['2025-05-06T07:16', 'ENTREGADO', 'delivered'],
      ['2025-05-06T07:14', 'LLEGO AL PUNTO DE ENTREGA', 'out_for_delivery'],
      ['2025-05-05T16:21', 'GUIA EN REPARTO', 'out_for_delivery'],
      ['2025-05-02T17:38', 'EN BODEGA DESTINO', 'in_transit'],
      ['2025-05-02T16:41', 'GUIA EN VIAJE TRONCAL', 'in_transit'],
      ['2025-05-02T16:40', 'GUIA EN VEHICULO NACIONAL', 'in_transit'],
      ['2025-04-30T18:29', 'EN BODEGA ORIGEN', 'accepted'],
      ['2025-04-29T12:50:32', 'Mercancía aforada', 'accepted'],
    ]);
  });

  it('reads the carrier’s 12-hour delivery clock and shorter timeline', () => {
    const answer = parseTracking(second, '31CA69835');
    expect(answer.last_update_local).toBe('2025-06-27T11:15');
    expect(answer.events).toHaveLength(2);
    expect(answer.events?.[1]).toMatchObject({ local_time: '2025-06-26T10:04:21', stage: 'accepted' });
  });

  it('requires the same guide in the form and any linked tracking documents', () => {
    expect(() => parseTracking(first, '31CA69835')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(first.replace('guia=31CA66270', 'guia=31CA69835'), '31CA66270'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('distinguishes the native missing result, a changed page and a browser check', () => {
    expect(() => parseTracking(fixture('missing'), unknown)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('<title>Rastreo de encomiendas</title>', unknown))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', unknown))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('requests the public guide with the caller’s user agent and signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(first));
    const tracker = adapter({
      fetcher, userAgent: 'Redecarga Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: '31ca66270' }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      new URL('https://redecarga.gelotra.com/rastrearguia?guia=31CA66270'),
      expect.objectContaining({ signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'Redecarga Test' }) }),
    );
  });
});
