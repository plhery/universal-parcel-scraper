import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CneTracker } from './adapter.js';
import { normalizeCneNumber, parseCne } from './parser.js';

const NUMBER = '3A5V000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/returned.json', import.meta.url), 'utf8'));
afterEach(() => vi.restoreAllMocks());

describe('CNE response projection', () => {
  it('binds the shipment and reverses oldest-first history while preserving unqualified clocks', () => {
    const result = parseCne(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      destination_country: 'SA', last_update: null });
    expect(result.events?.map(event => event.stage)).toEqual(['returned', 'exception', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-01-04 14:32:41', location: 'CN.Example Sort Facility' });
    expect(result.events?.every(event => event.time === undefined)).toBe(true);
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
  });

  it.each(['different', 'missing', 'conflicting'])('rejects %s source identity', mode => {
    const payload = fixture();
    if (mode === 'different') payload.Response_Info.trackingNbr = '3A5V999999999';
    if (mode === 'missing') delete payload.Response_Info.trackingNbr;
    if (mode === 'conflicting') payload.Response_Info.Number_t = '3A5V999999999';
    expect(() => parseCne(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('distinguishes the exact absent-order reply from rejections and contradictory negatives', () => {
    expect(() => parseCne({ ReturnValue: 0, cMess: '订单不存在' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [{ ReturnValue: -5555, cMess: '' }, { ReturnValue: 0, cMess: 'busy' },
      { ReturnValue: 0, cMess: '订单不存在', Response_Info: fixture().Response_Info }]) {
      expect(() => parseCne(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseCne({ ReturnValue: '1' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires a nonempty bounded history and rejects malformed rows', () => {
    const payload = fixture(); payload.trackingEventList = [];
    expect(() => parseCne(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const row of [null, {}, { details: [] }]) {
      const malformed = fixture(); malformed.trackingEventList.unshift(row);
      expect(() => parseCne(malformed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    payload.trackingEventList = Array.from({ length: 1001 }, () => fixture().trackingEventList[0]);
    expect(() => parseCne(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['2026-01-04T14:32:41+99:00', '2026-01-04T14:32:41+02:99', '2026-01-04T14:32:41+14:01', '2026-02-30T14:32:41Z'])('keeps an invalid clock unresolved: %s', clock => {
    const payload = fixture(); payload.trackingEventList.at(-1).date = clock;
    const result = parseCne(payload, NUMBER);
    expect(result.last_update).toBeNull();
    expect(result.events?.[0]).toMatchObject({ provider_time_text: clock });
    expect(result.events?.[0]?.time).toBeUndefined();
  });

  it('uses explicit instants without borrowing older clocks or changing source order', () => {
    const payload = fixture(); delete payload.Response_Info.status;
    payload.trackingEventList.at(-1).details = 'Delivered';
    payload.trackingEventList.at(-1).date = '2026-01-04T14:32:41+08:00';
    expect(parseCne(payload, NUMBER)).toMatchObject({ status: 'delivered', last_update: '2026-01-04T14:32:41+08:00', delivered_at: '2026-01-04T14:32:41+08:00' });
    payload.trackingEventList.at(-1).date = 'invalid';
    payload.trackingEventList[0].date = '2026-01-01T00:00:00Z';
    const result = parseCne(payload, NUMBER);
    expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
    expect(result.events?.at(-1)?.time).toBe('2026-01-01T00:00:00Z');
  });

  it('does not infer a terminal stage from an unknown summary code', () => {
    const payload = fixture(); payload.Response_Info.status = '900'; payload.Response_Info.Destination = 'SA-invalid';
    payload.trackingEventList = [{ details: 'Unrecognized processing milestone', date: '2026-01-01 12:00:00' }];
    const result = parseCne(payload, NUMBER);
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined(); expect(result.destination_country).toBeUndefined();
  });
});

describe('CNE retrieval', () => {
  it('reproduces the official WASM signing vectors in one anonymous request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_791_158_437_184);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await instance.track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://wapi.cne.com/tracking/officialWebsite?t=1791158437184');
    // Vectors from the public WASM using synthetic inputs, including the
    // first twelve timestamp digits and the prefix's final space.
    expect(init).toMatchObject({ method: 'POST', headers: { signature: 'f5a73ee0b15b192604fb1f8bbba0f983' },
      body: JSON.stringify({ lan: 'en', logisticsNo: NUMBER, md5: 'ee2b274a2a722ee10a45a715cdc8cab7' }) });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(normalizeCneNumber('3a5v-000000001')).toBe(NUMBER);
  });

  it.each(['123', `${NUMBER},OTHER`, `${NUMBER}&no=OTHER`])('rejects invalid input %s before I/O', async number => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new CneTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s separate from parcel absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) }));
    await expect(new CneTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
  });

  it('honors cancellation and bounds streaming responses', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new CneTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new CneTracker({ fetcher }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});
