import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DPD_DE_APP_API, DpdAppService } from './service.js';

// All credentials, sessions, shop ids and addresses here are invented.
const PARTNER = { name: 'Synthetic Partner', token: 'SYNTHETIC_TOKEN', password: 'SYNTHETIC_PASSWORD' };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/app-${name}.xml`, import.meta.url), 'utf8');
const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });
/** A Swiss shop's record: the service gives its street and town in capitals. */
const swissShop = () => xml(fixture('shop').replace('DE00001', 'CH00001').replace('Musterstr.', 'BEISPIELWEG')
  .replace('<ZipCode>00000</ZipCode>', '<ZipCode>0000</ZipCode>').replace('Musterstadt', 'BEISPIELDORF'));
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
  return { calls, shops: new DpdAppService({ partner: PARTNER, fetcher }) };
}

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
