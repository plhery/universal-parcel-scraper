import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type CarrierAdapter } from '../core/adapter/index.js';
import { detectCarrierMatch } from '../core/detection/index.js';
import { InputRequiredError, type CarrierErrorKind } from '../core/errors/index.js';
import { NOOP_RECORDER } from '../core/telemetry/index.js';
import { createTracker, TrackingError, type ParcelInput, type Tracker, type TrackingResponse } from '../facade/index.js';
import { createTrackingServer } from './index.js';

// Every tracking request detects its number before it joins or starts a lookup, so the calls count the requests that have.
vi.mock(import('../core/detection/index.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, detectCarrierMatch: vi.fn(actual.detectCarrierMatch) };
});
const detections = () => vi.mocked(detectCarrierMatch).mock.calls.length;

const servers: Server[] = [];
const answer: TrackingResponse = { carrier: 'ups', source: 'ups', result: { current_stage: 'delivered', events: [] }, attempts: [] };
const input = { number: '1Z999AA10123456784', carrier: 'ups' };
function tracker(track = vi.fn().mockResolvedValue(answer)): Tracker {
  return { track, detect: vi.fn(), recognize: vi.fn() };
}
async function started(options: Parameters<typeof createTrackingServer>[0]) {
  const server = createTrackingServer(options);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (url: string, value: Record<string, unknown> = input, token?: string, signal?: AbortSignal) => fetch(`${url}/v1/track`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value), signal });
/** A tracker whose lookups wait for their signal, keeping each signal. */
function held() {
  const signals: AbortSignal[] = [];
  const track = vi.fn().mockImplementation((_parcel: ParcelInput, context: { signal: AbortSignal }) => {
    signals.push(context.signal);
    return new Promise<TrackingResponse>((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
  });
  return { track, signals };
}
const failed = (kind: CarrierErrorKind, retryAfterMs?: number, source = 'ups') =>
  new TrackingError([{ source, kind, durationMs: 1 }], { kind, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
// A test that fails while a lookup is held leaves its requests open; dropping them lets the server close.
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }))); });

