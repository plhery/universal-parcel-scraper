import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import availableEvents from './fixtures/CHS246914-events.json' with { type: 'json' };
import availableSearch from './fixtures/CHS246914-search.json' with { type: 'json' };
import collectedEvents from './fixtures/NYC296044-events.json' with { type: 'json' };
import collectedSearch from './fixtures/NYC296044-search.json' with { type: 'json' };
import absent from './fixtures/not-found.json' with { type: 'json' };
import { parseSearch, parseTracking } from './parser.js';

it('uses the anonymous form to retrieve dated movement history for a house bill', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('<script>const sacoTracking = {"nonce":"0123456789"};</script>'))
    .mockResolvedValueOnce(Response.json(collectedSearch))
    .mockResolvedValueOnce(Response.json(collectedEvents));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('saco-shipping-line', 'SSLLNYC296044') });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://sacoshipping.com/track/',
    'https://sacoshipping.com/wp-json/saco-tracking/v1/search',
    'https://sacoshipping.com/wp-json/saco-tracking/v1/events/1',
  ]);
  expect((fetcher.mock.calls[1]?.[1]?.body as URLSearchParams).get('reference')).toBe('NYC296044');
  expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({ 'X-WP-Nonce': '0123456789' });
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'CFS Pick-Up By Customer', last_update_local: '2026-10-12T09:29:00',
    events: expect.arrayContaining([expect.objectContaining({ provider_code: '83', location: 'USNYC' })]),
  });
  expect(result.events?.every(event => !['75', '843'].includes(event.provider_code ?? ''))).toBe(true);
});

it('uses the freight availability scan when the summary is an estimate', () => {
  const result = parseTracking(availableEvents, parseSearch(availableSearch, 'CHS246914'));
  expect(result).toMatchObject({
    current_stage: 'ready_for_pickup', last_update_local: '2026-10-07T11:45:00', last_status_text: 'Freight Available',
  });
});

it('rejects absent and unrelated shipment records', () => {
  expect(() => parseSearch(absent, '202613474401')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseSearch(collectedSearch, 'CHS246914')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking({ ...availableEvents, shipment_id: '2' }, parseSearch(availableSearch, 'CHS246914')))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
