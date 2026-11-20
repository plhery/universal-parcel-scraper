import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;
const found = fixture('consignment');

it('reads the exact GR and preserves its reported journey and separate current status', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(found));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://flywingcargo.com/tracking/?lr=${number}`, expect.objectContaining({
    headers: expect.objectContaining({ Accept: 'text/html' }),
  }));
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_update_local: '2026-11-03T12:16:00',
  });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[0]).toMatchObject({ provider_code: 'IN TRANSIT', local_time: '2026-11-03T20:24:00' });
  expect(result.events?.[1]).toMatchObject({ provider_code: 'DELIVERED', location: 'AURANGABAD' });
});

it('accepts only the native no-result state for the requested number', () => {
  const missing = fixture('missing');
  expect(() => parseTracking(missing, '00000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(missing, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(found, '00000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
