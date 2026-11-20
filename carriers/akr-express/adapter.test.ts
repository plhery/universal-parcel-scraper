import { expect, it, vi } from 'vitest';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import missing from './fixtures/missing.json' with { type: 'json' };
import transit from './fixtures/transit.json' with { type: 'json' };
import { parseTracking } from './parser.js';

it('reads the live transit summary and preserves only the booked scan at its clock', () => {
  expect(parseTracking(transit, 200)).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
    last_update: '2020-12-03T06:00:00+05:30', last_status_text: 'In Transit', provider_code: 'transit',
    events: [{
      time: '2020-12-03T06:00:00+05:30', location: 'Chennai Main', description: 'Booked at Origin Station',
      provider_code: 'Booked at Origin Station', stage: 'registered', stage_source: 'carrier_map',
    }],
  });
});

it('keeps another actual timestamp under a numeric label without assigning it a stage', () => {
  const timeline = [{ ...transit.data.timeline[0], time: 'Thu 03/12/2020 · 04:26 PM' }, transit.data.timeline[1]];
  const result = parseTracking({ status: 'success', data: { ...transit.data, timeline } }, 200);
  expect(result.events?.[0]).toMatchObject({ provider_code: '1', time: '2020-12-03T16:26:00+05:30', location: 'Coimbatore TR' });
  expect(result.events?.[0]).not.toHaveProperty('stage');
});

it('recognizes delivery when the carrier reports it and reads its distinct event time', () => {
  const timeline = [{ ...transit.data.timeline[0], title: 'Delivered', time: 'Thu 03/12/2020 · 04:26 PM' }];
  const data = { ...transit.data, status: 'delivered', statusLabel: 'Delivered', timeline };
  expect(parseTracking({ status: 'success', data }, 200)).toMatchObject({
    status: 'delivered', current_stage: 'delivered', delivered_at: '2020-12-03T16:26:00+05:30',
  });
});

it('distinguishes the carrier missing response, a malformed result, and no history', () => {
  expect(() => parseTracking(missing, 404)).toThrow(NotFoundError);
  expect(() => parseTracking({ status: 'error' }, 404)).toThrow(SchemaError);
  expect(() => parseTracking({ status: 'success', data: { timeline: [] } }, 200)).toThrow(NoHistoryError);
});

it('posts just the normalized receipt and guest action, and identifies a challenge and invalid input', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(transit))
    .mockResolvedValueOnce(Response.json(missing, { status: 404 }))
    .mockResolvedValueOnce(new Response('<title>Just a moment</title>', { status: 403 }));
  const instance = adapter({ fetcher, userAgent: 'AKR test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: ' p125600 ' })).resolves.toMatchObject({ current_stage: 'in_transit' });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://akrexpress.com/wp-admin/admin-ajax.php');
  expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
  expect(String(options?.body)).toBe('action=akr_lr_track&lr_number=P125600');
  await expect(instance.track({ number: 'N975815' })).rejects.toThrow(NotFoundError);
  await expect(instance.track({ number: 'P125600' })).rejects.toThrow(ChallengeError);
  await expect(instance.track({ number: 'not an LR' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
