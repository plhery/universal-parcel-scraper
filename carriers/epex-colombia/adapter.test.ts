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

it('posts the full guide and preserves the dated status and distinct tied scans', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('epex-colombia', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://epex.com.co/wp-json/epex-connect/v1/tracking',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ data: { ReferenciaEntrega: number } }) }),
  );
  expect(result).toMatchObject({
    status: 'exception', last_status_text: 'Incidencia', last_update_local: '2022-02-28T09:37:12',
  });
  expect(result.events).toHaveLength(5);
  expect(result.events?.filter(event => event.local_time === '2021-10-07T08:36:39').map(event => event.description))
    .toEqual(['Pendiente En Agencia', 'Descargado']);
  expect(result.events?.find(event => event.description === 'Pendiente En Agencia')).not.toHaveProperty('stage');
  expect(result).not.toHaveProperty('last_update');
});

it('requires an exact guide and only accepts the guide-specific missing response', () => {
  expect(() => parseTracking(history, '000000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), '000000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
