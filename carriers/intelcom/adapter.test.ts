import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IntelcomTracker } from './adapter.js';
import { normalizeIntelcomNumber, parseIntelcom } from './parser.js';

const NUMBER = 'INTLCM0000000000';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));

describe('Canadian Intelcom / Dragonfly response', () => {
  it('projects English milestone labels and explicit scan clocks without recipient or driver details', () => {
    const result = parseIntelcom(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-01-03T17:00:00Z' });
    expect(result.events).toHaveLength(3);
    expect(result.events?.[1]).toMatchObject({ description: 'Out for delivery', stage: 'out_for_delivery', provider_code: 'OFD' });
    expect(result.events?.[0]?.stage_source).toMatch(/^wording:/);
    expect(JSON.stringify(result)).not.toMatch(/Synthetic driver|Synthetic recipient|Private details|street/);
  });

  it('rejects wrong identity, malformed rows and excessive history', () => {
    for (const identity of [undefined, 'INTLCM1111111111', { number: NUMBER }]) {
      const payload = fixture(); payload.data.result.tracking_id = identity;
      expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const payload = fixture(); payload.data.result.status_list.unshift(null);
    expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    payload.data.result.status_list = Array.from({ length: 1001 }, () => payload.data.result.last_status);
    expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts only an explicit upstream negative reply', () => {
    expect(() => parseIntelcom({ success: false, data: { code: 'not_found', result: null } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseIntelcom({ success: false, data: { code: 'upstream_error', result: null } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseIntelcom({}, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('retains a dated summary when the public service returns no history', () => {
    const payload = fixture(); delete payload.data.result.status_list;
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ summary_only: true, events: [], status: 'delivered' });
    payload.data.result.last_status.timestamp = '2026-01-03 12:00:00';
    expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('leaves a local clock unresolved and does not borrow an older scan instant', () => {
    const payload = fixture(); payload.data.result.last_status.timestamp = '2026-01-03 12:00:00';
    const result = parseIntelcom(payload, NUMBER);
    expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
  });

  it.each(['2026-01-03T17:00:00+99:00', '2026-01-03T17:00:00+02:99', '2026-01-03T17:00:00+14:01',
    1767456000, 1767456000000.5, 10_000_000_000_000, Number.MAX_SAFE_INTEGER])(
    'preserves an invalid clock %s without resolving delivery or accepting an undated summary', clock => {
      const payload = fixture();
      payload.data.result.last_status.timestamp = clock;
      payload.data.result.status_list[0].timestamp = clock;
      const result = parseIntelcom(payload, NUMBER);
      expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
      expect(result.events?.[0]).toMatchObject({ provider_time_text: String(clock) });
      expect(result.events?.[0]?.time).toBeUndefined();
      delete payload.data.result.status_list;
      expect(() => parseIntelcom(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    },
  );

  it.each([[1767456000000, '2026-01-03T16:00:00Z'], ['2026-01-03T17:00:00+05:30', '2026-01-03T17:00:00+05:30'],
    ['2026-01-03T17:00:00+1400', '2026-01-03T17:00:00+14:00']])('resolves a valid bounded clock %s', (clock, expected) => {
    const payload = fixture(); payload.data.result.last_status.timestamp = clock;
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ last_update: expected, delivered_at: expected });
  });

  it('does not expand recipient-address template tokens', () => {
    const payload = fixture(); payload.data.result.last_status.labels.shortLabel.en = 'Delivered {street}';
    payload.data.result.last_status.package_location = { address: { street: 'Private synthetic street' } };
    expect(parseIntelcom(payload, NUMBER).last_status_text).toBe('Delivered');
  });

  it('accepts the website\'s older direct label shape and numeric-string steps', () => {
    const payload = fixture(); payload.data.result.last_status.labels = {};
    payload.data.result.last_status.shortLabel = { en: 'Delivered' };
    payload.data.result.last_status.step = '4';
    expect(parseIntelcom(payload, NUMBER)).toMatchObject({ status: 'delivered', last_status_text: 'Delivered' });
  });
});

describe('Canadian Intelcom / Dragonfly retrieval', () => {
  it('uses the Canadian portal endpoint without cookies or authentication', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    await new IntelcomTracker({ fetcher }).fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://dragonflyshipping.ca/cfworker/v3/tracking/${NUMBER}/`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(normalizeIntelcomNumber('intlcm-0000000000')).toBe(NUMBER);
  });

  it('rejects invalid input and already aborted lookups before I/O', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123', `${NUMBER}&context=OTHER`]) {
      await expect(new IntelcomTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(new IntelcomTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']])('does not confuse HTTP %s with a not-found response', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) }));
    await expect(new IntelcomTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
  });
});
