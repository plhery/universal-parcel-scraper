import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const invoice = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('keeps the invoice hyphens and reads the carrier’s local minute clocks', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('pinoy-pride-worldwide', invoice) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://pinoyprideworldwidellc.com/api/track/' + invoice,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-10-22T14:18' });
  expect(result.events).toHaveLength(11);
  expect(result.events?.[1]).toMatchObject({ provider_code: 'rr_under_customs', stage: 'customs' });
  expect(result.events?.at(-1)).toMatchObject({ provider_code: 'rr_registered', stage: 'registered' });
});

it('requires the exact invoice and recognizes the native negative response', () => {
  expect(() => parseTracking(fixture('delivered'), 'PPW-WA-1001', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), 'PPW-WA-1001', 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
});
