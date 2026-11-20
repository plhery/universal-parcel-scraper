import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const known = readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.txt', import.meta.url), 'utf8');

it('checks the lorry receipt and retains its dated status summary', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(known));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  const url = new URL(String(fetcher.mock.calls[0]?.[0]));
  expect(url.origin + url.pathname).toBe('https://vidhierp.in/service.aspx');
  expect(url.searchParams.get('Control')).toBe('getLRWebsite');
  expect(JSON.parse(url.searchParams.get('data')!)).toEqual({ lrno: number });
  expect(result).toMatchObject({
    status: 'delivered', provider_code: '2', last_status_text: 'Delivered',
    last_update_local: '2022-01-12T15:30:44', summary_only: true, events: [],
  });
});

it('distinguishes the guest miss, a response for another receipt and a malformed timestamp', () => {
  expect(() => parseTracking(missing, number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(known, '000000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(known.replace('T15:30:44', 'T25:30:44'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
