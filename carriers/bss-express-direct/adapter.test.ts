import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');
const number = 'BSS-RC-10001';

describe('BSS public receipt tracking', () => {
  it('reads the dated collection scan and the current status code', () => {
    expect(parseTracking(example, number)).toMatchObject({
      status: 'in_transit', current_stage: 'accepted', current_stage_source: 'explicit_mapping',
      last_status_text: 'Collected', provider_code: 'picked_up', last_update: '2026-10-01T18:09:58.987Z',
      events: [{
        description: 'Collected', provider_code: 'picked_up', time: '2026-10-01T18:09:58.987Z',
        stage: 'accepted', stage_source: 'explicit_mapping',
      }],
    });
  });

  it('distinguishes absent, mismatched and malformed tracking results', () => {
    expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(example, 'ZZZZ000000000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('58.987Z', '58.987'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('sends the restored receipt as the sole payload field to the public GET lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'bssrc10001' })).resolves.toMatchObject({ last_status_text: 'Collected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    const request = new URL(String(url));
    expect(request.origin).toBe('https://www.bssexpressdirect.com');
    expect(request.pathname).toBe('/_serverFn/6206f963125aa3e4eb139a88e231afbd092ac45cc1ec0a9b86521450eb0cc7f6');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new Headers(init?.headers).get('X-TSR-ServerFn')).toBe('true');
    expect(JSON.parse(request.searchParams.get('payload')!)).toEqual({
      t: { t: 10, i: 0, o: 0, p: { k: ['data'], v: [{ t: 1, s: number }] } },
      f: 127, m: [],
    });
  });
});
