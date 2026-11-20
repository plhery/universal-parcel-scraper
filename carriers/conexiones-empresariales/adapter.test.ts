import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('opens the numbered carrier page and keeps its delivery at day precision', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('first-delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('conexiones-empresariales', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://app.conexionesempresariales.com/rastreo/?txtguia=' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'ENTREGADA', last_update_local: '2021-03-24' });
  expect(result.events).toEqual([expect.objectContaining({
    description: 'ENTREGADA', local_time: '2021-03-24', location: 'NEIVA', stage: 'delivered',
  })]);
});

it('requires the guide echo and recognizes a differently numbered real shipment', () => {
  const other = fixture('second-delivered');
  expect(() => parseTracking(other, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(parseTracking(other, numbers.records[1]!.number)).toMatchObject({ status: 'delivered' });
});
