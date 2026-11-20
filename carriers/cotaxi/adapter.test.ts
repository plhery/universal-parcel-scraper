import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url));
const history = fixture('history.pdf');

it('sends the prefix and serial independently and reads only recorded traceability stages', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array(history)));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('cotaxi', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://silogcotaxierp.serviciosproductivos.com.co/operacion_transporte/rep.guia_web.php?txtPrefijoGuia=RCFEB&txtNroGuia=4805',
    expect.any(Object),
  );
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'EN BODEGA DE DESTINO', last_update_local: '2025-11-15T20:23:27',
  });
  expect(result.events?.map(event => event.description)).toEqual([
    'EN BODEGA DE DESTINO', 'EN BODEGA INTERMEDIA', 'VIAJANDO', 'EN BODEGA DE ORIGEN', 'GENERADA',
  ]);
  expect(result.events?.[1]).toMatchObject({ stage: 'in_transit', local_time: '2025-11-14T17:23:14' });
  expect(result).not.toHaveProperty('last_update');
});

it('recognizes the native missing response and rejects a different guide', () => {
  expect(() => parseTracking(fixture('missing.txt'), 'ZZZZZ-00000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, 'RBGR-558600')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(history.subarray(0, 292), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
