import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('checks the guide and returns four locally timed milestones through branch arrival', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('destination')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('transportes-agael', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://agaelsac.com/seguimiento/?codigo=' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'En destino', last_update_local: '2026-09-10T09:13:00',
  });
  expect(result.events?.map(event => [event.local_time, event.description, event.stage, event.location])).toEqual([
    ['2026-09-10T09:13:00', 'En destino', 'in_transit', 'CHICLAYO'],
    ['2026-09-08T11:50:00', 'En ruta', 'in_transit', undefined],
    ['2026-09-08T11:49:00', 'Despachado', undefined, undefined],
    ['2026-09-08T11:42:00', 'Registrado', 'registered', 'LIMA'],
  ]);
});

it('recognizes the empty search and rejects a different guide', () => {
  expect(() => parseTracking(fixture('empty-lookup'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  const mismatched = fixture('destination').replace('id="shipmentCode">' + number, 'id="shipmentCode">BLM000000');
  expect(() => parseTracking(mismatched, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
