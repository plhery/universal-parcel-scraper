import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import guide from './fixtures/guide.json' with { type: 'json' };
import history from './fixtures/history.json' with { type: 'json' };
import missing from './fixtures/no-guides.json' with { type: 'json' };
import { parseHistory } from './parser.js';

const number = 'BOG00100600000409';
const config = { recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null };

it('returns five PressEx scans after verifying the requested guide', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(guide))
    .mockResolvedValueOnce(Response.json(history));
  const result = await adapter({ ...config, fetcher }).track({
    number: directTrackingNumber('pressex-logistics', number.toLowerCase()),
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const requests = fetcher.mock.calls.map(([url, options]) => [url, JSON.parse(String(options?.body))]);
  expect(requests).toEqual([
    ['https://backend.nuvix.co/ingreso-login', expect.objectContaining({
      operationName: 'verBuscarListarGuia',
      variables: {
        sufijoUrl: 'pressex',
        busquedaAnidadaNueva: [{ valoresDeBusqueda: [number], camposYFiltros: [{ campo: 'numero_guia', filtro: 'iexact' }] }],
      },
    })],
    ['https://backend.nuvix.co/ingreso-login', expect.objectContaining({
      operationName: 'verBuscarListarStatusGuia',
      variables: { pkGuia: '8331', statusEsVisiblePortalWebPublico: true },
    })],
  ]);
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_status_text: 'ENTREGADO',
    last_update_local: '2021-07-01T19:52:00',
    events: [
      { stage: 'delivered', local_time: '2021-07-01T19:52:00' },
      { stage: 'in_transit', local_time: '2021-06-22T17:20:45' },
      { stage: 'in_transit', local_time: '2021-06-21T10:56:08' },
      { stage: 'accepted', local_time: '2021-06-21T10:55:42' },
      { stage: 'registered', local_time: '2021-06-21T10:55:42' },
    ],
  });
  expect(result.last_update).toBeUndefined();
});

it('stops before fetching history after an empty or different guide response', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(missing))
    .mockResolvedValueOnce(Response.json(guide));
  const tracker = adapter({ ...config, fetcher });

  await expect(tracker.track({ number })).rejects.toMatchObject({ kind: 'not_found' });
  await expect(tracker.track({ number: 'AB12345' })).rejects.toMatchObject({ kind: 'indeterminate' });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps the explicit delivered flag when the delivery event is absent', () => {
  const nonDeliveryRows = history.data.verBuscarListarStatusGuia.objects.slice(1);
  const result = parseHistory({ data: { verBuscarListarStatusGuia: { objects: nonDeliveryRows } } }, true);
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'ENTREGADO' });
  expect(result.last_update_local).toBeUndefined();
});
