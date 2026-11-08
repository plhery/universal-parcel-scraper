// @vitest-environment node
import { expect, it } from 'vitest';
import { IndeterminateError, UpstreamHttpError, UpstreamNetworkError } from '../errors/index.js';
import { runSteps } from '../runner/index.js';
import { fetchBounded, parseJsonBytes } from '../transport/boundedFetch.js';
import type { LookupRecord, StepRecord } from './index.js';

const SECRETS = ['querysentinel', 'fragmentsentinel', 'requestbodysentinel', 'authorizationsentinel', 'cookiesentinel',
  'apikeysentinel', 'setcookiesentinel', 'replybodysentinel', 'invalidreplysentinel'];
const URL = 'https://carrier.example/track?accessKey=querysentinel&lang=en#fragmentsentinel';
const INIT = {
  method: 'POST', body: JSON.stringify({ answer: 'requestbodysentinel' }),
  headers: { Accept: 'application/json', Authorization: 'Bearer authorizationsentinel', Cookie: 'session=cookiesentinel',
    'X-Api-Key': 'apikeysentinel' },
};

/** What a generic serializer writes: every enumerable field, through causes and aggregated errors. */
function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item instanceof Error ? {
    ...item, name: item.name, message: item.message, cause: item.cause,
    errors: item instanceof AggregateError ? item.errors : undefined,
  } : item));
}

it('hands recorders transport errors without credentials, through causes and aggregates', async () => {
  const steps: StepRecord[] = [];
  const lookups: LookupRecord[] = [];
  const refused = async () => new Response('<p>Access denied</p><input name="csrf" value="replybodysentinel">', {
    status: 403, headers: { 'content-type': 'text/html', 'set-cookie': 'session=setcookiesentinel; Path=/' },
  });
  const unreachable = async (): Promise<Response> => { throw new TypeError('fetch failed'); };
  const invalid = async () => new Response('<html>token=invalidreplysentinel</html>');
  const failure = await runSteps({ carrier: 'example', budgetMs: 5_000, recorder: { step: (record) => steps.push(record), lookup: (record) => lookups.push(record) } }, [
    { id: 'direct', run: () => fetchBounded(URL, INIT, { provider: 'Example', fetcher: refused }) },
    { id: 'browser', run: async ({ previousError }) => {
      const errors: unknown[] = [previousError];
      await fetchBounded(URL, INIT, { provider: 'Example', fetcher: unreachable }).catch((error: unknown) => { errors.push(error); });
      const { bytes } = await fetchBounded(URL, INIT, { provider: 'Example', fetcher: invalid });
      try { parseJsonBytes(bytes, 'Example'); } catch (error) { errors.push(error); }
      throw new IndeterminateError('Example', 'Every route failed', { cause: new AggregateError(errors) });
    } },
  ]).catch((error: unknown) => error);

  const text = serialized({ steps, lookups });
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  expect(steps.map((step) => step.outcome)).toEqual(['challenge', 'indeterminate']);
  expect(lookups[0]!.error).toBe(failure);

  // The details stay, without their values; adapters still read the reply by name.
  const [refusal, network, parse] = ((failure as Error).cause as AggregateError).errors as [UpstreamHttpError, UpstreamNetworkError, Error & { response_body?: string }];
  const request = { url: 'https://carrier.example/track?accessKey=[redacted]&lang=[redacted]#[redacted]', method: 'POST',
    headers: { accept: 'application/json', authorization: '[redacted]', cookie: '[redacted]', 'x-api-key': '[redacted]' }, body: '[redacted]' };
  expect(refusal.request).toMatchObject(request);
  expect(network.request).toMatchObject(request);
  expect(refusal.diagnostics).toMatchObject({ body_read: 'complete', body_signals: ['access_denied'],
    headers: { 'content-type': 'text/html', 'set-cookie': '[redacted]' } });
  expect(refusal.diagnostics?.body_excerpt).toContain('replybodysentinel');
  expect({ ...refusal.diagnostics }).not.toHaveProperty('body_excerpt');
  expect(parse.response_body).toContain('invalidreplysentinel');
  // Details passed on to a new error stay as they were redacted.
  const passed = new UpstreamHttpError('Example', 403, undefined, refusal.diagnostics, refusal.request);
  expect(passed.diagnostics?.body_excerpt).toBe(refusal.diagnostics?.body_excerpt);
  expect(passed.request).toEqual(refusal.request);
  expect(serialized(passed)).not.toContain('replybodysentinel');
});
