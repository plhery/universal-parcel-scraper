import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import { TrawlClient } from '../../core/transport/index.js';
import { sendsThrough } from '../../core/transport/transportOf.js';
import { MondialRelayTracker } from './adapter.js';
import { MONDIAL_RELAY_APP_API, MondialRelayAppClient, parseMondialRelayApp } from './app.js';

// The app client's own HTTP/1.1 transport; no test here reaches the network through it.
vi.mock('node:https', async (importOriginal) => ({ ...await importOriginal<typeof import('node:https')>(), request: vi.fn() }));

// All identifiers, tokens, clocks, places and barcodes here are invented.
const SHIPMENT = '12345678';
const UID = `45${SHIPMENT}`;
const POSTCODE = '75001';
const REFRESH = 'SYNTHETIC_REFRESH_TOKEN';
const ACCESS = 'synthetic.access.token';
const RENEWED = 'synthetic.renewed.token';
const BARCODE = '45123456780100000000000000';
const SECRET = 'VCzt4PzS8ynJE2yy7zNBiQbTE3pkncqEyvrUsCDbXupGn8yqRrPDov2FYiAVfuUx';
const TOKEN_URL = 'https://account.inpost-group.com/oauth2/token';
const NOW = Date.UTC(2026, 0, 3, 10, 0);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

function expedition(uid = UID, hint = 'En cours de livraison') {
  return { shipmentId: 1, tracingCode: 'TST', tracingDate: '2026-01-02T15:00:00Z', markNumCode: 45, stepSection: 2, stepHint: hint,
    hasProblem: false, locker: false, numberOfParcels: 1, shipmentUid: uid };
}

function detail(uid = UID, hint?: string) {
  return [{ expedition: expedition(uid, hint), delivery: { code: 'PRIVATE_RELAY', country: 'FR', agencyCode: 1 }, detail: {
    currentStep: 3, calculatedBarCode: BARCODE, steps: [
      { number: 5, status: 'Colis livré au destinataire', date: null, events: [] },
      { number: 4, status: 'Colis disponible au point de retrait', date: null, events: [] },
      { number: 3, status: "Colis sur l'agence de livraison", date: '2026-01-02T15:00:00Z', events: [
        { label: 'Colis en cours de livraison', date: '2026-01-03T06:00:00Z' },
        { label: 'Colis en cours de traitement sur le site EXAMPLE TOWN', date: '2026-01-02T15:00:00Z' },
        { label: 'Colis en cours de traitement sur le site EXAMPLE TOWN', date: '2026-01-02T15:00:00Z' },
      ] },
      { number: 1, status: 'Colis en préparation', date: '2026-01-01T08:00:00Z', events: [
        { label: "Colis en cours de préparation par l'expéditeur", date: '2026-01-01T08:00:00Z' },
        { label: 'Undated label', date: null },
      ] },
    ],
  } }];
}

interface Call { url: URL; method: string; headers: Headers; body: string }

/** Answers the token, search and detail routes from their queues, then from defaults. */
function service(replies: { token?: Array<() => Response>; search?: Array<() => Response>; detail?: Array<() => Response> } = {}) {
  const calls: Call[] = [];
  let clock = NOW;
  const fetcher = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: String(init?.body ?? '') });
    const route = url.href === TOKEN_URL ? 'token' : url.href.startsWith(`${MONDIAL_RELAY_APP_API}parcels-search?`) ? 'search'
      : url.href.startsWith(`${MONDIAL_RELAY_APP_API}parcels-detail?`) ? 'detail' : '';
    const queued = route ? replies[route]?.shift() : undefined;
    if (queued) return Promise.resolve(queued());
    if (route === 'token') return Promise.resolve(json({ access_token: ACCESS, expires_in: 7199, refresh_token: REFRESH, id_token: 'PRIVATE_ID_TOKEN' }));
    if (route === 'search') return Promise.resolve(json({ list: [{ expedition: expedition(), delivery: {} }], pageIndex: 1, totalPages: 1 }));
    if (route === 'detail') return Promise.resolve(json(detail()));
    return Promise.reject(new Error('Unexpected request'));
  }) as typeof fetch;
  const client = new MondialRelayAppClient({ refreshToken: REFRESH, fetcher, userAgent: 'Host/1.0', now: () => clock });
  const track = (shipment = SHIPMENT, postcode = POSTCODE, signal = new AbortController().signal) =>
    client.track({ shipment, postcode }, { signal, timeoutMs: 1_000 });
  return { calls, client, fetcher, track, advance: (ms: number) => { clock += ms; } };
}

