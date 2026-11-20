import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const delivered = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const inTransit = readFileSync(new URL('./fixtures/in-transit.html', import.meta.url), 'utf8');
const pickedUp = readFileSync(new URL('./fixtures/picked-up.html', import.meta.url), 'utf8');

it('retains completed movements newest first and preserves yearless scan clocks', () => {
  const result = parseTracking(delivered, 'MC-100188');
  expect(result).toMatchObject({
    current_stage: 'delivered', provider_code: 'delivered', service_name: 'Freight & Pallets', last_update: null,
  });
  expect(result.events?.map(event => event.description)).toEqual(['Delivered', 'In transit', 'Picked up']);
  expect(result.events?.[0]).toMatchObject({ provider_time_text: 'Oct 26, 1:24 AM MDT', location: 'Winnipeg, MB' });
  expect(result.events?.[0]?.time).toBeUndefined();
});

it('ignores scheduled stops even when the site gives them local clocks', () => {
  const transit = parseTracking(inTransit, 'MC-100245');
  expect(transit.current_stage).toBe('in_transit');
  expect(transit.events?.map(event => event.description)).toEqual(['In transit', 'Picked up']);
  const accepted = parseTracking(pickedUp, 'MC-100302');
  expect(accepted.current_stage).toBe('accepted');
  expect(accepted.events?.map(event => event.description)).toEqual(['Picked up']);
});

it('requires a whole shipment identity and recognizes only a bound missing notice', () => {
  expect(() => parseTracking(delivered, 'MC-10018')).toThrow(IndeterminateError);
  expect(() => parseTracking(delivered + delivered, 'MC-100188')).toThrow(SchemaError);
  expect(() => parseTracking('<p class="form-alert" role="status">No shipment found for INVALID!. Check the number or contact dispatch.</p>', 'INVALID!'))
    .toThrow(NotFoundError);
  expect(() => parseTracking('<p class="form-alert" role="status">No shipment found for OTHER.</p>', 'INVALID!')).toThrow(SchemaError);
  expect(() => parseTracking('<title>Just a moment</title>', 'MC-100188')).toThrow(ChallengeError);
  expect(() => parseTracking('<script>window._cf_chl_opt={}</script>', 'MC-100188')).toThrow(ChallengeError);
  const withPassiveScript = delivered + '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
  expect(parseTracking(withPassiveScript, 'MC-100188').current_stage).toBe('delivered');
});

it('uses only the normalized reference and the caller transport for lookup', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(delivered));
  const instance = adapter({ fetcher, userAgent: 'Move Cargo test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: '  mc100188 ' })).resolves.toMatchObject({ current_stage: 'delivered' });
  await expect(instance.track({ number: 'MC-100188&another=1' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [request, init] = fetcher.mock.calls[0]!;
  expect(String(request)).toBe('https://movecargo.ca/track?tracking_number=MC-100188');
  expect(new Headers(init?.headers).get('User-Agent')).toBe('Move Cargo test agent');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});
