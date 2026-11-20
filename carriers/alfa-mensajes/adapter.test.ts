import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import missing from './fixtures/missing.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;

it('uses the public physical guide route and the carrier’s dated status movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(delivered));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://api.dimail.co/api/v1/public/notificaciones/${number}`,
    expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }));
  expect(result).toMatchObject({
    status: 'delivered', last_status_text: 'entregado', last_update: '2026-10-21T18:42:09.328Z', delivered_at: '2026-10-21T18:42:09.328Z',
  });
  expect(result.events?.map(event => event.provider_code)).toEqual(['entregado', 'Asignado', 'casillero', 'revision']);
  expect(result.events?.find(event => event.provider_code === 'casillero')?.stage).toBeUndefined();
});

it('requires the exact physical guide and the native not-found response', () => {
  expect(() => parseTracking(JSON.stringify(missing), 'NF000000000', 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(JSON.stringify(delivered), 'NF000000000', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(JSON.stringify(missing), number, 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
