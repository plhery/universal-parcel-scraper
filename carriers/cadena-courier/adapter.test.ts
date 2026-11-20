import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking, verifySearch } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');

it('uses the guest form and opens the confirmed guide details', async () => {
  const summary = fixture('summary.html');
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(summary))
    .mockResolvedValueOnce(new Response(summary))
    .mockResolvedValueOnce(new Response(fixture('detail.txt')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('cadena-courier', number) });
  expect(fetcher).toHaveBeenCalledTimes(3);
  const submitted = fetcher.mock.calls[1]?.[1]?.body as URLSearchParams;
  expect(submitted.get('ctl00$MainPane$LeftPane$leftContent$txconsulta')).toBe(number);
  const selected = fetcher.mock.calls[2]?.[1]?.body as URLSearchParams;
  expect(selected.get('__CALLBACKID')).toBe('ctl00$MainPane$MainContent$cpnl_vistas');
  expect(selected.get('__CALLBACKPARAM')).toBe('c0:');
  expect(result).toMatchObject({
    current_stage: 'registered', last_status_text: 'CREACION GUIA', last_update_local: '2025-10-24T16:12:58',
  });
  expect(result.events).toEqual([expect.objectContaining({ description: 'CREACION GUIA', location: 'LA ESTRELLA' })]);
});

it('rejects absent or mismatching guide rows and mismatching details', () => {
  expect(() => verifySearch(fixture('missing.html'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => verifySearch(fixture('summary.html'), '16692486')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('detail.txt'), '16692486')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
