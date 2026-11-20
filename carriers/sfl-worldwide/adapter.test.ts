import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import missing from './fixtures/not-found.json' with { type: 'json' };

const config = { recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null };
const number = '155411113354';

it('returns the delivered summary and dated handoff for the exact number', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(delivered));
  const result = await adapter({ ...config, fetcher }).track({
    number: directTrackingNumber('sfl-worldwide', number),
  });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://hub-bk.sflworldwide.com/locations/getshipmentbytracking',
    expect.objectContaining({ method: 'POST', body: '{"TrackingNumber":"155411113354"}' }),
  );
  expect(result).toEqual({
    status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
    events: [{ description: 'Shipment has been connected via Blue Dart', local_time: '2025-09-19T07:54:34',
      stage: 'in_transit', stage_source: 'carrier_map' }],
  });
});

it('does not read results for a different tracking number', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(delivered));
  await expect(adapter({ ...config, fetcher }).track({ number: '101038384' }))
    .rejects.toMatchObject({ kind: 'indeterminate' });
});

it('recognizes the public tracker’s exact absent response', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(missing));
  await expect(adapter({ ...config, fetcher }).track({ number: '101038384' }))
    .rejects.toMatchObject({ kind: 'not_found' });
});
