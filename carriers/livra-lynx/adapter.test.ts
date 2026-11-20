import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('125487');

describe('Livra Lynx guest tracking', () => {
  it('preserves the current status and four dated scans in chronological order', () => {
    const result = parseTracking(example, 200, 125487);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', provider_code: 'delivered',
      last_status_text: 'Livré', last_update: '2026-06-29T10:01:43.980Z',
    });
    expect(result.events?.map(({ stage, time, location }) => [stage, time, location])).toEqual([
      ['delivered', '2026-06-29T10:01:43.980Z', undefined],
      ['out_for_delivery', '2026-06-29T07:27:40.892Z', undefined],
      ['registered', '2026-06-28T19:16:16.677Z', undefined],
      ['in_transit', '2026-06-28T19:16:16.473Z', undefined],
    ]);
  });

  it('distinguishes explicit absence from an unrelated response or a gate', () => {
    expect(() => parseTracking(fixture('not-found'), 404, 9007199254740991))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('{"success":false,"message":"Route not found"}', 404, 125487))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(example, 200, 500000)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('<title>Just a moment...</title>', 200, 125487))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('retains an unfamiliar status without mapping it to another stage', () => {
    const result = parseTracking(example.replaceAll('delivered', 'new_portal_code'), 200, 125487);
    expect(result).toMatchObject({ status: 'unknown', provider_code: 'new_portal_code' });
    expect(result.events?.[0]).toMatchObject({ provider_code: 'new_portal_code' });
    expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it('sends the single numeric parcel number used by the carrier form', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: '00125487' })).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://m-api.livra.tn/api/tracking/parcels');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"num":125487}');
    await expect(tracker.track({ number: '9007199254740992' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
