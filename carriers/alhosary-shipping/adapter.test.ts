import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');
const number = 'AHS-260910-4021';
const customs = fixture('customs');

describe('Alhosary shipment tracking', () => {
  it('reads dated sea freight movement and the current customs status', () => {
    const reply = parseTracking(customs, number);
    expect(reply).toMatchObject({
      status: 'in_transit', current_stage: 'customs', current_stage_source: 'explicit_mapping',
      last_status_text: 'إجراءات جمركية', provider_code: 'customs_clearance',
      last_update: '2026-10-08T10:30:00Z', expected_delivery: null,
    });
    expect(reply.events).toHaveLength(5);
    expect(reply.events?.[0]).toEqual({
      description: 'إجراءات جمركية', provider_code: 'customs_clearance', stage: 'customs',
      stage_source: 'explicit_mapping', location: 'ميناء جدة الإسلامي', time: '2026-10-08T10:30:00Z',
    });
  });

  it('reads the second example as out for delivery', () => {
    expect(parseTracking(fixture('out-for-delivery'), 'AHS-260925-7788')).toMatchObject({
      status: 'out_for_delivery', provider_code: 'out_for_delivery', last_update: '2026-10-12T06:45:00Z',
    });
  });

  it('separates an explicit absence from mismatched identifiers, malformed data and browser checks', () => {
    expect(() => parseTracking(fixture('not-found'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(customs, 'AHS-000000-0000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(customs.replace('2026-10-08T10:30:00.000Z', '2026-10-08'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('sends only the canonical tracking number through the guest server function', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(customs));
    const tracker = adapter({
      fetcher, userAgent: 'Alhosary Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: 'AHS2609104021' })).resolves.toMatchObject({ current_stage: 'customs' });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/alhosaryshipping\.com\/_serverFn\/[a-f0-9]{64}$/);
    expect(options).toMatchObject({
      method: 'POST', signal: expect.any(AbortSignal), headers: {
        'Content-Type': 'application/json', 'User-Agent': 'Alhosary Test', 'X-TSR-ServerFn': 'true',
      },
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      t: { t: 10, i: 0, o: 0, p: { k: ['data'], v: [{ t: 10, i: 1, o: 0, p: {
        k: ['tracking_number'], v: [{ t: 1, s: number }],
      } }] } },
      f: 127, m: [],
    });
  });
});
