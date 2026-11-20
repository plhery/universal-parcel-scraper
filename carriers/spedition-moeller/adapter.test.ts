import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const reference = delivered.tracking.searched_value;

it('binds the package barcode and preserves the carrier’s current status and offset timestamps', () => {
  const result = parseTracking(delivered, reference);
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', provider_code: 'CS_90_4',
    last_status_text: 'Zustellung erfolgt (vollständig)', last_update: '2026-06-11T09:01:00Z',
    delivered_at: '2026-06-11T09:01:00Z',
  });
  expect(result.events).toHaveLength(15);
  expect(result.events?.[0]).toMatchObject({ provider_code: 'CS_90_4', stage: 'delivered' });
  expect(result.events?.at(-1)).toMatchObject({ provider_code: 'CS_10', stage: 'registered' });
  expect(result.events?.find(event => event.provider_code === 'CS_19')).toMatchObject({ stage: 'exception' });
  expect(parseTracking(delivered, reference.slice(2))).toEqual(result);
});

it('rejects unrelated or ambiguous results before reading status', () => {
  const shipment = { ...delivered.tracking.shipments[0], packages: [] };
  expect(() => parseTracking({ ...delivered, tracking: { ...delivered.tracking, shipments: [shipment] } }, reference))
    .toThrow(IndeterminateError);
  expect(() => parseTracking(delivered, '999999999999999999')).toThrow(IndeterminateError);
});

it('distinguishes explicit absence from an incomplete envelope', () => {
  const missing = { ok: true, tracking: { found: false, searched_value: reference, shipments: [] } };
  expect(() => parseTracking(missing, reference)).toThrow(NotFoundError);
  expect(() => parseTracking({ ok: true, tracking: { found: true } }, reference)).toThrow(SchemaError);
});

it('posts the whole barcode and honors a verification response without retrying', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(delivered))
    .mockResolvedValueOnce(new Response('<title>Verification required</title>', { status: 403 }));
  const instance = adapter({ fetcher, userAgent: 'Artur Moeller test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: reference })).resolves.toMatchObject({ status: 'delivered' });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://api.spedition-moeller.com/v1/public/tracking-live');
  expect(init?.method).toBe('POST');
  expect(init?.body).toBe(JSON.stringify({ nve: reference, locale: 'de-DE' }));
  expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  await expect(instance.track({ number: reference })).rejects.toThrow(ChallengeError);
  await expect(instance.track({ number: '1234' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
