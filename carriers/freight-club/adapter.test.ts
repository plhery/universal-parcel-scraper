import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import fragilepak from './fixtures/fragilepak-delivered.json' with { type: 'json' };
import metropolitan from './fixtures/metropolitan-delivered.json' with { type: 'json' };
import missing from './fixtures/missing.json' with { type: 'json' };
import pilot from './fixtures/pilot-delivered.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const booking = 'FCT914941113746325504';

it('tracks a booking and separates its delivery partner reference', () => {
  const result = parseTracking(fragilepak, booking);
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered', provider_code: 'Delivered',
    delivery_tracking_number: '361U1132829', delivered_at: '2022-01-03T10:15:00-08:00',
  });
  expect(result.events).toHaveLength(14);
  expect(result.events?.[0]).toMatchObject({ description: expect.stringMatching(/^Pick-up Appointment/), location: 'HUMBLE, TX' });
  expect(result.events?.[0]?.stage).toBeUndefined();
  expect(result.events?.[1]).toMatchObject({ stage: 'delivered', location: 'DURHAM, NC' });
  expect(result).not.toHaveProperty('canonical_tracking_number');
});

it('maps the movement wording from an upper-case Pilot Freight Services history', () => {
  const result = parseTracking(pilot, 'FCT1331382558750932992');
  expect(result).toMatchObject({ current_stage: 'delivered', delivery_tracking_number: '387141723' });
  expect(result.events).toHaveLength(11);
  expect(result.events?.[0]).toMatchObject({ description: 'DELIVERED', stage: 'delivered' });
  expect(result.events?.at(-1)).toMatchObject({ stage: 'registered' });
});

it('preserves the portal summary and keeps movement exceptions in the history', () => {
  const result = parseTracking(metropolitan, 'FCT903748028093956096');
  expect(result).toMatchObject({ current_stage: 'delivered' });
  // No delivered scan: the delivery-date field's offset can disagree with the scans', so it gives no instant.
  expect(result).not.toHaveProperty('delivered_at');
  expect(result.events?.[0]).toMatchObject({ description: 'Shipment Damaged', stage: 'exception' });
  expect(result.events).toHaveLength(13);
});

it('checks reference identity and distinguishes missing, empty and malformed replies', () => {
  expect(parseTracking(fragilepak, fragilepak.TrackingNumber)).not.toHaveProperty('delivery_tracking_number');
  expect(() => parseTracking(fragilepak, 'ZZZ_OTHER_PARTNER')).toThrow(IndeterminateError);
  expect(() => parseTracking(missing, missing.TrackingNumber)).toThrow(NotFoundError);
  expect(() => parseTracking(missing, booking)).toThrow(IndeterminateError);
  const statusOnly = { ...fragilepak, Details: null, LastStatusSimplified: 'PickedUp' };
  expect(parseTracking(statusOnly, booking)).toMatchObject({ current_stage: 'accepted', summary_only: true, events: [] });
  expect(() => parseTracking({ ...statusOnly, LastStatusSimplified: null }, booking)).toThrow(NoHistoryError);
  expect(() => parseTracking({ ...fragilepak, Details: [{ Date: '2021-12-30', Activity: 'Delivered' }] }, booking))
    .toThrow(SchemaError);
  expect(() => parseTracking({}, booking)).toThrow(SchemaError);
});

it('uses only the public number-in-path endpoint and distinguishes a verification page', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fragilepak))
    .mockResolvedValueOnce(new Response('<title>Just a moment</title>'));
  const instance = adapter({ fetcher, userAgent: 'Freight Club test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: booking })).resolves.toMatchObject({ current_stage: 'delivered' });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe(`https://app.freightclub.com/Tracking/GetTrackingInfo/${booking}`);
  expect(init?.redirect).toBe('error');
  expect(new Headers(init?.headers).get('User-Agent')).toBe('Freight Club test agent');
  await expect(instance.track({ number: booking })).rejects.toThrow(ChallengeError);
});