describe('Mondial Relay app service', () => {
  it('renews the account token, signs each request and projects the history on Paris clocks', async () => {
    const { calls, track } = service();
    const result = await track();
    expect(calls.map(call => `${call.method} ${call.url.pathname}`)).toEqual(['POST /oauth2/token', 'GET /api/parcels-search', 'GET /api/parcels-detail']);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ client_id: 'mondialrelay-mobile', grant_type: 'refresh_token', refresh_token: REFRESH });
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ shipmentUid: SHIPMENT, postcode: POSTCODE });
    expect(Object.fromEntries(calls[2]!.url.searchParams)).toEqual({ shipmentUids: UID, parcelType: 'received' });
    for (const call of calls.slice(1)) {
      const nonce = call.headers.get('X-MR-Param1')!;
      expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(call.headers.get('X-MR-Param2')).toBe(String(NOW / 1000));
      expect(call.headers.get('X-MR-API-KEY')).toBe(sha256(sha256(`${SECRET}${nonce}${NOW / 1000}`)));
      expect(call.headers.get('Authorization')).toBe(`Bearer ${ACCESS}`);
      expect(call.headers.get('User-Agent')).toBe('Host/1.0');
    }
    expect(calls[1]!.headers.get('X-MR-Param1')).not.toBe(calls[2]!.headers.get('X-MR-Param1'));
    expect(result).toEqual({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'En cours de livraison',
      last_update: '2026-01-03T07:00:00+01:00', expected_delivery: null, timezone: 'Europe/Paris', source: 'mondial_relay_app',
      events: [
        { time: '2026-01-03T07:00:00+01:00', location: '', description: 'Colis en cours de livraison', stage: 'out_for_delivery' },
        { time: '2026-01-02T16:00:00+01:00', location: 'EXAMPLE TOWN', description: 'Colis en cours de traitement sur le site EXAMPLE TOWN', stage: 'in_transit' },
        { time: '2026-01-01T09:00:00+01:00', location: '', description: "Colis en cours de préparation par l'expéditeur", stage: 'registered' },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|0100000000000000/);
  });

  it('names the delivery point only while the parcel waits there', async () => {
    const point = (address: Record<string, unknown>) => ({ deliveryPointId: 'PRIVATE_POINT_ID', locker: true,
      imageUrl: 'PRIVATE_IMAGE', businessHours: [{ PRIVATE_HOURS: true }], address: { latitude: 1.5, longitude: 2.5, ...address } });
    const parse = (hint: string, deliveryPointModel: unknown) => {
      const [parcel] = detail(UID, hint) as unknown as [{ detail: Record<string, unknown> }];
      Object.assign(parcel.detail, { deliveryPointModel, pinCode: 'PRIVATE_PIN', printQrCode: 'PRIVATE_QR' });
      return parseMondialRelayApp([parcel], UID);
    };
    const locker = point({ line1: 'EXAMPLE LOCKER', line2: '', line3: '1 EXAMPLE STREET', line4: null, postcode: '00000', city: 'EXAMPLE CITY', country: 'FR' });
    const waiting = parse('Colis disponible au Locker', locker);
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'EXAMPLE LOCKER\n1 EXAMPLE STREET\n00000 EXAMPLE CITY' });
    expect(JSON.stringify(waiting)).not.toMatch(/PRIVATE|1\.5|2\.5/);
    expect(parse('Colis disponible au Locker', point({ line1: 'EXAMPLE LOCKER', city: 'EXAMPLE CITY' })).pickup_point).toBe('EXAMPLE LOCKER');
    expect(parse('Colis disponible au Locker', point({ line1: '', line3: '1 EXAMPLE STREET', city: 'EXAMPLE CITY' })).pickup_point).toBeUndefined();
    expect(parse('Colis disponible au Locker', undefined).pickup_point).toBeUndefined();
    expect(parse('Livré', locker).pickup_point).toBeUndefined();
    expect(parse('En cours de livraison', locker).pickup_point).toBeUndefined();
  });

  it('searches the longer forms by their shipment and a label barcode by its brand and shipment alone', async () => {
    const { calls, track } = service();
    await track(`${UID}01`, POSTCODE);
    await track(UID, '');
    expect(calls.filter(call => call.url.pathname.endsWith('search')).map(call => Object.fromEntries(call.url.searchParams)))
      .toEqual([{ shipmentUid: SHIPMENT, postcode: POSTCODE }, { shipmentUid: UID }]);
  });

  it('keeps the access token until it is about to expire, and renews it once for concurrent lookups', async () => {
    const { calls, track, advance } = service({ token: [() => json({ access_token: ACCESS, expires_in: 7199 }), () => json({ access_token: RENEWED, expires_in: 7199 })] });
    await Promise.all([track(), track()]);
    await track();
    expect(calls.filter(call => call.url.href === TOKEN_URL)).toHaveLength(1);
    advance(7_199_000 - 59_000);
    await track();
    expect(calls.filter(call => call.url.href === TOKEN_URL)).toHaveLength(2);
    expect(calls.at(-1)!.headers.get('Authorization')).toBe(`Bearer ${RENEWED}`);
  });

  it('renews a rejected access token once, then reports the refusal', async () => {
    const refused = () => json({ message: 'Unauthorized' }, 401);
    const renewedOnce = service({ search: [refused], token: [() => json({ access_token: ACCESS, expires_in: 7199 }), () => json({ access_token: RENEWED, expires_in: 7199 })] });
    await expect(renewedOnce.track()).resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(renewedOnce.calls.map(call => call.url.pathname)).toEqual(['/oauth2/token', '/api/parcels-search', '/oauth2/token', '/api/parcels-search', '/api/parcels-detail']);
    expect(renewedOnce.calls[3]!.headers.get('Authorization')).toBe(`Bearer ${RENEWED}`);

    const refusedTwice = service({ search: [refused, refused] });
    await expect(refusedTwice.track()).rejects.toMatchObject({ kind: 'challenge', message: 'Mondial Relay app tracking failed (challenge)' });
  });

  it('reports a refused sign-in without the token, the bearer or the postcode', async () => {
    const { calls, track } = service({ token: [() => json({ error: 'invalid_grant' }, 400)] });
    const error = await track().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'challenge', provider: 'Mondial Relay' });
    expect(calls).toHaveLength(1);
    const reported = JSON.stringify(error, Object.getOwnPropertyNames(error));
    for (const secret of [REFRESH, ACCESS, POSTCODE]) expect(reported).not.toContain(secret);

    const failing = service({ search: [() => new Response('<html>busy</html>', { status: 500 })] });
    const upstream = await failing.track().catch((caught: unknown) => caught);
    expect(upstream).toMatchObject({ kind: 'indeterminate', status: 500 });
    expect(JSON.stringify(upstream, Object.getOwnPropertyNames(upstream))).not.toMatch(new RegExp(`${ACCESS}|${POSTCODE}|Bearer`));
  });

  it('leaves a search that does not single out the parcel inconclusive', async () => {
    const searched = (...uids: string[]) => () => json({ list: uids.map(uid => ({ expedition: expedition(uid), delivery: {} })) });
    for (const reply of [searched(), searched(UID, `55${SHIPMENT}`), searched(`45${SHIPMENT.replace('1', '9')}`)]) {
      const { calls, track } = service({ search: [reply] });
      await expect(track()).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(calls.some(call => call.url.pathname.endsWith('detail'))).toBe(false);
    }
    // The same parcel listed twice is still one parcel.
    await expect(service({ search: [searched(UID, UID)] }).track()).resolves.toMatchObject({ status: 'out_for_delivery' });
    // A 10-digit number names its brand: another brand's shipment is a different parcel.
    await expect(service({ search: [searched(`55${SHIPMENT}`)] }).track(UID, '')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('reads the headline, then the history, then the reached milestone', () => {
    expect(parseMondialRelayApp(detail(UID, 'Livré'), UID)).toMatchObject({ status: 'out_for_delivery', last_status_text: 'Livré' });
    const quiet = detail(UID, 'Livré');
    quiet[0]!.detail.steps = [{ number: 4, status: 'Étape quatre', date: '2026-01-02T15:00:00Z', events: [] }];
    expect(parseMondialRelayApp(quiet, UID)).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', events: [], last_update: null });
    quiet[0]!.detail.steps = [];
    expect(() => parseMondialRelayApp(quiet.map(entry => ({ ...entry, expedition: expedition(UID, '') })), UID)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMondialRelayApp(detail(), `55${SHIPMENT}`)).toThrow('different shipment');
    expect(() => parseMondialRelayApp({ steps: [] }, UID)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the drop-off\'s stage while the headline names the leg to the agency before any scan of it', () => {
    const dropped = detail(UID, 'En transit vers notre agence');
    const dropOff = { label: 'Colis pris en charge en Point Relais', date: '2026-01-02T15:00:00Z' };
    const steps = (events: typeof dropOff[]) => [
      { number: 3, status: "Colis sur l'agence de livraison", date: null, events: [] },
      { number: 2, status: 'Colis pris en charge', date: '2026-01-02T15:00:00Z', events },
    ];
    dropped[0]!.detail.steps = steps([dropOff]);
    expect(parseMondialRelayApp(dropped, UID))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'En transit vers notre agence' });
    dropped[0]!.detail.steps = steps([{ label: 'Colis expédié depuis le site logistique', date: '2026-01-03T06:00:00Z' }, dropOff]);
    expect(parseMondialRelayApp(dropped, UID)).toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads the merchant\'s receipt as the end of a return the scans started', () => {
    const back = detail(UID, "Votre colis a été livré à l'enseigne.");
    back[0]!.detail.steps = [{ number: 2, status: 'Colis pris en charge', date: '2026-01-02T15:00:00Z', events: [
      { label: "Colis en retour à l'expéditeur", date: '2026-01-02T15:00:00Z' },
    ] }];
    const result = parseMondialRelayApp(back, UID);
    expect(result.events?.[0]?.stage).toBe('returned');
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned' });
  });

  it('dates a delivery at its delivery scan', () => {
    const delivered = detail(UID, '');
    delivered[0]!.detail.steps = [
      { number: 5, status: 'Colis livré au destinataire', date: '2026-01-03T09:30:00Z', events: [
        { label: 'Colis livré au destinataire', date: '2026-01-03T09:30:00Z' },
      ] },
      { number: 3, status: "Colis sur l'agence de livraison", date: '2026-01-02T15:00:00Z', events: [
        { label: 'Colis en cours de traitement sur le site EXAMPLE TOWN', date: '2026-01-02T15:00:00Z' },
      ] },
    ];
    expect(parseMondialRelayApp(delivered, UID)).toMatchObject({ status: 'delivered', delivered_at: '2026-01-03T10:30:00+01:00' });
    expect(parseMondialRelayApp(detail(), UID)).not.toHaveProperty('delivered_at');
  });

  it('reads the last leg of a home delivery as out for delivery where its milestone is dated', () => {
    const home = detail(UID, '');
    home[0]!.detail.steps = [
      { number: 5, status: 'Colis livré au destinataire', date: null, events: [] },
      { number: 4, status: 'Colis en cours de livraison', date: '2026-01-03T06:00:00Z', events: [
        { label: 'Colis en route vers le point de livraison', date: '2026-01-03T06:00:00Z' },
        { label: 'Colis expédié depuis le site EXAMPLE TOWN', date: '2026-01-03T06:00:00Z' },
      ] },
      { number: 3, status: "Colis sur l'agence de livraison", date: '2026-01-02T15:00:00Z', events: [
        { label: 'Colis en route vers le point de livraison', date: '2026-01-02T15:00:00Z' },
      ] },
    ];
    expect(parseMondialRelayApp(home, UID).events?.map((event) => [event.description, event.stage])).toEqual([
      ['Colis en route vers le point de livraison', 'out_for_delivery'],
      ['Colis expédié depuis le site EXAMPLE TOWN', 'in_transit'],
      ['Colis en route vers le point de livraison', 'in_transit'],
    ]);
  });

  it('stops waiting for a renewal when the lookup is cancelled', async () => {
    const stalled = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const client = new MondialRelayAppClient({ refreshToken: REFRESH, fetcher: stalled, now: () => NOW });
    const controller = new AbortController();
    const cancelled = new Error('caller cancelled');
    const lookup = client.track({ shipment: SHIPMENT, postcode: POSTCODE }, { signal: controller.signal, timeoutMs: 60_000 });
    controller.abort(cancelled);
    await expect(lookup).rejects.toBe(cancelled);
  });
});

describe('Mondial Relay app step', () => {
  const trawlServiceUrl = 'http://trawl.internal:8191/scrape';

  it('answers from the app and links the postcode-free tracking page, with no browser for a parcel no longer on its way', async () => {
    for (const hint of ['Colis disponible au Locker', 'Colis livré au destinataire']) {
      const { client } = service({ detail: [() => json(detail(UID, hint))] });
      const browser = vi.fn<typeof fetch>(() => Promise.reject(new Error('no browser')));
      const result = await new MondialRelayTracker({ app: client, trawl: new TrawlClient(trawlServiceUrl, browser), fetcher: browser })
        .fetch(SHIPMENT, POSTCODE);
      expect(result).toMatchObject({ tracking_source: 'mobile-app-response', expected_delivery: null,
        tracking_url: `https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${SHIPMENT}` });
      expect(browser).not.toHaveBeenCalled();
    }
  });

  it('adds the website’s estimate to the app’s answer for a parcel on its way, which stands without it', async () => {
    const website = JSON.parse(readFileSync(new URL('./fixtures/available-at-relay.json', import.meta.url), 'utf8')) as { Expedition: Record<string, unknown> };
    website.Expedition.Numero = SHIPMENT;
    const replies = [
      { tier: 3, statusCode: 200, url: 'https://www.mondialrelay.fr/suivi-de-colis/', html: '<div id="tracking" token="SYNTHETIC_PAGE_TOKEN_1234567890"></div>' },
      { tier: 3, statusCode: 200, url: `https://www.mondialrelay.fr/api/tracking?shipment=${SHIPMENT}&postcode=${POSTCODE}&brand=&codePays=fr`, html: `<pre>${JSON.stringify(website)}</pre>` },
    ];
    const browser = vi.fn<typeof fetch>(() => Promise.resolve(json(replies.shift())));
    const { client } = service();
    const app = await new MondialRelayTracker({ app: client, trawl: null }).fetch(SHIPMENT, POSTCODE);
    const result = await new MondialRelayTracker({ app: service().client, trawl: new TrawlClient(trawlServiceUrl, browser), fetcher: browser })
      .fetch(SHIPMENT, POSTCODE);
    // The website's two requests, then only its estimate: the app's history, status and source stay.
    expect(browser).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ...app, expected_delivery: '2026-08-31' });

    const failing = vi.fn<typeof fetch>(() => Promise.reject(new Error('browser unavailable')));
    await expect(new MondialRelayTracker({ app: service().client, trawl: new TrawlClient(trawlServiceUrl, failing), fetcher: failing })
      .fetch(SHIPMENT, POSTCODE)).resolves.toEqual(app);
    expect(failing).toHaveBeenCalled();
  });

  it('answers from the app without an estimate when the website hangs past the estimate’s time', async () => {
    const app = await new MondialRelayTracker({ app: service().client, trawl: null }).fetch(SHIPMENT, POSTCODE);
    // A browser service that never answers: only the lookup's own signal ends its request.
    const hanging = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = performance.now();
    const result = await new MondialRelayTracker({ app: service().client, trawl: new TrawlClient(trawlServiceUrl, hanging), fetcher: hanging,
      estimateTimeoutMs: 50 }).fetch(SHIPMENT, POSTCODE, { budgetMs: 60_000 });
    expect(hanging).toHaveBeenCalled();
    expect(result).toEqual(app);
    // The estimate's time ended the wait, not the browser service failing at once.
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('keeps the caller’s estimate in place of the website’s while its day is ahead and no newer scan shows', async () => {
    const website = JSON.parse(readFileSync(new URL('./fixtures/available-at-relay.json', import.meta.url), 'utf8')) as { Expedition: Record<string, unknown> };
    website.Expedition.Numero = SHIPMENT;
    const browserFor = () => {
      const replies = [
        { tier: 3, statusCode: 200, url: 'https://www.mondialrelay.fr/suivi-de-colis/', html: '<div id="tracking" token="SYNTHETIC_PAGE_TOKEN_1234567890"></div>' },
        { tier: 3, statusCode: 200, url: `https://www.mondialrelay.fr/api/tracking?shipment=${SHIPMENT}&postcode=${POSTCODE}&brand=&codePays=fr`, html: `<pre>${JSON.stringify(website)}</pre>` },
      ];
      return vi.fn<typeof fetch>(() => Promise.resolve(json(replies.shift())));
    };
    const app = await new MondialRelayTracker({ app: service().client, trawl: null }).fetch(SHIPMENT, POSTCODE);
    const lookup = (knownEstimate: { expectedDelivery: string; lastUpdate: string | null }, now = NOW) => {
      const browser = browserFor();
      const tracker = new MondialRelayTracker({ app: service().client, trawl: new TrawlClient(trawlServiceUrl, browser), fetcher: browser, now: () => now });
      return tracker.fetch(SHIPMENT, POSTCODE, { knownEstimate }).then((result) => ({ result, browser }));
    };
    // The day is ahead and the caller's estimate came with the app's newest scan: no browser.
    const kept = await lookup({ expectedDelivery: '2026-01-05', lastUpdate: app.last_update ?? null });
    expect(kept.browser).not.toHaveBeenCalled();
    expect(kept.result).toEqual({ ...app, expected_delivery: '2026-01-05' });
    // A newer scan than the caller saw, a day that has come, or a malformed day asks the website.
    for (const [known, now] of [
      [{ expectedDelivery: '2026-01-05', lastUpdate: '2026-01-02T07:00:00+01:00' }, NOW],
      [{ expectedDelivery: '2026-01-05', lastUpdate: null }, NOW],
      [{ expectedDelivery: '2026-01-03', lastUpdate: app.last_update ?? null }, NOW],
      [{ expectedDelivery: '2026-01-05', lastUpdate: app.last_update ?? null }, Date.UTC(2026, 0, 4, 23, 30)],
      [{ expectedDelivery: '05/01/2026', lastUpdate: app.last_update ?? null }, NOW],
    ] as const) {
      const asked = await lookup(known, now);
      expect(asked.browser, JSON.stringify(known)).toHaveBeenCalledTimes(2);
      expect(asked.result.expected_delivery).toBe('2026-08-31');
    }
  });

  it('searches the app with a Portuguese postcode as the website takes it, hyphenated', async () => {
    const { calls, client } = service();
    await expect(new MondialRelayTracker({ app: client, trawl: null }).fetch(SHIPMENT, '1000001', {}, 'PT'))
      .resolves.toMatchObject({ tracking_source: 'mobile-app-response' });
    const search = calls.find(call => call.url.pathname.endsWith('search'))!;
    expect(Object.fromEntries(search.url.searchParams)).toEqual({ shipmentUid: SHIPMENT, postcode: '1000-001' });
  });

  it('asks the app for a label barcode without the stored postcode', async () => {
    // The checksummed public sample barcode from adapter.test.ts: brand 12, shipment 12399999.
    const barcode = '12123999999999999999999987';
    const uid = '1212399999';
    const { calls, client } = service({ search: [() => json({ list: [{ expedition: expedition(uid), delivery: {} }] })], detail: [() => json(detail(uid))] });
    await expect(new MondialRelayTracker({ app: client, trawl: null }).fetch(barcode, POSTCODE))
      .resolves.toMatchObject({ status: 'out_for_delivery', tracking_source: 'mobile-app-response' });
    const search = calls.find(call => call.url.pathname.endsWith('search'))!;
    expect(Object.fromEntries(search.url.searchParams)).toEqual({ shipmentUid: uid });
  });

  it('keeps its app client on its HTTP/1.1 transport under a host fetcher', async () => {
    // A host fetcher, such as a proxy-routing one, may offer HTTP/2, which the bot screen refuses.
    const host = vi.fn<typeof fetch>(() => Promise.reject(new Error('host fetcher used')));
    vi.mocked(request).mockImplementation((() => {
      const outgoing = new EventEmitter();
      return Object.assign(outgoing, { end: () => outgoing.emit('error', new Error('offline')) });
    }) as unknown as typeof request);
    for (const fetcher of [host, sendsThrough(host, host)]) {
      vi.mocked(request).mockClear();
      await expect(new MondialRelayTracker({ appRefreshToken: REFRESH, fetcher, trawl: null })
        .fetch(SHIPMENT, POSTCODE)).rejects.toMatchObject({ kind: 'transport' });
      expect(vi.mocked(request).mock.calls[0]?.[0]).toBe(TOKEN_URL);
    }
    expect(host).not.toHaveBeenCalled();
  });

  it('hands every app failure to the website', async () => {
    const failures: Array<Parameters<typeof service>[0]> = [
      { search: [() => json({ list: [] })] },
      { token: [() => json({ error: 'invalid_grant' }, 400)] },
      { search: [() => new Response('', { status: 503 })] },
      { search: [() => json({ message: 'slow down' }, 429)] },
      { search: [() => json({ list: 'odd' })] },
      { detail: [() => json(detail(`55${SHIPMENT}`))] },
    ];
    for (const failure of failures) {
      const { client } = service(failure);
      let reached = 0;
      const browser = (() => { reached += 1; return Promise.reject(new Error('browser unavailable')); }) as typeof fetch;
      await expect(new MondialRelayTracker({ app: client, trawl: new TrawlClient(trawlServiceUrl, browser), fetcher: browser }).fetch(SHIPMENT, POSTCODE)).rejects.toThrow();
      expect(reached).toBeGreaterThan(0);
    }
  });
});
