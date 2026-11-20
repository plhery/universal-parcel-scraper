import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const provider = 'enviamos-comunicaciones';
const number = numbers.records[0]!.number;
const unknown = '00000000000000000000';
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('looks up the main code and preserves the carrier’s day-only intake and visit dates', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('certified')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber(provider, number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.enviamoscym.com/rastreo-envios-mensajeria.php?codigo=' + number + '&tipo-codigo=cod-principal',
    expect.any(Object),
  );
  expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  expect(result.events).toEqual([
    { description: 'Fecha última visita', local_time: '2026-06-03' },
    { description: 'Fecha ingreso oficina', local_time: '2026-05-29', stage: 'accepted', stage_source: 'carrier_map' },
  ]);
  expect(result).not.toHaveProperty('delivered_at');
});

it('binds both the found and missing replies to the requested code', () => {
  expect(() => parseTracking(fixture('certified'), unknown)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), unknown)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
