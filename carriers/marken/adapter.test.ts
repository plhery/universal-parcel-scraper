import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const crossBorder = readFileSync(new URL('./fixtures/delivered-cross-border.html', import.meta.url), 'utf8');
const numeric = readFileSync(new URL('./fixtures/delivered-numeric.html', import.meta.url), 'utf8');
const recent = readFileSync(new URL('./fixtures/delivered-recent.html', import.meta.url), 'utf8');

it('reads a delivered job and dated customs scans from the published result', () => {
  const result = parseTracking(crossBorder, '620X42712895');
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', provider_code: 'Delivered',
    last_update: null, last_update_local: '2026-09-28T09:44:00', weight_kg: 18,
  });
  expect(result.events).toHaveLength(10);
  expect(result.events?.find(event => event.description === 'Submitted to customs on'))
    .toMatchObject({ local_time: '2026-09-24T08:33:00', stage: 'customs' });
  expect(result.events?.[0]).not.toHaveProperty('time');
});

it('keeps the scan order the carrier displayed across local clocks', () => {
  const result = parseTracking(recent, '620X43658402');
  expect(result.events).toHaveLength(8);
  expect(result.events?.slice(-3).map(event => event.description)).toEqual(['Delayed on', 'Collected on', 'Booked date']);
});

it('handles a numeric job and drops signature wording and unitless weight', () => {
  const withSignature = numeric.replace('18:53 EDT</p>', '18:53 EDT signed by Example Recipient</p>');
  const result = parseTracking(withSignature, '12847572');
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivered', last_update_local: '2022-11-04T18:53:00' });
  expect(result.events?.find(event => event.description === 'Pickup Package')).toMatchObject({ stage: 'registered' });
  expect(result).not.toHaveProperty('weight_kg');
  expect(JSON.stringify(result)).not.toContain('Example Recipient');
});

it('does not attribute a response to a different shipment and recognizes explicit absence', () => {
  expect(() => parseTracking(recent, '620X42712895')).toThrow(IndeterminateError);
  expect(() => parseTracking(recent.replace(/>\s*620X43658402\s*</, '>620X42712895<'), '620X43658402'))
    .toThrow(IndeterminateError);
  expect(() => parseTracking('<title>Track your shipment</title>', '12847572')).toThrow(SchemaError);
  const missing = '<form><input id="jobNumber" name="jobNumber" value="12847572"></form><div class="mt-4">No shipment found.</div>';
  expect(() => parseTracking(missing, '12847572')).toThrow(NotFoundError);
});

it('requests the whole job without credentials and stops on a verification response', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(recent))
    .mockResolvedValueOnce(new Response('<title>Verification required</title>', { status: 403 }));
  const instance = adapter({ fetcher, userAgent: 'Marken test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: ' 620x43658402 ' })).resolves.toMatchObject({ status: 'delivered' });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(String(url)).toBe('https://www.marken.com/track-shipment?jobNumber=620X43658402');
  expect(options?.redirect).toBe('error');
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(new Headers(options?.headers).has('Authorization')).toBe(false);
  await expect(instance.track({ number: '620X43658402' })).rejects.toThrow(ChallengeError);
  await expect(instance.track({ number: 'invalid query' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
