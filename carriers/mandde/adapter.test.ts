import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('submits the full guide for MANDDE and preserves its local movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('mandde', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.mandde.co/apiv3/getTracking', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ guia: number, codEmpresa: 1 }),
  }));
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'ENTREGADO', last_update_local: '2025-07-30T10:26:00' });
  expect(result.events?.map(event => event.stage)).toEqual([
    'delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered',
  ]);
  expect(result.events?.[0]).toMatchObject({
    local_time: '2025-07-30T10:26:00', location: 'PEREIRA-RISARALDA', provider_code: 'ENT',
  });
  expect(result.events?.[0]).not.toHaveProperty('time');
});

it('rejects a different guide and distinguishes the native missing reply', () => {
  expect(() => parseTracking(fixture('delivered'), '00000000000000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
});
