import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const reference = delivered.reference;

it('reads the public consignment scans and keeps their carrier offsets', () => {
  const result = parseTracking(delivered, reference, 200);
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered', last_update: '2026-05-20T01:17:59+10:00',
  });
  expect(result.events).toHaveLength(10);
  expect(result.events?.[0]).toMatchObject({ stage: 'delivered', description: 'Delivered' });
  expect(result.events?.at(-1)).toMatchObject({ description: 'Tracking not Available', provider_code: 'unknown' });
  expect(result.events?.at(-1)?.stage).toBeUndefined();
});

it('looks up a booking by ID and scopes an item-label lookup to the matching item', () => {
  const booking = { ...delivered, reference: delivered.bookingId };
  expect(parseTracking(booking, booking.reference, 200).events).toHaveLength(10);

  const item = {
    label: 'TD-CHILD', stage: 'picked_up',
    events: [{ stage: 'picked_up', status: 'Picked Up', occurredAt: null, location: 'Brisbane' }],
  };
  const reply = { ...delivered, reference: item.label, items: [...delivered.items, item] };
  const result = parseTracking(reply, item.label, 200);
  expect(result).toMatchObject({ current_stage: 'accepted', last_update: null });
  expect(result.events).toEqual([{
    stage: 'accepted', stage_source: 'carrier_map', description: 'Picked Up', provider_code: 'picked_up', location: 'Brisbane',
  }]);
});

it('requires a bound booking or item, and the exact 404 response for a missing shipment', () => {
  expect(() => parseTracking(delivered, 'TD-MISMATCH', 200)).toThrow(IndeterminateError);
  expect(() => parseTracking({ ...delivered, reference: 'TD-MISMATCH' }, 'TD-MISMATCH', 200)).toThrow(IndeterminateError);
  const missing = { reference, matched: false, state: 'not_found', items: [] };
  expect(() => parseTracking(missing, reference, 404)).toThrow(NotFoundError);
  expect(() => parseTracking(missing, reference, 200)).toThrow(SchemaError);
  expect(() => parseTracking({}, reference, 404)).toThrow(SchemaError);
});

it('passes the whole reference and caller transport to the public API', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(delivered))
    .mockResolvedValueOnce(new Response('<title>Just a moment</title>', { status: 200 }));
  const instance = adapter({ fetcher, userAgent: 'Transdirect test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  const signal = new AbortController().signal;
  await expect(instance.track({ number: reference }, { signal, budgetMs: 1_000 }))
    .resolves.toMatchObject({ current_stage: 'delivered' });
  const [request, init] = fetcher.mock.calls[0]!;
  expect(String(request)).toBe(`https://api.transdirect.com.au/api/v5/tracking/${reference}`);
  expect(new Headers(init?.headers).get('User-Agent')).toBe('Transdirect test agent');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  await expect(instance.track({ number: reference })).rejects.toThrow(ChallengeError);
});
