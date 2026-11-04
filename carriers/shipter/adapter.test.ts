import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ShipterTracker } from './adapter.js';
import { normalizeShipterNumber, parseShipter, SHIPTER_ENDPOINT } from './parser.js';
import { shipterScanKey, shipterStage } from './status.js';
import carrier from './carrier.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'H3AU482716KR';
interface Reply { suc: number; result: Record<string, unknown>[] }
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/track.json', import.meta.url), 'utf8')) as Reply;
const absence = () => JSON.parse(readFileSync(new URL('./fixtures/unknown.json', import.meta.url), 'utf8')) as unknown;
const scans = (reply: Reply) => reply.result[0]!.events as Record<string, string>[];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Shipter native tracking', () => {
  it('routes a recent whole-number history automatically through the supplied transport', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-22T12:00:00Z'));
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        expect(String(url)).toBe(SHIPTER_ENDPOINT);
        return json(fixture());
      });
      const tracker = createTracker({ fetcher, providers: [], env: {}, trawlUrl: '', chromiumPath: '' });
      const answer = await tracker.track({ number: NUMBER });
      expect(answer).toMatchObject({ carrier: 'shipter', source: 'shipter', result: { current_stage: 'delivered' } });
      expect(answer.result.events).toHaveLength(13);
      expect(answer.result.events[0]).toMatchObject({ time: '2026-03-21T12:14:00+09:00' });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('does not retain malformed feed text in returned or recorded error causes', async () => {
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('SYNTHETIC PRIVATE REPLY'));
    let failure: unknown;
    try { await new ShipterTracker({ fetcher, recorder }).fetch(NUMBER); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: 'schema' });
    expect(failure).not.toHaveProperty('cause');
    for (const [record] of [...recorder.step.mock.calls, ...recorder.lookup.mock.calls]) {
      expect(record.error).not.toHaveProperty('cause');
      expect(String(record.error)).not.toContain('SYNTHETIC PRIVATE');
    }
  });

  it('uses the official single-number JSON POST and the supplied transport, signal and user agent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new ShipterTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(SHIPTER_ENDPOINT);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ trackNos: [NUMBER] }) });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shipter', step: 'direct', outcome: 'ok' }));
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'shipter', recordsSteps: true, steps: ['direct', 'retry'] });
    expect(carrier.tracking).toMatchObject({ adapter: 'shipter', steps: ['direct', 'retry'], recognition: { rank: 727 } });
  });

  it('keeps all scans and the explicitly stated offset, using scan clocks for freshness and delivery', () => {
    const reply = fixture();
    reply.result[0]!.recipient = { address: 'Synthetic private address' };
    const result = parseShipter(reply, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      destination_country: 'AU', last_status_text: 'Delivered.', last_update: '2026-03-21T12:14:00+09:00',
      delivered_at: '2026-03-21T12:14:00+09:00', expected_delivery: null });
    expect(result.events).toHaveLength(13);
    expect(result.events!.every((event) => event.time?.endsWith('+09:00') && !event.local_time)).toBe(true);
    expect(result.events!.map((event) => event.stage)).toEqual([
      'delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'registered',
      'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered',
    ]);
    expect(result).not.toHaveProperty('history_truncated');
    for (const field of ['canonical_tracking_number', 'delivery_tracking_number', 'delivery_carrier', 'receiver_name']) expect(result).not.toHaveProperty(field);
    expect(JSON.stringify(result)).not.toContain('Synthetic private address');
  });

  it('matches the whole own identifier without accepting a partner reference or a truncated prefix', () => {
    for (const returned of ['H3AU482715KR', `${NUMBER}${' '.repeat(100)}OTHER`]) {
      const reply = fixture();
      reply.result[0]!.in_track_no = returned;
      reply.result[0]!.out_track_no = NUMBER;
      expect(() => parseShipter(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const reply = fixture();
    reply.result[0]!.in_track_no = ` ${NUMBER.toLowerCase()} `;
    expect(parseShipter(reply, NUMBER).events).toHaveLength(13);
    reply.result.push(structuredClone(reply.result[0]!));
    expect(() => parseShipter(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('requires the official service success envelope, identity fields and structured history', () => {
    for (const reply of [null, [], {}, { result: fixture().result }, { suc: 1, result: {} }, { suc: 1, result: [null] }]) {
      expect(() => parseShipter(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const [key, value] of [['in_track_no', {}], ['events', {}], ['status', {}], ['destination', []]] as const) {
      const reply = fixture();
      reply.result[0]![key] = value;
      expect(() => parseShipter(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseShipter({ suc: 0, result: fixture().result }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts five-digit serials only when the whole returned Shipter number matches', async () => {
    const number = 'H3AU48271KR', reply = fixture();
    reply.result[0]!.in_track_no = number;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(reply));
    await expect(new ShipterTracker({ fetcher }).fetch(number)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ trackNos: [number] });
    expect(() => parseShipter(fixture(), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes only the observed error-envelope absence signature', () => {
    expect(() => parseShipter(absence(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const reply of [
      { suc: 1, result: [] }, { deliveries: [] }, { deliveries: [], err: 'expired' }, { deliveries: [], err: 'upstream error' },
      { deliveries: [], err: '' }, { err: 'no result' }, { deliveries: [{}], err: 'no result' },
      { deliveries: [], err: 'no result', suc: 1 }, { deliveries: [], err: 'no result', result: [] },
      { deliveries: [], err: 'no result', expired: true },
    ]) {
      expect(() => parseShipter(reply, NUMBER)).toThrow(expect.not.objectContaining({ kind: 'not_found' }));
    }
    expect(() => parseShipter({ deliveries: [], err: {} }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not treat provider-declared throttles or verification failures as absence', () => {
    expect(() => parseShipter({ err: 'Too many requests' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseShipter({ err: 'CAPTCHA required' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses dated scan activity for HTTP recognition, not the later refresh clock', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture())).mockResolvedValueOnce(json(absence()));
    const instance = adapter(environment(fetcher));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-21T03:14:00.000Z' });
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: false });
    for (const foreign of ['SYNTHETICPARTNER4817', 'H3AU482716KR1', 'ABAU482716KR', '482716']) {
      await expect(instance.recognize!(foreign)).resolves.toEqual({ known: false });
      await expect(instance.track({ number: foreign })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(normalizeShipterNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
  });

  it('keeps offset-less clocks unresolved and preserves mixed-history order', () => {
    const reply = fixture();
    scans(reply)[0]!.time = '2026-03-21 12:14';
    const result = parseShipter(reply, NUMBER);
    expect(result.events![0]).toMatchObject({ local_time: '2026-03-21T12:14:00', description: 'Delivered.' });
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-03-21T12:14:00' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('preserves an event offset rather than replacing it with the catalog zone', () => {
    const reply = fixture();
    scans(reply)[0]!.time = '2026-03-21 12:14:08 GMT+05:30';
    expect(parseShipter(reply, NUMBER).events![0]!.time).toBe('2026-03-21T12:14:08+05:30');
  });

  it('rejects impossible, missing, malformed and overlong scan clocks', () => {
    for (const time of ['', '2026-02-30 12:14 GMT+09:00', '2026-03-21 24:00 GMT+09:00', '2026-03-21 12:60 GMT+09:00',
      '2026-03-21 12:14 GMT+99:00', '2026-03-21 12:14 GMT+09:99', `2026-03-21 12:14 GMT+09:00${' '.repeat(80)}OTHER`, 'tomorrow']) {
      const reply = fixture();
      scans(reply)[0]!.time = time;
      expect(() => parseShipter(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const invalid of [{ content: 'Synthetic scan', time: 42 }, { content: [], time: '2026-03-21 12:14 GMT+09:00' },
      { content: '', time: '2026-03-21 12:14 GMT+09:00' }, { content: 'Synthetic scan', time: '2026-03-21 12:14 GMT+09:00', location: {} }]) {
      const reply = fixture();
      reply.result[0]!.events = [invalid];
      expect(() => parseShipter(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('orders known instants, keeps equal-clock order and deduplicates exact duplicate scans', () => {
    const reply = fixture();
    const rows = scans(reply);
    reply.result[0]!.events = [...rows.slice(1), rows[0]!, rows[3]!];
    const result = parseShipter(reply, NUMBER);
    expect(result.events).toHaveLength(13);
    expect(result.events![0]!.description).toBe('Delivered.');
    expect(result.events![3]!.description).toContain('has been received');
    expect(result.events![4]!.description).toContain('currently in transit');
  });

  it('marks an identity-bound summary and capped or conflicting histories as partial', () => {
    const reply = fixture();
    reply.result[0]!.events = [];
    expect(parseShipter(reply, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, events: [], summary_only: true });
    reply.result[0]!.status = '';
    expect(() => parseShipter(reply, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    reply.result[0]!.status = 'delivered';
    reply.result[0]!.events = scans(fixture()).slice(1);
    expect(parseShipter(reply, NUMBER)).toMatchObject({ current_stage: 'out_for_delivery', history_truncated: true });
    expect(parseShipter(reply, NUMBER)).not.toHaveProperty('delivered_at');
    reply.result[0]!.events = Array.from({ length: 101 }, (_, index) => ({
      content: `Synthetic scan ${index}`, time: `2026-03-01 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00 GMT+09:00`,
    }));
    expect(parseShipter(reply, NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseShipter(reply, NUMBER).events).toHaveLength(100);
  });

  it('does not revive an older final stage after a newer unresolved scan', () => {
    const reply = fixture();
    reply.result[0]!.status = '';
    scans(reply).unshift({ content: 'Synthetic unresolved event', time: '2026-03-21 13:14 GMT+09:00', location: '' });
    const result = parseShipter(reply, NUMBER);
    expect(result).not.toHaveProperty('current_stage');
    expect(result.status).toBe('unknown');
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.last_status_text).toBe('Synthetic unresolved event');
  });

  it('retries a network failure once with the same identifier and records its provenance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Synthetic socket failure')).mockResolvedValueOnce(json(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new ShipterTracker({ fetcher, recorder }).fetch(NUMBER, { budgetMs: 1000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1]!.body).toBe(fetcher.mock.calls[1]![1]!.body);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shipter', step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'transport' }));
  });

  it.each([
    { status: 403, body: 'Forbidden', kind: 'challenge' },
    { status: 429, body: 'Throttled', kind: 'rate_limited' },
    { status: 200, body: '<html><title>CAPTCHA</title></html>', kind: 'challenge' },
    { status: 200, body: '<html><title>Just a moment</title></html>', kind: 'challenge' },
    { status: 200, body: '<html>Unexpected response</html>', kind: 'schema' },
    { status: 404, body: 'Not a tracking route', kind: 'transport' },
    { status: 302, body: '', kind: 'transport' },
    { status: 500, body: 'Internal error', kind: 'indeterminate' },
  ])('does not retry a $kind reply ($status)', async ({ status, body, kind }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status, headers: { 'Retry-After': '45' } }));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toMatchObject({ kind,
      ...(status === 429 ? { retryAfterMs: 45_000 } : {}) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honors caller cancellation without starting a retry or an already-cancelled lookup', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const tracker = new ShipterTracker({ fetcher });
    const pending = tracker.fetch(NUMBER, { signal: controller.signal, budgetMs: 1000 });
    controller.abort(new Error('Synthetic cancellation'));
    await expect(pending).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await expect(tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Synthetic cancellation');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging first read and retry inside the shared deadline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    await expect(new ShipterTracker({ fetcher }).fetch(NUMBER, { budgetMs: 80 })).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(true);
  });

  it('maps stable whole wordings while keeping variable depot text in the displayed scan', () => {
    for (const entry of statuses.entries) expect(shipterStage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(shipterScanKey(normalizeStatusWording('ABC, abc, your parcel is currently in transit to sampletown..'))).toBe('your parcel is currently in transit to …');
    expect(shipterStage(null, normalizeStatusWording('Your parcel is currently in transit to sampletown.. but delivery failed'))).toBeUndefined();
    expect(parseShipter(fixture(), NUMBER).events![2]!.description).toBe('Hub, hub, your parcel is currently in transit to sampletown..');
  });
});
