import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');
const history = fixture('history');

it('matches the full guide and reports the last shipment movement after document processing', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('transportes-chevalier', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://api.chevalier.fivesoft.com.co/fivepostal/api/v1.0/public/tag/v3/' + number,
    expect.any(Object),
  );
  expect(result).toMatchObject({
    status: 'delivered', last_status_text: 'ENTREGA SIN IMAGEN', last_update_local: '2025-03-27T16:14:49',
  });
  expect(result.events).toHaveLength(7);
  expect(result.events?.[0]).toMatchObject({ stage: 'delivered', location: 'MAICAO', local_time: '2025-03-27T16:14:49' });
  expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery', description: 'EN DISTRIBUCION' });
  expect(result.events?.at(-1)).toMatchObject({ stage: 'registered', description: 'INGRESADO' });
  expect(result.events?.find(event => event.description?.startsWith('PLANILLADA'))).not.toHaveProperty('stage');
  expect(result.events?.some(event => /PREFACTURA|DIGITALIZADA/.test(event.description ?? ''))).toBe(false);
  expect(result).not.toHaveProperty('last_update');
});

it('rejects a different guide or any mixed-in movement and recognizes the native empty reply', () => {
  const otherMovement = history.replace('"tagid": 7749120505,\n      "dete_time"', '"tagid": 1,\n      "dete_time"');
  expect(otherMovement).not.toBe(history);
  expect(() => parseTracking(otherMovement, number, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(history, '0000000000', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), '0000000000', 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('missing'), number, 404)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
