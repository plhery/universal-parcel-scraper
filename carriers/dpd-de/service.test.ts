import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DPD_DE_APP_API, DpdAppService, sharedDpdAppService, type DpdSession } from './service.js';

// All credentials, sessions, shop ids and addresses here are invented.
const PARTNER = { name: 'Synthetic Partner', token: 'SYNTHETIC_TOKEN', password: 'SYNTHETIC_PASSWORD' };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/app-${name}.xml`, import.meta.url), 'utf8');
const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });
/** A Swiss shop's record: the service gives its street and town in capitals. */
const swissShop = () => xml(fixture('shop').replace('DE00001', 'CH00001').replace('Musterstr.', 'BEISPIELWEG')
  .replace('<ZipCode>00000</ZipCode>', '<ZipCode>0000</ZipCode>').replace('Musterstadt', 'BEISPIELDORF'));
/** The service's answer for a shop id no shop has: no error, and nothing confirmed. */
const unconfirmed = () => xml('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
  + '<getParcelShopByIDResponse xmlns="https://cloud.dpd.com/"><getParcelShopByIDResult><Ack>false</Ack><ErrorDataList />'
  + '</getParcelShopByIDResult></getParcelShopByIDResponse></soap:Body></soap:Envelope>');
const expired = () => xml('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
  + '<getParcelShopByIDResponse xmlns="https://cloud.dpd.com/"><getParcelShopByIDResult><Ack>false</Ack><ErrorDataList>'
  + '<ErrorData><ErrorID>1</ErrorID><ErrorCode>ERROR_SESSION_NOT_VALID</ErrorCode><ErrorMsg>Session</ErrorMsg></ErrorData>'
  + '</ErrorDataList></getParcelShopByIDResult></getParcelShopByIDResponse></soap:Body></soap:Envelope>');

interface Call { operation: string; body: string; signal?: AbortSignal | null }

/** Answers each operation from its queue, then with a session or the Swiss shop. */
function service(replies: Record<string, Array<() => Response | Promise<Response>>> = {}) {
  const calls: Call[] = [];
  const fetcher = ((url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(DPD_DE_APP_API);
    const operation = /^"https:\/\/cloud\.dpd\.com\/(\w+)"$/.exec(new Headers(init?.headers).get('SOAPAction') ?? '')?.[1] ?? '';
    calls.push({ operation, body: String(init?.body), signal: init?.signal });
    const queued = replies[operation]?.shift();
    if (queued) return Promise.resolve(queued());
    if (operation === 'getSessionFullState') return Promise.resolve(xml(fixture('session')));
    return operation === 'getParcelShopByID' ? Promise.resolve(swissShop()) : Promise.reject(new Error('Unexpected operation'));
  }) as typeof fetch;
  return { calls, fetcher, shops: new DpdAppService({ partner: PARTNER, fetcher }) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A session reply with its own token. */
const session = (token: string) => () => xml(fixture('session').replace(/<SessionToken>[^<]*/, `<SessionToken>${token}`));
const opened = (calls: Call[]) => calls.filter(call => call.operation === 'getSessionFullState').length;
const tokenOf = (call: Call | undefined) => /<SessionToken>([^<]*)</.exec(call?.body ?? '')?.[1];

describe('DPD app service shop lookup', () => {
  it('reads a shop by its PUDO id, as the app asks for it', async () => {
    const { calls, shops } = service();
    await expect(shops.parcelShop('CH00001', { signal: new AbortController().signal, timeoutMs: 1_000 })).resolves.toEqual({
      name: 'Kiosk Muster', address: 'BEISPIELWEG 1\n0000 BEISPIELDORF',
    });
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getParcelShopByID']);
    expect(calls[1]!.body).toContain('<ParcelShopID>0</ParcelShopID><PudoID>CH00001</PudoID><ParcelShopOnly>false</ParcelShopOnly>');
  });

  it('replaces an expired session once, then answers nothing', async () => {
    const signal = new AbortController().signal;
    const renewed = service({ getParcelShopByID: [expired] });
    await expect(renewed.shops.parcelShop('CH00001', { signal, timeoutMs: 1_000 })).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(renewed.calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getParcelShopByID', 'getSessionFullState', 'getParcelShopByID']);
    const stuck = service({ getParcelShopByID: [expired, expired] });
    await expect(stuck.shops.parcelShop('CH00001', { signal, timeoutMs: 1_000 })).resolves.toBeUndefined();
    expect(stuck.calls).toHaveLength(4);
  });

  it('answers nothing while the session opens, and keeps opening it for the next lookup', async () => {
    let open!: () => void;
    const { calls, shops } = service({ getSessionFullState: [() => new Promise<Response>((resolve) => { open = () => resolve(xml(fixture('session'))); })] });
    const signal = new AbortController().signal;
    await expect(shops.parcelShop('CH00001', { signal, timeoutMs: 1 })).resolves.toBeUndefined();
    expect(calls[0]!.signal?.aborted).toBe(false);
    open();
    await expect(shops.parcelShop('CH00001', { signal, timeoutMs: 1_000 })).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(calls.filter(call => call.operation === 'getSessionFullState')).toHaveLength(1);
  });

  it('ends with its signal', async () => {
    const controller = new AbortController();
    const { shops } = service({ getParcelShopByID: [() => { controller.abort(new Error('Cancelled')); return xml('', 503); }] });
    await expect(shops.parcelShop('CH00001', { signal: controller.signal, timeoutMs: 1_000 })).rejects.toThrow('Cancelled');
  });
});

describe('DPD app service session', () => {
  afterEach(() => { vi.useRealTimers(); });
  const lookup = (shops: DpdAppService, signal = new AbortController().signal) => shops.parcelShop('CH00001', { signal, timeoutMs: 1_000 });

  it('renews a session used past eight hours, answering with the current one meanwhile', async () => {
    vi.useFakeTimers();
    let open!: () => void;
    const { calls, shops } = service({ getSessionFullState: [session('U0VTU0lPTl9GSVJTVF9PTkU='),
      () => new Promise<Response>((resolve) => { open = () => resolve(session('U0VTU0lPTl9TRUNPTkRfT05F')()); })] });
    await lookup(shops);
    await vi.advanceTimersByTimeAsync(8 * HOUR - 1);
    await lookup(shops);
    expect(opened(calls)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup(shops)).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(opened(calls)).toBe(2);
    expect(tokenOf(calls.at(-1))).toBe('U0VTU0lPTl9GSVJTVF9PTkU=');
    open();
    await vi.advanceTimersByTimeAsync(0);
    await lookup(shops);
    expect(opened(calls)).toBe(2);
    expect(tokenOf(calls.at(-1))).toBe('U0VTU0lPTl9TRUNPTkRfT05F');
    // Without `keep`, nothing waits on a timer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a session open without a lookup, and opens the next before it lapses', async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    let open!: () => void;
    const { calls, shops } = service({ getSessionFullState: [
      () => new Promise<Response>((resolve) => { open = () => resolve(session('U0VTU0lPTl9GSVJTVF9PTkU=')()); }),
      session('U0VTU0lPTl9TRUNPTkRfT05F'),
    ] });
    shops.keep();
    expect(opened(calls)).toBe(1);
    // A lookup that stops waiting leaves the opening running.
    const controller = new AbortController();
    const waiting = shops.parcelShop('CH00001', { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort(new Error('Cancelled'));
    await expect(waiting).rejects.toThrow('Cancelled');
    expect(calls[0]!.signal?.aborted).toBe(false);
    open();
    await vi.advanceTimersByTimeAsync(0);
    await lookup(shops);
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getParcelShopByID']);
    await vi.advanceTimersByTimeAsync(8 * HOUR);
    expect(opened(calls)).toBe(2);
    await lookup(shops);
    expect(tokenOf(calls.at(-1))).toBe('U0VTU0lPTl9TRUNPTkRfT05F');
    // The renewal timer never holds the process open.
    const renewals = timers.mock.calls.flatMap(([, ms], index) => (ms ?? 0) > 2 * MINUTE
      ? [timers.mock.results[index]!.value as ReturnType<typeof setTimeout>] : []);
    expect(renewals.length).toBeGreaterThan(0);
    expect(renewals.every(timer => !timer.hasRef())).toBe(true);
    // Without a store, the session it replaced is not checked.
    expect(calls.filter(call => call.operation === 'getParcelShopByID')).toHaveLength(2);
  });

  it('tries a kept session again a quarter of an hour after a failed opening', async () => {
    vi.useFakeTimers();
    const { calls, shops } = service({ getSessionFullState: [() => xml('', 503)] });
    shops.keep();
    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(opened(calls)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened(calls)).toBe(2);
    await lookup(shops);
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getSessionFullState', 'getParcelShopByID']);
  });

  const SAVED = 'U0FWRURfU0VTU0lPTl9PTkU=';
  const OLDER = 'T0xERVJfU0VTU0lPTl9PTkU=';
  const FIXTURE = 'U1lOVEhFVElDX1NFU1NJT05fMDAwMQ==';
  /** A host's store, holding these sessions. */
  const memory = (sessions: DpdSession[] = []) => {
    const saves: DpdSession[] = [];
    return { saves, store: { load: vi.fn(async () => sessions), save: vi.fn(async (session: DpdSession) => { saves.push(session); }) } };
  };
  const checks = (calls: Call[]) => calls.filter(call => call.body.includes('<PudoID>XX0000</PudoID>')).map(tokenOf);

  it('takes up the saved session after a restart, until it is eight hours old', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { calls, shops } = service();
    const { saves, store } = memory([{ token: SAVED, openedAt: start - 2 * HOUR }, { token: OLDER, openedAt: start - 30 * HOUR }]);
    shops.keep(store);
    // A lookup waits for the store rather than opening a session of its own.
    await lookup(shops);
    expect(opened(calls)).toBe(0);
    expect(tokenOf(calls.at(-1))).toBe(SAVED);
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
    expect(opened(calls)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened(calls)).toBe(1);
    expect(saves.filter(saved => saved.token === FIXTURE)).toEqual([{ token: FIXTURE, openedAt: start + 6 * HOUR }]);
    await lookup(shops);
    expect(tokenOf(calls.at(-1))).toBe(FIXTURE);
    // The older one was followed from the start, and the one taken up once replaced.
    expect(checks(calls).slice(0, 6)).toEqual(Array(6).fill(OLDER));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(checks(calls).slice(6)).toContain(SAVED);
  });

  it('checks a session no longer used every hour until the service refuses it twice, and saves what it finds', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { calls, shops } = service({ getParcelShopByID: [unconfirmed, expired, unconfirmed, () => xml('', 503), expired, expired] });
    const { saves, store } = memory([{ token: SAVED, openedAt: start - 9 * HOUR, checkedAt: start - 2 * HOUR }]);
    shops.keep(store);
    await vi.advanceTimersByTimeAsync(0);
    // Too old to take up: the next one opens, and the saved one is followed.
    expect(opened(calls)).toBe(1);
    expect(saves).toEqual([{ token: FIXTURE, openedAt: start }]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(checks(calls)).toEqual([SAVED]);
    expect(saves.at(-1)).toEqual({ token: SAVED, openedAt: start - 9 * HOUR, checkedAt: start + HOUR });
    // One refusal is not enough: while slow, the service refuses a session it accepts again later.
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(saves.at(-1)).toEqual({ token: SAVED, openedAt: start - 9 * HOUR, checkedAt: start + 3 * HOUR });
    // A reply that is not about the session says nothing.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(saves).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(saves.at(-1)).toEqual({ token: SAVED, openedAt: start - 9 * HOUR, checkedAt: start + 3 * HOUR, refusedAt: start + 5 * HOUR });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(checks(calls)).toHaveLength(6);
  });

  it('follows a session the service refused during a lookup, and checks several sessions apart', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { calls, shops } = service({ getSessionFullState: [session(SAVED)], getParcelShopByID: [expired] });
    const { saves, store } = memory([{ token: OLDER, openedAt: start - 20 * HOUR }]);
    shops.keep(store);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await expect(lookup(shops)).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(opened(calls)).toBe(2);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(HOUR - 10 * MINUTE);
    expect(checks(calls)).toEqual([OLDER]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checks(calls)).toEqual([OLDER, SAVED]);
    // The swiss shop answers the check: the service accepts the session after all.
    expect(saves.at(-1)).toEqual({ token: SAVED, openedAt: start, checkedAt: start + HOUR + 5_000 });
  });

  it('opens a session as before when the store fails, answers late or cannot save', async () => {
    vi.useFakeTimers();
    const failing = service();
    failing.shops.keep({ load: () => Promise.reject(new Error('Unavailable')), save: () => Promise.reject(new Error('Unavailable')) });
    await vi.advanceTimersByTimeAsync(0);
    expect(opened(failing.calls)).toBe(1);
    const late = service();
    late.shops.keep({ load: () => new Promise<never>(() => {}), save: () => { throw new Error('Unavailable'); } });
    await vi.advanceTimersByTimeAsync(5_000 - 1);
    expect(opened(late.calls)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened(late.calls)).toBe(1);
    await lookup(late.shops);
    expect(late.calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getParcelShopByID']);
    // A lookup that stops waiting for the store ends with its signal.
    const waiting = service();
    waiting.shops.keep({ load: () => new Promise<never>(() => {}), save: async () => {} });
    const controller = new AbortController();
    const pending = waiting.shops.parcelShop('CH00001', { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort(new Error('Cancelled'));
    await expect(pending).rejects.toThrow('Cancelled');
  });

  it('is one per transport and user agent in the process', () => {
    const { fetcher } = service();
    expect(sharedDpdAppService({ fetcher })).toBe(sharedDpdAppService({ fetcher, userAgent: undefined }));
    expect(sharedDpdAppService({ fetcher })).not.toBe(sharedDpdAppService({ fetcher: service().fetcher }));
    expect(sharedDpdAppService({ fetcher })).not.toBe(sharedDpdAppService({ fetcher, userAgent: 'Host/1.0' }));
  });
});
