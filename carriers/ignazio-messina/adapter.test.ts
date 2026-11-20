import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;

it('requests actual movements for one exact container', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(fixture('delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    `https://wpsapps.messinaline.it/MessinaShippingAPI/v1/ExDomino/ContainerTracking?booking=&bl=&cntr=${number}`,
    expect.any(Object),
  );
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-10-26' });
  expect(result.events).toHaveLength(7);
  expect(result.events?.[1]).toMatchObject({ description: 'Discharged', provider_code: 'SBP', stage: 'in_transit' });
});

it('discards intended movements and leaves empty equipment unstaged', () => {
  const moving = parseTracking(fixture('intended'));
  expect(moving).toMatchObject({ status: 'in_transit', last_status_text: 'Loaded', last_update_local: '2026-10-08' });
  expect(moving.events).toHaveLength(2);
  const empty = parseTracking(fixture('empty-equipment'));
  expect(empty).toMatchObject({ status: 'unknown', last_status_text: 'Empty To Shipper' });
  expect(empty.events?.[0]).not.toHaveProperty('stage');
  expect(() => parseTracking(fixture('invalid'))).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
});
