import { expect, it, vi } from 'vitest';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import rejected from './fixtures/invalid-number.json' with { type: 'json' };
import registered from './fixtures/registered.json' with { type: 'json' };
import { parseTracking } from './parser.js';

it('deduplicates the registration summary and history and preserves its offset-free clock', () => {
  const result = parseTracking(registered, 200);
  expect(result).toMatchObject({
    status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
    provider_code: 'REGISTERED_IN_SYSTEM', last_update: null, last_update_local: '2024-10-14T12:23:17',
    events: [{
      provider_code: 'REGISTERED_IN_SYSTEM', description: 'Registered in the GlobKurier.pl system',
      stage: 'registered', local_time: '2024-10-14T12:23:17',
    }],
  });
  expect(result.events?.[0]).not.toHaveProperty('time');
});

it('recognizes other movement wording and prioritizes the carrier summary', () => {
  const delivered = { type: 'UNMAPPED_EVENT', name: 'Delivered', date: '2024-10-15 10:02:31', location: 'Warsaw' };
  const result = parseTracking({ ...registered, latestStatus: delivered }, 200);
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
    events: [{ stage: 'delivered', location: 'Warsaw' }, { stage: 'registered' }],
  });
});

it('keeps invalid booking references distinct from an empty or malformed response', () => {
  expect(() => parseTracking(rejected, 400)).toThrow(InvalidInputError);
  expect(() => parseTracking(rejected, 200)).toThrow(SchemaError);
  expect(() => parseTracking({ statuses: [] }, 200)).toThrow(NoHistoryError);
});

it('looks up a normalized GK reference without credentials and stops at verification', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(registered))
    .mockResolvedValueOnce(new Response('<title>Just a moment</title>', { status: 403 }));
  const instance = adapter({ fetcher, userAgent: 'GlobKurier test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: ' gk241014834170 ' })).resolves.toMatchObject({ status: 'pending' });
  const [request, options] = fetcher.mock.calls[0]!;
  expect(String(request)).toBe('https://api.globkurier.pl/v1/order/tracking?orderNumber=GK241014834170');
  expect(new Headers(options?.headers).has('Authorization')).toBe(false);
  expect(options?.redirect).toBe('error');
  await expect(instance.track({ number: 'GK241014834170' })).rejects.toThrow(ChallengeError);
  await expect(instance.track({ number: '241014834170' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
