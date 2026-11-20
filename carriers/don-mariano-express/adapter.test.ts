import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const [guide, code] = numbers.records;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('uses the guide number and keeps the confirmed depot movement dates', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('guide')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('don-mariano-express', guide!.number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.don-mariano.com/tracking?cargaID=' + guide!.number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'CONFIRMADO', last_update_local: '2025-07-21',
  });
  expect(result.events?.map(event => [event.local_time, event.description, event.location])).toEqual([
    ['2025-07-21', 'Destino', 'GARUPA RM'],
    ['2025-07-21', 'Origen', 'GARUPA RM'],
    ['2025-07-21', 'Destino', 'GARUPA'],
    ['2025-07-19', 'Origen', 'CORDOBA RM'],
  ]);
});

it('restores the tracking-code separators and verifies the code shown on the guide', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('tracking-code')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('don-mariano-express', code!.number.replaceAll('-', '')) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.don-mariano.com/tracking?codSeguimiento=' + code!.number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({ last_update_local: '2025-07-18', current_stage: 'in_transit' });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[1]).toMatchObject({
    description: 'Destino', location: 'Resitencia Centro CHACO', stage: 'in_transit', local_time: '2025-07-18',
  });
});

it('rejects a different guide and skips scheduled movements awaiting confirmation', () => {
  expect(() => parseTracking(fixture('tracking-code'), guide!.number, true))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('guide'), code!.number, false))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  const planned = fixture('guide').replaceAll('✓ Confirmado', 'Pendiente');
  const result = parseTracking(planned, guide!.number, true);
  expect(result).toMatchObject({ status: 'unknown', summary_only: true, last_status_text: 'CONFIRMADO' });
  expect(result.events).toBeUndefined();
});