describe('tracking HTTP API', () => {
  it('authenticates before starting a lookup and leaves health accessible', async () => {
    const mock = tracker();
    const url = await started({ tracker: mock, token: 'synthetic-token' });
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await post(url)).status).toBe(401);
    expect(mock.track).not.toHaveBeenCalled();
    expect((await post(url, input, 'synthetic-token')).status).toBe(200);
  });

  it('shares concurrent duplicate requests and keeps credentials in the cache key', async () => {
    let finish!: (result: TrackingResponse) => void;
    const track = vi.fn().mockImplementation(() => new Promise<TrackingResponse>(resolve => { finish = resolve; }));
    const url = await started({ tracker: tracker(track) });
    const first = post(url), second = post(url);
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
    finish(answer);
    expect((await Promise.all([first,second])).map(response => response.status)).toEqual([200,200]);
    expect((await post(url)).status).toBe(200);
    expect((await post(url, { number: ` ${input.number} `, carrier: 'ups' })).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(1);
    track.mockResolvedValue(answer);
    expect((await post(url, { ...input, postcode: '0000' })).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('waits on a running lookup only when it runs on the same budget', async () => {
    const finish: ((result: TrackingResponse) => void)[] = [], fail: ((error: unknown) => void)[] = [];
    const track = vi.fn().mockImplementation(() => new Promise<TrackingResponse>((resolve, reject) => { finish.push(resolve); fail.push(reject); }));
    const url = await started({ tracker: tracker(track) });
    const budgets = () => track.mock.calls.map(([, options]) => options.budgetMs);
    // A caller with a budget of its own does not wait on a lookup that runs on the server's.
    const first = post(url);
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
    const own = post(url, { ...input, budgetMs: 5 });
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(2));
    expect(budgets()).toEqual([undefined, 5]);
    finish[1]!(answer);
    expect((await own).status).toBe(200);
    finish[0]!(answer);
    expect((await first).status).toBe(200);
    // Nor does a caller on the server's budget get the failure a shorter budget ended in.
    const parcel = { ...input, postcode: '0000' };
    const leader = post(url, { ...parcel, budgetMs: 5 });
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(3));
    const follower = post(url, parcel);
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(4));
    expect(budgets().slice(2)).toEqual([5, undefined]);
    fail[2]!(failed('budget'));
    expect((await leader).status).toBe(502);
    finish[3]!(answer);
    expect(await (await follower).json()).toEqual(answer);
    // Callers on the same budget still share one lookup.
    const repeated = { ...input, postcode: '1111', budgetMs: 5 };
    const one = post(url, repeated), two = post(url, repeated);
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(5));
    finish[4]!(answer);
    expect((await Promise.all([one, two])).map(response => response.status)).toEqual([200, 200]);
    expect(track).toHaveBeenCalledTimes(5);
  });

  it('keys a lookup on the detection of the number as printed and shares the answer by the normalized number', async () => {
    const track = vi.fn().mockResolvedValue({ ...answer, carrier: 'postlogistics', source: 'postlogistics' });
    const url = await started({ tracker: tracker(track) });
    // The dash makes the reference PostLogistics's own; the tracker gets it as printed and detects it itself.
    expect((await post(url, { number: '19999980-001' })).status).toBe(200);
    expect(track.mock.calls[0]![0]).toMatchObject({ number: '19999980-001', carrier: undefined });
    expect((await post(url, { number: ' 19999980-001 ' })).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(1);
    // Compact, the same digits leave the carrier open and are a lookup of their own.
    expect((await post(url, { number: '12345678001' })).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(2);
    expect(track.mock.calls[1]![0]).toMatchObject({ number: '12345678001', carrier: undefined });
  });

  it('confirms the carrier of a generic postal number as the SDK does, and keeps a chosen carrier a lookup of its own', async () => {
    const lookup = vi.fn<CarrierAdapter['track']>().mockResolvedValue({ status: 'delivered', events: [
      { time: new Date().toISOString(), description: 'Delivered', stage: 'delivered' },
    ] });
    const posti = vi.fn<NonNullable<CarrierAdapter['recognize']>>().mockResolvedValue({ known: true });
    const chronopost = vi.fn<NonNullable<CarrierAdapter['recognize']>>().mockResolvedValue({ known: false });
    const adapter = (id: string, recognize: CarrierAdapter['recognize']) => (): CarrierAdapter => ({ id, steps: ['direct'], track: lookup, recognize });
    const registry = new AdapterRegistry({ factories: { posti: adapter('posti', posti), chronopost: adapter('chronopost', chronopost) },
      carriers: { posti: 'posti', chronopost: 'chronopost' } }, { trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const url = await started({ tracker: createTracker({ registry, providers: [] }) });
    const s10 = { number: 'RR123456799FI' };
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await (await post(url, s10)).json()).toMatchObject({ carrier: 'posti', source: 'posti', attempts: [{ source: 'posti', kind: 'ok' }] });
    }
    expect(posti).toHaveBeenCalledOnce();
    expect(chronopost).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledOnce();
    // The caller's choice skips recognition and is not answered from the automatic lookup.
    expect(await (await post(url, { ...s10, carrier: 'posti' })).json()).toMatchObject({ carrier: 'posti', source: 'posti' });
    expect(posti).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup among inputs the tracker reads alike, whatever their country hint', async () => {
    const track = vi.fn().mockResolvedValue(answer);
    const url = await started({ tracker: tracker(track) });
    const alike = [{ ...input, countryHint: 'FR' }, input, input, { ...input, countryHint: 'CH' }, { ...input, countryHint: null },
      { ...input, postcode: null, trackingUrl: '', phoneDigits: '  ', language: '' },
      // The tracker reads a postcode's country only beside a postcode.
      { ...input, postcode: ' ', postcodeCountry: 'es' }];
    for (const parcel of alike) expect((await post(url, parcel)).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(1);
    // The hint changes no lookup, so a shared one is not handed one caller's.
    expect(track.mock.calls[0]![0]).not.toHaveProperty('countryHint');
    // It is still checked.
    expect((await post(url, { ...input, countryHint: 7 })).status).toBe(400);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('keeps apart each field that changes access or language, as the tracker reads it', async () => {
    const track = vi.fn().mockResolvedValue(answer);
    const url = await started({ tracker: tracker(track) });
    const lookups = [
      [{ postcode: '8000' }, { postcode: ' 8000 ' }], [{ postcode: '8001' }],
      [{ trackingUrl: 'https://example.com/a' }, { trackingUrl: 'https://example.com/a ' }], [{ trackingUrl: 'https://example.com/A' }],
      [{ phoneDigits: '1234' }, { phoneDigits: ' 1234' }], [{ phoneDigits: '4321' }],
      // The tracker hands the reader's language on as it came.
      [{ language: 'fr' }], [{ language: 'FR' }],
      [{ postcode: '8000', postcodeCountry: 'CH' }, { postcode: '8000', postcodeCountry: ' ch ' }],
    ];
    for (const [index, parcels] of lookups.entries()) {
      for (const parcel of parcels) expect((await post(url, { ...input, ...parcel })).status).toBe(200);
      expect(track).toHaveBeenCalledTimes(index + 1);
    }
  });

  it("keeps the reader's language in the cache identity and forwards it to the tracker", async () => {
    const track = vi.fn().mockResolvedValue(answer);
    const url = await started({ tracker: tracker(track) });
    for (const language of [undefined, 'fr', 'de-CH', 'fr']) {
      expect((await post(url, { ...input, ...(language ? { language } : {}) })).status).toBe(200);
    }
    expect(track).toHaveBeenCalledTimes(3);
    expect(track.mock.calls[1]![0]).toMatchObject({ language: 'fr' });
    expect(track.mock.calls[2]![0]).toMatchObject({ language: 'de-CH' });
  });

  it("keeps the postcode's country in the cache identity and forwards it to the tracker", async () => {
    const track = vi.fn().mockResolvedValue(answer);
    const url = await started({ tracker: tracker(track) });
    for (const postcodeCountry of [undefined, 'ES', 'BE', 'ES']) {
      expect((await post(url, { ...input, postcode: '28001', ...(postcodeCountry ? { postcodeCountry } : {}) })).status).toBe(200);
    }
    expect(track).toHaveBeenCalledTimes(3);
    expect(track.mock.calls[1]![0]).toMatchObject({ postcodeCountry: 'ES' });
    expect(track.mock.calls[2]![0]).toMatchObject({ postcodeCountry: 'BE' });
  });

  it('expires cached responses and honors the carrier minimum refresh', async () => {
    let time = 0;
    const track = vi.fn().mockResolvedValue({ ...answer, carrier: 'gls-de' });
    const url = await started({ tracker: tracker(track), cacheMs: 1, now: () => time });
    await post(url);
    time = 60_000;
    await post(url);
    expect(track).toHaveBeenCalledTimes(1);
    time = 3_600_001;
    await post(url);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('limits requests and rejects oversized bodies before tracking', async () => {
    const mock = tracker();
    const url = await started({ tracker: mock, rateLimit: 1 });
    const large = await fetch(`${url}/v1/track`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: 'x'.repeat(17_000) }) });
    expect(large.status).toBe(413);
    expect(mock.track).not.toHaveBeenCalled();
    const limited = await post(url);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
  });

  it('counts recognitions and trackings against one concurrency limit', async () => {
    let running = 0, peak = 0, release!: () => void;
    // A held lookup runs until the test releases it; any other answers at once.
    const lookup = (value: unknown, held = false) => async () => {
      peak = Math.max(peak, ++running);
      try { if (held) await new Promise<void>(resolve => { release = resolve; }); return value; }
      finally { running--; }
    };
    const recognition = { carrier: 'ups', choices: [], asked: ['ups'], unanswered: [] };
    const track = vi.fn().mockImplementation(lookup(answer)), recognize = vi.fn().mockImplementation(lookup(recognition));
    const url = await started({ tracker: { ...tracker(track), recognize }, maxConcurrent: 1 });
    const recognized = () => fetch(`${url}/v1/recognize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: input.number }) });
    recognize.mockImplementationOnce(lookup(recognition, true));
    const recognizing = recognized();
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(1));
    expect((await recognized()).status).toBe(429);
    expect((await post(url)).status).toBe(429);
    release();
    expect(await (await recognizing).json()).toEqual(recognition);
    track.mockImplementationOnce(lookup(answer, true));
    const tracking = post(url);
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
    expect((await recognized()).status).toBe(429);
    release();
    expect((await tracking).status).toBe(200);
    expect((await recognized()).status).toBe(200);
    expect((await post(url, { ...input, postcode: '0000' })).status).toBe(200);
    expect([recognize.mock.calls.length, track.mock.calls.length, peak]).toEqual([2, 2, 1]);
  });

  it('keeps a shared lookup running for the clients still waiting when one leaves', async () => {
    let finish!: (value: TrackingResponse) => void, signal!: AbortSignal;
    const track = vi.fn().mockImplementation((_parcel: ParcelInput, context: { signal: AbortSignal }) => {
      signal = context.signal;
      return new Promise<TrackingResponse>(resolve => { finish = resolve; });
    });
    const log = vi.fn();
    const url = await started({ tracker: tracker(track), maxConcurrent: 1, log });
    const before = detections();
    // The client that started the lookup leaves once another waits on it.
    const leaving = new AbortController();
    const leaver = post(url, input, undefined, leaving.signal).catch(() => 'left');
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1));
    const staying = post(url);
    await vi.waitFor(() => expect(detections()).toBe(before + 2));
    leaving.abort();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.objectContaining({ route: '/v1/track', status: 499 })));
    expect(await leaver).toBe('left');
    expect(signal.aborted).toBe(false);
    finish(answer);
    expect(await (await staying).json()).toEqual(answer);
    expect((await post(url)).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('cancels a lookup every waiting client left, frees its slot and remembers nothing of it', async () => {
    const { track, signals } = held();
    const url = await started({ tracker: tracker(track), maxConcurrent: 1 });
    const before = detections();
    const clients = [new AbortController(), new AbortController()];
    const requests = clients.map(client => post(url, input, undefined, client.signal).catch(() => 'left'));
    await vi.waitFor(() => expect(detections()).toBe(before + 2));
    expect(track).toHaveBeenCalledTimes(1);
    for (const client of clients) client.abort();
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    expect(await Promise.all(requests)).toEqual(['left', 'left']);
    // The only slot is free again, and the same parcel is asked again.
    track.mockResolvedValue(answer);
    expect((await post(url, { ...input, postcode: '0000' })).status).toBe(200);
    expect((await post(url)).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(3);
  });

  it('cancels a recognition whose client left and frees its slot', async () => {
    const signals: AbortSignal[] = [];
    const recognize = vi.fn().mockImplementation((_number: string, context: { signal: AbortSignal }) => {
      signals.push(context.signal);
      return new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    });
    const url = await started({ tracker: { ...tracker(), recognize }, maxConcurrent: 1 });
    const leaving = new AbortController();
    const left = fetch(`${url}/v1/recognize`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: input.number }), signal: leaving.signal }).catch(() => 'left');
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(1));
    leaving.abort();
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    expect(await left).toBe('left');
    expect((await post(url)).status).toBe(200);
  });

  it('counts clients behind trusted proxies separately and ignores the header otherwise', async () => {
    const from = (url: string, forwarded: string) => fetch(`${url}/v1/track`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwarded }, body: JSON.stringify(input) });
    const proxied = await started({ tracker: tracker(), rateLimit: 1, trustedProxies: 1 });
    expect((await from(proxied, '198.51.100.7')).status).toBe(200);
    expect((await from(proxied, '198.51.100.8')).status).toBe(200);
    // Entries left of the proxy's own are written by the client and cannot move it to a new bucket.
    expect((await from(proxied, '203.0.113.9, 198.51.100.7')).status).toBe(429);
    expect((await from(proxied, 'not an address')).status).toBe(200);
    // A proxy may add the port it saw; the client is the address alone, whatever the port.
    expect((await from(proxied, '198.51.100.9:4711')).status).toBe(200);
    expect((await from(proxied, '198.51.100.9:4999')).status).toBe(429);
    expect((await from(proxied, '[2001:db8::2]:443')).status).toBe(200);
    expect((await from(proxied, '2001:db8::2')).status).toBe(429);
    expect((await from(proxied, '[2001:db8::3]')).status).toBe(200);
    // Anything else counts against the socket, as 'not an address' already did.
    expect((await from(proxied, '999.1.1.1:80')).status).toBe(429);
    expect((await from(proxied, '[nope]:1')).status).toBe(429);
    const direct = await started({ tracker: tracker(), rateLimit: 1 });
    expect((await from(direct, '198.51.100.7')).status).toBe(200);
    expect((await from(direct, '198.51.100.8')).status).toBe(429);
    expect(() => createTrackingServer({ tracker: tracker(), trustedProxies: -1 })).toThrow(TypeError);
  });

  it('shares a failed lookup briefly, for as long as the upstream asked, but never a spent budget', async () => {
    let time = 0;
    const track = vi.fn().mockRejectedValue(failed('not_found'));
    const url = await started({ tracker: tracker(track), now: () => time, rateLimit: 1_000 });
    expect((await post(url)).status).toBe(404);
    expect((await post(url)).status).toBe(404);
    expect(track).toHaveBeenCalledTimes(1);
    time = 60_001;
    track.mockRejectedValue(failed('rate_limited', 120_000));
    expect((await post(url)).status).toBe(429);
    time += 119_000;
    expect((await post(url)).status).toBe(429);
    expect(track).toHaveBeenCalledTimes(2);
    time += 2_000;
    track.mockRejectedValue(failed('budget'));
    expect((await post(url)).status).toBe(502);
    track.mockResolvedValue(answer);
    expect((await post(url)).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(4);
  });

  it('holds a rate limit beside a source its share cut short, but not an input request the budget may hide an answer behind', async () => {
    const track = vi.fn().mockRejectedValue(new TrackingError(
      [{ source: 'ups', kind: 'rate_limited', durationMs: 1, retryAfterMs: 120_000 }, { source: 'Ship24', kind: 'budget', durationMs: 9 }],
      { kind: 'rate_limited', retryAfterMs: 120_000 }));
    const url = await started({ tracker: tracker(track), rateLimit: 1_000 });
    expect((await post(url)).status).toBe(429);
    expect((await post(url)).status).toBe(429);
    expect(track).toHaveBeenCalledTimes(1);
    track.mockRejectedValue(new TrackingError(
      [{ source: 'ParcelsApp', kind: 'input_required', durationMs: 1 }, { source: 'Ship24', kind: 'budget', durationMs: 9 }],
      { kind: 'input_required', field: 'postcode' }));
    const asking = { ...input, postcode: '0000' };
    expect((await post(url, asking)).status).toBe(400);
    expect((await post(url, asking)).status).toBe(400);
    expect(track).toHaveBeenCalledTimes(3);
  });

  it('remembers no failure of a lookup that ran on the caller\'s own budget', async () => {
    const track = vi.fn().mockRejectedValueOnce(failed('transport')).mockResolvedValue(answer);
    const url = await started({ tracker: tracker(track) });
    expect((await post(url, { ...input, budgetMs: 5 })).status).toBe(502);
    expect((await post(url)).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('remembers no answer whose sources the caller\'s own budget cut short', async () => {
    const cut: TrackingResponse = { ...answer, attempts: [{ source: 'ups', kind: 'ok', durationMs: 1 }, { source: 'Ship24', kind: 'budget', durationMs: 199 }] };
    const track = vi.fn().mockResolvedValueOnce(cut).mockResolvedValue(answer);
    const url = await started({ tracker: tracker(track) });
    expect(await (await post(url, { ...input, budgetMs: 200 })).json()).toMatchObject({ attempts: [{ kind: 'ok' }, { kind: 'budget' }] });
    expect(await (await post(url)).json()).toMatchObject({ attempts: [] });
    expect((await post(url)).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(2);
    // On the server's own budget the same answer is held.
    track.mockResolvedValue(cut);
    expect((await post(url, { ...input, postcode: '0000' })).status).toBe(200);
    expect((await post(url, { ...input, postcode: '0000' })).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(3);
  });

  it('advertises the time until it asks the upstream again, in the header and in the hint', async () => {
    let time = 0;
    const track = vi.fn().mockRejectedValue(failed('rate_limited', 2_000));
    const url = await started({ tracker: tracker(track), now: () => time, rateLimit: 1_000 });
    const advice = async (value: Record<string, unknown> = input) => {
      const response = await post(url, value);
      const { hint } = await response.json() as { hint: { retryAfterMs?: number } };
      return [response.status, response.headers.get('retry-after'), hint.retryAfterMs];
    };
    // The upstream asked for 2 s, but the failure is held for failureCacheMs.
    expect(await advice()).toEqual([429, '60', 60_000]);
    time = 59_001;
    expect(await advice()).toEqual([429, '1', 999]);
    expect(track).toHaveBeenCalledTimes(1);
    time = 60_000;
    track.mockRejectedValue(failed('rate_limited', 120_000));
    expect(await advice()).toEqual([429, '120', 120_000]);
    time += 119_000;
    expect(await advice()).toEqual([429, '1', 1_000]);
    expect(track).toHaveBeenCalledTimes(2);
    // The hold stops at cacheMs; a longer wait the upstream asked for is still what the caller is told.
    time += 1_000;
    track.mockRejectedValue(failed('rate_limited', 3_600_000));
    expect(await advice()).toEqual([429, '3600', 3_600_000]);
    time += 599_999;
    expect(await advice()).toEqual([429, '3001', 3_000_001]);
    expect(track).toHaveBeenCalledTimes(3);
    time += 1;
    track.mockRejectedValue(failed('not_found'));
    expect(await advice()).toEqual([404, '60', 60_000]);
    time += 60_000;
    track.mockRejectedValue(failed('transport'));
    expect(await advice()).toEqual([502, '60', 60_000]);
    // No wait helps with a number the carrier does not issue.
    time += 60_000;
    track.mockRejectedValue(failed('invalid_input'));
    expect(await advice()).toEqual([400, null, undefined]);
    expect(track).toHaveBeenCalledTimes(6);
    // A failure that is not held passes the upstream's advice on as it came.
    track.mockRejectedValue(failed('rate_limited', 2_000));
    expect(await advice({ ...input, postcode: '0000', budgetMs: 5_000 })).toEqual([429, '2', 2_000]);
  });

  it('holds a failure for failureCacheMs when cacheMs is shorter', async () => {
    let time = 0;
    const track = vi.fn().mockRejectedValue(failed('rate_limited', 120_000));
    const url = await started({ tracker: tracker(track), cacheMs: 30_000, now: () => time });
    await post(url);
    time = 59_999;
    await post(url);
    expect(track).toHaveBeenCalledTimes(1);
    time = 60_000;
    await post(url);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('shares the answer that a carrier must be chosen, unless the caller\'s own budget shaped it', async () => {
    let time = 0;
    const undecided = { number: '1234567890' };
    const track = vi.fn().mockRejectedValue(new InputRequiredError('Tracking', 'carrier'));
    const url = await started({ tracker: tracker(track), now: () => time });
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await post(url, undecided);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Additional carrier input required', field: 'carrier' });
    }
    expect(track).toHaveBeenCalledTimes(1);
    time = 60_000;
    await post(url, undecided);
    expect(track).toHaveBeenCalledTimes(2);
    await post(url, { ...undecided, postcode: '0000', budgetMs: 5_000 });
    await post(url, { ...undecided, postcode: '0000', budgetMs: 5_000 });
    expect(track).toHaveBeenCalledTimes(4);
  });

  it('answers a lookup a source needs an input for as the input request it is, held but without a wait to advertise', async () => {
    let time = 0;
    const gated = new TrackingError([{ source: 'ups', kind: 'rate_limited', durationMs: 1, retryAfterMs: 120_000 },
      { source: 'ParcelsApp', kind: 'input_required', durationMs: 1 }, { source: 'UPU', kind: 'not_found', durationMs: 1 }],
    { kind: 'input_required', field: 'postcode', carrier: 'ups', retryAfterMs: 120_000 });
    const track = vi.fn().mockRejectedValue(gated);
    const url = await started({ tracker: tracker(track), now: () => time });
    const response = await post(url);
    expect(response.status).toBe(400);
    expect(response.headers.get('retry-after')).toBeNull();
    expect(await response.json()).toEqual({ error: gated.message, field: 'postcode', carrier: 'ups', attempts: gated.attempts, hint: gated.hint });
    // The same request gets the same answer until the carrier's wait is over; the input makes it another.
    time = 119_999;
    expect((await post(url)).status).toBe(400);
    expect(track).toHaveBeenCalledTimes(1);
    track.mockResolvedValue(answer);
    expect((await post(url, { ...input, postcode: '0000' })).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(2);
  });

  it('leaves a carrier that failed alone for its own after-failure interval, whoever answered last', async () => {
    let time = 0;
    const outage = new TrackingError([{ source: 'gls-de', kind: 'transport', durationMs: 1 }, { source: 'UPU', kind: 'not_found', durationMs: 1 }], { kind: 'not_found' });
    const track = vi.fn().mockRejectedValue(outage);
    const url = await started({ tracker: tracker(track), now: () => time });
    const first = await post(url);
    expect(first.status).toBe(404);
    expect(first.headers.get('retry-after')).toBe('14400');
    time = 240 * 60_000 - 1;
    await post(url);
    expect(track).toHaveBeenCalledTimes(1);
    // The carrier saying it does not know the parcel is an answer, held no longer than any other.
    time += 1;
    track.mockRejectedValue(failed('not_found', undefined, 'gls-de'));
    await post(url);
    time += 59_999;
    await post(url);
    expect(track).toHaveBeenCalledTimes(2);
    time += 1;
    await post(url);
    expect(track).toHaveBeenCalledTimes(3);
  });

  it('gives up expired entries before a live answer when the cache is full', async () => {
    let time = 0;
    const track = vi.fn(async (parcel: ParcelInput): Promise<TrackingResponse> => {
      if (parcel.postcode === undefined) return { ...answer, carrier: 'gls-de' };
      throw failed('not_found');
    });
    const url = await started({ tracker: tracker(track), now: () => time, rateLimit: 2_000, maxConcurrent: 1_000 });
    const lookups = () => track.mock.calls.filter(([parcel]) => parcel.postcode === undefined).length;
    await post(url);
    for (let batch = 0; batch < 999; batch += 111) {
      await Promise.all(Array.from({ length: 111 }, (_, index) => post(url, { ...input, postcode: String(batch + index) })));
    }
    expect(track).toHaveBeenCalledTimes(1_000);
    time = 60_001;
    await post(url, { ...input, postcode: 'one more' });
    await post(url);
    expect(lookups()).toBe(1);
  });

  it('returns safe failure hints and never logs input or upstream messages', async () => {
    const log = vi.fn();
    const track = vi.fn().mockRejectedValue(new TrackingError([{ source: 'ups', kind: 'rate_limited', durationMs: 1 }], { kind: 'rate_limited', retryAfterMs: 2_000 }));
    const url = await started({ tracker: tracker(track), log });
    const response = await post(url);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toMatchObject({ hint: { kind: 'rate_limited' } });
    expect(JSON.stringify(log.mock.calls)).not.toContain(input.number);
    expect(log.mock.calls[0]![0]).toMatchObject({ route: '/v1/track', status: 429 });
    track.mockRejectedValue(new Error(`private ${input.number}`));
    const unexpected = await post(url, { ...input, postcode: '0000' });
    expect(unexpected.status).toBe(502);
    expect(JSON.stringify(await unexpected.json())).not.toContain(input.number);
  });
});
