import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { DPD_DE_APP_API, DPD_DE_APP_RAIL, DPD_DE_APP_SCANS, DpdDeAppClient } from './app.js';

// All identifiers, credentials, sessions, clocks and private-field markers here are invented.
const NUMBER = '01000000000001';
const PARTNER = { name: 'Synthetic Partner', token: 'SYNTHETIC_TOKEN', password: 'SYNTHETIC_PASSWORD' };
const NOW = Date.UTC(2026, 0, 3, 10, 0);
const fixture = (name: string) => readFileSync(new URL(`./fixtures/app-${name}.xml`, import.meta.url), 'utf8');
const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });
const failure = (operation: string, ...codes: string[]) => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>`
  + `<${operation}Response xmlns="https://cloud.dpd.com/"><${operation}Result><Ack>false</Ack><ErrorDataList>`
  + codes.map(code => `<ErrorData><ErrorID>1</ErrorID><ErrorCode>${code}</ErrorCode><ErrorMsg>PRIVATE_MARKER</ErrorMsg></ErrorData>`).join('')
  + `</ErrorDataList></${operation}Result></${operation}Response></soap:Body></soap:Envelope>`;

interface Call { operation: string; body: string; headers: Headers; signal?: AbortSignal | null }

/** Answers each operation from its queue, then from its fixture. */
function service(replies: Record<string, Array<() => Response | Promise<Response>>> = {}) {
  const calls: Call[] = [];
  const fetcher = ((url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(DPD_DE_APP_API);
    const headers = new Headers(init?.headers);
    const operation = /^"https:\/\/cloud\.dpd\.com\/(\w+)"$/.exec(headers.get('SOAPAction') ?? '')?.[1] ?? '';
    calls.push({ operation, body: String(init?.body), headers, signal: init?.signal });
    const queued = replies[operation]?.shift();
    if (queued) return Promise.resolve(queued());
    const name = { getSessionFullState: 'session', getTrackingData: 'tracking', getTrackingScanList: 'scans' }[operation];
    return name ? Promise.resolve(xml(fixture(name))) : Promise.reject(new Error('Unexpected operation'));
  }) as typeof fetch;
  const client = new DpdDeAppClient({ partner: PARTNER, fetcher, userAgent: 'Host/1.0', now: () => NOW });
  const track = (signal = new AbortController().signal) => client.track(NUMBER, { signal, timeoutMs: 1_000 });
  return { calls, client, fetcher, replies, track };
}

describe('DPD Germany app service', () => {
  it('opens a session, binds the parcel and projects scans with their established clocks', async () => {
    const { calls, track } = service();
    const result = await track();
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getTrackingData', 'getTrackingScanList']);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'Unfortunately we have not been able to deliver your parcel.', last_update: '2026-01-03T09:40:00+01:00', weight_kg: 2.5 });
    expect(result.events).toEqual([
      { time: '2026-01-03T09:40:00+01:00', location: 'Musterstadt, DE', description: 'Unfortunately we have not been able to deliver your parcel.', stage: 'failed_attempt', stage_source: 'carrier_map' },
      { time: '2026-01-03T06:10:00+01:00', location: 'Musterstadt, DE', description: 'Out for delivery.', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-01-03T03:55:00+01:00', location: 'Musterstadt, DE', description: 'At parcel delivery centre.', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-02T17:39:00', provider_time_text: '02.01.2026 17:39', location: 'Musterville, FR', description: 'In transit.', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-01-01T13:29:00', provider_time_text: '01.01.2026 13:29', description: 'Order information has been transmitted to DPD.', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SYNTHETIC|estimated/);
  });

  it('signs each call for its operation and minute and sends the host identity', async () => {
    const { calls, track } = service();
    await track();
    for (const call of calls) {
      const key = `4800${createHash('md5').update(`4800${PARTNER.name}0${call.operation}${PARTNER.password}`).digest('base64').slice(0, 16)}`;
      expect(call.body).toContain(`<PartnerCredentials><Name>${PARTNER.name}</Name><Token>${PARTNER.token}</Token><KeyPhase>${key}</KeyPhase></PartnerCredentials>`);
      expect(call.headers.get('user-agent')).toBe('Host/1.0');
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls[1]!.body).toContain(`<ParcelNo>${NUMBER}</ParcelNo><DeliveryZipCode></DeliveryZipCode><UpdateNewDeliveryData>false</UpdateNewDeliveryData>`
      + '<addParcelIfNoTrackingdataAvailable>false</addParcelIfNoTrackingdataAvailable>');
    expect(calls[0]!.body).not.toMatch(/PushToken|Pixel/);
  });

  it('keeps one session across lookups and shares the one being opened', async () => {
    const { calls, track } = service();
    await Promise.all([track(), track()]);
    await track();
    expect(calls.filter(call => call.operation === 'getSessionFullState')).toHaveLength(1);
    expect(calls.filter(call => call.operation === 'getTrackingData')).toHaveLength(3);
  });

  it('replaces an expired session once', async () => {
    const expired = () => xml(failure('getTrackingData', 'ERROR_SESSION_NOT_VALID'));
    const { calls, track } = service({ getTrackingData: [expired] });
    expect((await track()).events).toHaveLength(5);
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getTrackingData', 'getSessionFullState', 'getTrackingData', 'getTrackingScanList']);
    const stuck = service({ getTrackingData: [expired, expired] });
    await expect(stuck.track()).rejects.toMatchObject({ kind: 'transport' });
    expect(stuck.calls).toHaveLength(4);
  });

  it.each([
    ['a refused partner', () => xml(failure('getSessionFullState', 'ERROR_PARTNER', 'ERROR_KEYPHASE')), 'challenge'],
    ['a refused key', () => xml(failure('getSessionFullState', 'ERROR_KEYPHASE')), 'challenge'],
    ['an unusable session', () => xml(fixture('session').replace(/<SessionToken>[^<]*/, '<SessionToken>no')), 'schema'],
    ['a document type', () => xml(`<!DOCTYPE x>${fixture('session')}`), 'schema'],
    ['a page', () => xml('<html>PRIVATE_MARKER</html>'), 'schema'],
    ['a SOAP fault', () => xml('PRIVATE_MARKER', 500), 'indeterminate'],
    ['a missing endpoint', () => xml('', 404), 'transport'],
    ['a refusal', () => xml('', 403), 'challenge'],
    ['a rate limit', () => new Response('', { status: 429, headers: { 'retry-after': '120' } }), 'rate_limited'],
  ])('reports %s without tracking and without its contents', async (_, reply, kind) => {
    const { calls, track } = service({ getSessionFullState: [reply] });
    const error = await track().catch((caught: unknown) => caught) as Error & { kind: string; retryAfterMs?: number };
    expect(error).toMatchObject({ kind, ...(kind === 'rate_limited' ? { retryAfterMs: 120_000 } : {}) });
    expect(calls).toHaveLength(1);
    expect(`${JSON.stringify(error)}${error.message}`).not.toMatch(/PRIVATE_MARKER|SYNTHETIC/);
    expect(error).not.toHaveProperty('request');
  });

  it.each([
    ['another parcel', (body: string) => body.replace(`<TrackingData>\n          <ParcelNo>${NUMBER}`, '<TrackingData>\n          <ParcelNo>01000000000002'), { kind: 'schema' }],
    ['another country', (body: string) => body.replace('<Country>DE</Country></ShipAddress>', '<Country>GB</Country></ShipAddress>'), { kind: 'indeterminate', reason: 'other_country' }],
    ['no tracking data', () => failure('getTrackingData', 'ERROR_TRACKING_PARCELNO_NO_TRACKINGDATA'), { kind: 'indeterminate' }],
  ])('does not project %s', async (_, change, expected) => {
    const { track } = service({ getTrackingData: [() => xml(change(fixture('tracking')))] });
    await expect(track()).rejects.toMatchObject(expected);
  });

  it.each([
    ['no scans', (body: string) => body.replace(/<TrackingScan>[\s\S]*<\/TrackingScan>/, ''), 'indeterminate'],
    ['only an announced day', (body: string) => body.replace(/<TrackingScan>[\s\S]*<\/TrackingScan>/,
      '<TrackingScan><ScanDate>03.01.2026</ScanDate><ScanTime>06:00</ScanTime><StatusText>Your parcel is estimated to be delivered on: Saturday</StatusText></TrackingScan>'), 'indeterminate'],
    ['a refused list', () => failure('getTrackingScanList', 'ERROR_UNKNOWN'), 'indeterminate'],
    ['an invalid clock', (body: string) => body.replace('<ScanTime>13:29</ScanTime>', '<ScanTime>25:99</ScanTime>'), 'schema'],
    ['an invalid day', (body: string) => body.replace('<ScanDate>01.01.2026</ScanDate>', '<ScanDate>2026-01-01</ScanDate>'), 'schema'],
    ['an unworded scan', (body: string) => body.replace('<StatusText>In transit.</StatusText>', '<StatusText></StatusText>'), 'schema'],
  ])('does not turn %s into tracking success', async (_, change, kind) => {
    const { track } = service({ getTrackingScanList: [() => xml(change(fixture('scans')))] });
    await expect(track()).rejects.toMatchObject({ kind });
  });

  it('leaves unknown wording unstaged, hides delivery prose and reads the status from the rail', async () => {
    const scans = fixture('scans').replace('Unfortunately we have not been able to deliver your parcel.', 'Delivered to PRIVATE NEIGHBOUR')
      .replace('Unfortunately we have not been able to deliver your parcel.', 'A future notice')
      .replace('<Location>Musterstadt (DE)</Location>\n            <ServiceCode>101</ServiceCode>\n            <TrackingScanAdditionalList><TrackingScanAdditionalType><AdditionalCode>999', '<Location>Elsewhere</Location>\n            <ServiceCode>101</ServiceCode>\n            <TrackingScanAdditionalList><TrackingScanAdditionalType><AdditionalCode>999');
    const { track } = service({ getTrackingScanList: [() => xml(scans)] });
    const result = await track();
    expect(result.events?.[0]).toEqual({ local_time: '2026-01-03T09:40:00', provider_time_text: '03.01.2026 09:40', description: 'A future notice' });
    expect(result.events?.[1]).toEqual({ time: '2026-01-03T09:40:00+01:00', location: 'Musterstadt, DE', description: 'Delivery update' });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: null, last_update_local: '2026-01-03T09:40:00' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('ends a lookup with its signal, and the opening with the last lookup that asked for it', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const { calls, track } = service({ getSessionFullState: [() => new Promise<Response>(() => undefined)] });
    const pending = [track(first.signal), track(second.signal)];
    first.abort(new Error('Cancelled'));
    await expect(pending[0]).rejects.toThrow('Cancelled');
    expect(calls[0]!.signal?.aborted).toBe(false);
    second.abort(new Error('Cancelled too'));
    await expect(pending[1]).rejects.toThrow('Cancelled too');
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('stops waiting for an opening session after its wait, without a request', async () => {
    let open!: () => void;
    const { calls, client } = service({ getSessionFullState: [() => new Promise<Response>((resolve) => { open = () => resolve(xml(fixture('session'))); })] });
    const signal = new AbortController().signal;
    await expect(client.track(NUMBER, { signal, timeoutMs: 1_000, sessionWaitMs: 0 })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_opening' });
    expect(calls).toHaveLength(1);
    open();
    expect((await client.track(NUMBER, { signal, timeoutMs: 1_000, sessionWaitMs: 0 })).events).toHaveLength(5);
    expect(calls.filter(call => call.operation === 'getSessionFullState')).toHaveLength(1);
  });
});

describe('DPD Germany app vocabulary', () => {
  const recorded = (JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as {
    entries: Array<{ code?: string; wording: string; stage?: string; note?: string }>;
  }).entries.filter(entry => entry.note?.includes('German app'));

  it('maps every recorded scan wording and rail state to its recorded stage', () => {
    const scans = recorded.filter(entry => !entry.code);
    const rail = recorded.filter(entry => entry.code);
    expect(Object.fromEntries(scans.map(entry => [entry.wording, entry.stage]))).toEqual(DPD_DE_APP_SCANS);
    expect(Object.fromEntries(rail.map(entry => [entry.code, entry.stage]))).toEqual(
      Object.fromEntries(Object.entries(DPD_DE_APP_RAIL).map(([code, mapped]) => [code, mapped.stage])));
  });
});

describe('DPD Germany tiers', () => {
  const delivered = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as unknown;
  const guest = (reply: Response) => [
    Response.json({ fid: 'synthetic-fid', authToken: { token: 'synthetic-installation', expiresIn: '604800s' } }),
    Response.json({ entries: { basic_dpd_token: 'c3ludGhldGljOnRva2Vu' } }),
    Response.json({ access_token: 'synthetic-access', expires_in: 3600 }),
    reply,
  ];
  function tiers(replies: Response[]) {
    const app = service();
    const steps: Array<[string, string]> = [];
    const fetcher = ((url: string | URL, init?: RequestInit) => String(url) === DPD_DE_APP_API
      ? app.fetcher(url, init) : Promise.resolve(replies.shift() ?? new Response('', { status: 500 }))) as typeof fetch;
    const tracking = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {},
      recorder: { ...NOOP_RECORDER, step: event => { steps.push([event.step, event.outcome]); } } });
    return { app, steps, tracking };
  }

  it('declares the app service before the guest protocol', () => {
    expect(tiers([]).tracking.steps).toEqual(['app', 'direct']);
  });

  it('answers from the app service without a postcode, without asking the guest protocol', async () => {
    const replies = guest(Response.json({}));
    const { steps, tracking } = tiers(replies);
    const result = await tracking.track({ number: NUMBER });
    expect(result).toMatchObject({ status: 'in_transit', tracking_url: `https://tracking.dpd.de/status/en_US/parcel/${NUMBER}` });
    expect(result.events).toHaveLength(5);
    expect(steps).toEqual([['app', 'ok']]);
    expect(replies).toHaveLength(4);
  });

  it.each([
    ['is down', () => xml('', 503), 'maintenance'],
    ['refuses its credential', () => xml(failure('getSessionFullState', 'ERROR_PARTNER')), 'challenge'],
    ['limits the rate', () => new Response('', { status: 429 }), 'rate_limited'],
  ])('answers from the guest protocol when the app service %s', async (_, reply, outcome) => {
    const { app, steps, tracking } = tiers(guest(Response.json(delivered)));
    app.replies.getSessionFullState = [reply];
    expect((await tracking.track({ number: NUMBER })).status).toBe('delivered');
    expect(steps).toEqual([['app', outcome], ['direct', 'ok']]);
  });

  it('lets the guest protocol answer while the session opens, then reads the app service', async () => {
    let open!: () => void;
    const { app, steps, tracking } = tiers(guest(Response.json(delivered)));
    app.replies.getSessionFullState = [() => new Promise<Response>((resolve) => { open = () => resolve(xml(fixture('session'))); })];
    expect((await tracking.track({ number: NUMBER }, { budgetMs: 15_000 })).status).toBe('delivered');
    expect(steps).toEqual([['app', 'indeterminate'], ['direct', 'ok']]);
    open();
    expect((await tracking.track({ number: NUMBER }, { budgetMs: 15_000 })).events).toHaveLength(5);
    expect(steps.at(-1)).toEqual(['app', 'ok']);
  });

  it('does not ask the guest protocol about a delivery the app service places in another country', async () => {
    const replies = guest(Response.json(delivered));
    const { app, steps, tracking } = tiers(replies);
    app.replies.getTrackingData = [() => xml(fixture('tracking').replace('<Country>DE</Country></ShipAddress>', '<Country>GB</Country></ShipAddress>'))];
    await expect(tracking.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'other_country' });
    expect(steps).toEqual([['app', 'indeterminate']]);
    expect(replies).toHaveLength(4);
  });

  it.each([
    ['fails', () => [new Response('', { status: 500 })], 'indeterminate'],
    ['has no history yet', () => guest(Response.json({ parcelNumber: NUMBER, status: { description: 'PARCEL_HANDED' }, parcelHistory: [] })), 'indeterminate'],
    ['changes shape', () => guest(Response.json({ parcelNumber: NUMBER })), 'schema'],
  ])('with a postcode, answers from the app service when the guest protocol %s', async (_, replies, outcome) => {
    const { steps, tracking } = tiers(replies());
    const result = await tracking.track({ number: NUMBER, postcode: '10115' });
    expect(result).toMatchObject({ status: 'in_transit', tracking_url: `https://tracking.dpd.de/status/en_US/parcel/${NUMBER}` });
    expect(result.events).toHaveLength(5);
    expect(steps).toEqual([['direct', outcome], ['app', 'ok']]);
  });

  it.each([
    ['a missing parcel', () => guest(new Response('', { status: 404 })), 'not_found'],
    ['another country', () => guest(Response.json({ parcelNumber: NUMBER, status: { description: 'DELIVERED', countryCode: 'CH' },
      parcelHistory: [{ description: 'DELIVERED', eventDateAndTime: '2026-01-03T10:00:00+01:00' }] })), 'indeterminate'],
  ])('with a postcode, does not ask the app service about %s', async (_, replies, kind) => {
    const { app, steps, tracking } = tiers(replies());
    await expect(tracking.track({ number: NUMBER, postcode: '10115' })).rejects.toMatchObject({ kind });
    expect(app.calls).toHaveLength(0);
    expect(steps.map(([step]) => step)).toEqual(['direct']);
  });
});
