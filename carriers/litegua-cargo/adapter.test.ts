import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const history = fixture('history');

it('submits the exact electronic guide and binds its dated agency scans', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://apps.litegua.com/rastreoweb/rastreo.php',
    expect.objectContaining({ method: 'POST', body: new URLSearchParams({ busc: number }) }));
  expect(result).toMatchObject({
    status: 'delivered', last_status_text: 'ENTREGADO SATISFACTORIAMENTE', last_update_local: '2018-05-28T09:21:07',
  });
  expect(result.events).toHaveLength(6);
  expect(result.events?.[0]).toMatchObject({ location: 'Agencia Litegua Xela', stage: 'delivered' });
  expect(result.events?.[1]).not.toHaveProperty('stage');
  expect(result.events?.[2]).toMatchObject({ location: 'Agencia Litegua Express Central', stage: 'in_transit' });
});

it('distinguishes a blank electronic guide and another guide number', () => {
  expect(() => parseTracking(fixture('missing'), '000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, '000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
