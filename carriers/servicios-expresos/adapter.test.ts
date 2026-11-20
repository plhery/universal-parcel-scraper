import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = delivered.dataEnvio.Guia;

it('forwards the guide through the anonymous form and reads only reported movements', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('<meta name="csrf-token" content="fixture"><input id="Tracking">'))
    .mockResolvedValueOnce(new Response(JSON.stringify(delivered)));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('servicios-expresos', number) });
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://casillerousa.serviciosexpresos.com/index.php');
  expect(fetcher.mock.calls[1]?.[0]).toBe('https://casillerousa.serviciosexpresos.com/modulos/General/controller/BuscarTracking.php');
  const sent = fetcher.mock.calls[1]?.[1];
  expect(new Headers(sent?.headers).get('x-csrf-token')).toBe('fixture');
  expect(String(sent?.body)).toBe('Guia=' + number);
  expect(result).toMatchObject({
    status: 'delivered', last_update_local: '2022-06-01T17:29:53', current_stage: 'delivered',
  });
  expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
    ['8', 'delivered'], ['7', 'in_transit'], ['6', 'in_transit'], ['5', 'in_transit'],
    ['4', 'customs'], ['3', 'in_transit'], ['2', 'customs'], ['1', 'registered'],
  ]);
});

it('rejects a reply for another guide', () => {
  expect(() => parseTracking(JSON.stringify(delivered), number + '-OTHER'))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
