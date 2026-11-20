import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const delivered = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const returned = readFileSync(new URL('./fixtures/returned.html', import.meta.url), 'utf8');
const code = 'e14ec8a285e7388929a3580068ed2a60';

it('reads a delivered shipment, preserving portal order and offset-free clocks', () => {
  const result = parseTracking(delivered);
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-09-17T13:26:00',
    events: expect.arrayContaining([
      { description: 'Delivered', provider_code: 'Delivered', local_time: '2026-09-17T13:26:00',
        location: 'GERMANY', stage: 'delivered', stage_source: 'carrier_map' },
      expect.objectContaining({ description: 'Shipment purchased through Fraktjakt', stage: 'registered' }),
    ]),
  });
  expect(result.events).toHaveLength(9);
  expect(result.events?.[0]).not.toHaveProperty('time');
  expect(result.events?.at(-1)).not.toHaveProperty('location');
});

it('keeps the return current after the carrier closes its investigation', () => {
  const result = parseTracking(returned);
  expect(result).toMatchObject({
    current_stage: 'returned', last_status_text: 'Package was returned to the sender',
    last_update_local: '2026-09-24T14:38:00',
  });
  expect(result.events?.[0]).toMatchObject({
    description: 'Your investigation has been closed with a proof of delivery.', local_time: '2026-09-25T00:02:00',
  });
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[1]).toMatchObject({ location: 'VASTERAS, SWEDEN', stage: 'returned' });
});

it('drops signature details from a carrier scan', () => {
  const privateScan = delivered.replace('<h3>Delivered</h3>', '<h3>Delivered, signed by Test Recipient</h3>');
  const result = parseTracking(privateScan);
  expect(JSON.stringify(result)).not.toContain('Test Recipient');
});

it('distinguishes verification, an empty timeline and a changed result page', () => {
  expect(() => parseTracking('<title>Verification required</title>')).toThrow(ChallengeError);
  expect(() => parseTracking('<div id="result"><table class="shipping_details"></table></div>')).toThrow(NoHistoryError);
  expect(() => parseTracking('<h1>Track packages and pallets</h1>')).toThrow(SchemaError);
});

it('sends the whole native code once and handles inaccessible responses', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(delivered))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  const instance = adapter({ fetcher, userAgent: 'Fraktjakt test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: ` ${code.toUpperCase()} ` })).resolves.toMatchObject({ status: 'delivered' });
  const [request, options] = fetcher.mock.calls[0]!;
  expect(String(request)).toBe(`https://www.fraktjakt.se/trace/shipment/${code}?locale=en`);
  expect(options?.redirect).toBe('error');
  expect(new Headers(options?.headers).has('Authorization')).toBe(false);
  await expect(instance.track({ number: code })).rejects.toThrow(NoHistoryError);
  await expect(instance.track({ number: code })).rejects.toThrow(ChallengeError);
  await expect(instance.track({ number: '1234' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
