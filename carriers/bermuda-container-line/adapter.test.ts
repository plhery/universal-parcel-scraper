import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import booking from './fixtures/booking.json' with { type: 'json' };
import container from './fixtures/container.json' with { type: 'json' };
import missing from './fixtures/not-found.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const config = { recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null };

it('looks up a public container and keeps container completion separate from delivery', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(container));
  const result = await adapter({ ...config, fetcher }).track({
    number: directTrackingNumber('bermuda-container-line', 'bclu 8009690'),
  });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://neptunebermuda.com/wp-json/bcl-tracker/v1/search',
    expect.objectContaining({ method: 'POST', body: '{"query":"BCLU8009690"}' }));
  expect(result).toMatchObject({
    status: 'unknown', last_status_text: 'In-Gate', last_update_local: '2026-11-06T11:38',
    events: [
      { description: 'In-Gate', location: 'HAMILTON, Bermuda', local_time: '2026-11-06T11:38' },
      { description: 'Out-Gate', stage: 'in_transit', local_time: '2026-11-05T10:35' },
      { description: 'Unloaded From Vessel', stage: 'in_transit', local_time: '2026-11-02T18:54' },
      { description: 'Loaded on Vessel', stage: 'in_transit' },
      { description: 'In-Gate (322)', stage: 'accepted' },
    ],
  });
  expect(result.current_stage).toBeUndefined();
  expect(result.delivered_at).toBeUndefined();
});

it('confirms a booking and keeps only container rows from that booking', () => {
  const response = { ...booking, groups: [...booking.groups, ...container.groups.map(group =>
    ({ ...group, documentCode: 'OTHER-BOOKING' }))] };
  const result = parseTracking(response, booking.query);

  expect(result.events).toHaveLength(5);
  expect(() => parseTracking({ ...booking, query: 'OTHER' }, 'OTHER'))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('recognizes the carrier’s empty result for the published master bill', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(missing));
  await expect(adapter({ ...config, fetcher }).track({ number: missing.query }))
    .rejects.toMatchObject({ kind: 'not_found' });
});
