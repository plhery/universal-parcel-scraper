import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const awb = '139-43814223';
const number = awb.replace('-', '');

it('reads the numbered waybill and its yearless cargo history', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(delivered));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('aeromexico-cargo', awb) });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://serv-amcargo.amsrvc.com/back-office/api/track/v3/139/43814223', expect.any(Object),
  );
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_status_text: 'Entregado (03 MAR 09:59)', provider_code: 'DLV',
  });
  expect(result.events).toHaveLength(17);
  expect(result.events?.[0]).toMatchObject({ description: 'Entregado (03 MAR 09:59)', location: 'LIM', stage: 'delivered' });
  expect(result.events?.every(event => !event.time && !event.local_time)).toBe(true);
  expect(result.last_update).toBeUndefined();
  expect(result.last_update_local).toBeUndefined();
});

it('does not complete a partially delivered load', () => {
  const partial = delivered.data.replace(/(DLV\/03MAR0959\/LIM\/)T68/, '$1P34');

  expect(parseTracking(partial, number)).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit', provider_code: 'DLV',
    last_status_text: 'Entrega registrada para parte de la carga (03 MAR 09:59)',
  });
});

it('keeps another air waybill’s movements out of the result', () => {
  expect(() => parseTracking(delivered.data, '13911111111')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
