import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter as dpdBe } from '../dpd-be/adapter.js';
import { adapter as dpdHu } from '../dpd-hu/adapter.js';
import { adapter as dpdNl } from '../dpd-nl/adapter.js';
import { adapter } from './adapter.js';
import { JADLOG_SITE_URL } from './site.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic: a 14-digit number of DPD's shape that neither Jadlog's tracker nor Geopost knows.
const NUMBER = '10089999999991';
type Reply = Record<string, unknown> & { status: Record<string, unknown>; parcelHistory: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Reply;
const CAPABILITIES = (JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')) as { capabilities: string[] }).capabilities;

/** Jadlog's tracker sends a number it does not know to its error page. */
const unlisted = () => new Response(null, { status: 302, headers: { location: 'https://www.jadlog.com.br/jadlog/erroRastreio' } });
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html;charset=UTF-8' } });

/**
 * Jadlog's tracker answers `site`; Geopost's guest service answers the login a cold tracker goes
 * through, then `replies`.
 */
function routed(site: () => Response | Promise<Response>, ...replies: Response[]) {
  const geopost = [
    Response.json({ fid: 'synthetic-fid', authToken: { token: 'synthetic-installation', expiresIn: '604800s' } }),
    Response.json({ entries: { basic_dpd_token: 'c3ludGhldGljOnRva2Vu' } }), // gitleaks:allow
    Response.json({ access_token: 'synthetic-access', expires_in: 3600 }),
    ...replies,
  ];
  return vi.fn<typeof fetch>(async (url) => {
    if (String(url) === JADLOG_SITE_URL) return site();
    const reply = geopost.shift();
    if (!reply) throw new Error(`unexpected request to ${String(url)}`);
    return reply;
  });
}
/** A number Jadlog's tracker does not list, then Geopost's replies. */
const guest = (...replies: Response[]) => routed(unlisted, ...replies);
/** The requests made to Geopost's guest service. */
const geopostCalls = (fetcher: ReturnType<typeof routed>) => fetcher.mock.calls.filter(([url]) => String(url) !== JADLOG_SITE_URL);
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
const jadlog = (fetcher: typeof fetch) => adapter(environment(fetcher));
const placed = (countryCode: string | undefined, reply = fixture('delivered.json')) => Response.json({ ...reply, status: { ...reply.status, countryCode } });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>';

describe("Jadlog through Geopost's guest service, when its tracker does not list the parcel", () => {
  it("reads a registered order from Jadlog's business unit, without a postcode, and omits recipient data", async () => {
    const reply = fixture('registered.json');
    reply.receiver = { name: 'Private Recipient', address: { streetName: 'Private Street', zipCode: '00000-000' } };
    const fetcher = guest(Response.json(reply));
    const result = await jadlog(fetcher).track({ number: NUMBER });

    expect(result).toMatchObject({
      status: 'pending', current_stage: 'registered', last_status_text: 'Order created', expected_delivery: null,
      last_update: '2026-03-10T19:56:00-03:00', source: 'mydpd_guest_api', history_truncated: true,
      tracking_url: 'https://www.jadlog.com.br/jadlog/home',
    });
    // Geopost states the offset with each milestone: the scan keeps it.
    expect(result.events).toEqual([expect.objectContaining({
      time: '2026-03-10T19:56:00-03:00', stage: 'registered', provider_code: 'ORDER_CREATED', description: 'Order created',
    })]);
    expect(JSON.stringify(result)).not.toMatch(/Private|00000-000/);

    const remoteConfig = JSON.parse(String(geopostCalls(fetcher)[1]![1]!.body)) as Record<string, unknown>;
    expect(remoteConfig.countryCode).toBe('BR');
    const url = new URL(String(geopostCalls(fetcher)[3]![0]));
    expect(url.pathname).toBe(`/concept/webservice/v10/parcels/details/${NUMBER}`);
    expect(url.searchParams.get('businessUnit')).toBe('JADLOG');
    expect(url.searchParams.get('continueWithoutVerification')).toBe('true');
    expect(url.searchParams.has('dataForVerification')).toBe(false);
    // Jadlog's tracker first, which does not list the order.
    expect(String(fetcher.mock.calls[0]![0])).toBe(JADLOG_SITE_URL);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('reads a delivered parcel with its milestones newest first', async () => {
    const result = await jadlog(guest(Response.json(fixture('delivered.json')))).track({ number: NUMBER });
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', delivered_at: '2026-03-13T14:21:00-03:00', expected_delivery: null,
    });
    expect(result.events?.map(event => event.provider_code)).toEqual([
      'DELIVERED', 'PARCEL_OUT_FOR_DELIVERY', 'AT_DELIVERY_CENTER', 'IN_TRANSIT', 'PARCEL_HANDED', 'ORDER_CREATED',
    ]);
    // Jadlog delivers in Brazil itself: no unit takes the parcel over.
    expect(result.delivery_carrier).toBeUndefined();
  });

  it('returns every declared capability across the fixtures', async () => {
    const produced = new Set<string>();
    for (const name of ['registered.json', 'delivered.json', 'site-delivered.html', 'site-transit.html']) {
      const fetcher = name.endsWith('.html') ? routed(() => html(page(name))) : guest(Response.json(fixture(name)));
      const result = await jadlog(fetcher).track({ number: NUMBER });
      if (result.events?.length) produced.add('history');
      if (result.expected_delivery) produced.add('eta');
      if (result.delivered_at) produced.add('delivered_at');
      if (result.events?.some(event => event.provider_code)) produced.add('provider_code');
      if (result.delivery_carrier) produced.add('delivery_partner');
    }
    expect([...produced].sort()).toEqual([...CAPABILITIES].sort());
  });

  it('reads a clock Geopost names no zone for in Brasília time', async () => {
    // Brazil kept summer time until 2019: only its own zone reads a December 2018 clock at -02:00.
    const reply = fixture('registered.json');
    reply.parcelHistory = [{ ...reply.parcelHistory[0], eventDateAndTime: '2018-12-01T12:00:00', eventDateAndTimeZoneId: null }];
    const result = await jadlog(guest(Response.json(reply))).track({ number: NUMBER });
    expect(result.events?.[0]?.time).toBe('2018-12-01T12:00:00-02:00');
  });

  it.each([
    { name: 'a 400 typed PARCEL_NOT_FOUND', reply: () => Response.json({ error: 'ParcelException', exceptionType: 'PARCEL_NOT_FOUND' }, { status: 400 }) },
    { name: 'a details 404', reply: () => new Response('', { status: 404 }) },
  ])('reads $name as not found', async ({ reply }) => {
    await expect(jadlog(guest(reply())).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([
    { name: 'with HTTP 403', reply: () => new Response(CHALLENGE, { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }) },
    { name: 'with HTTP 200', reply: () => new Response(CHALLENGE, { status: 200, headers: { 'content-type': 'text/html' } }) },
  ])("reports Cloudflare's challenge page $name as a challenge", async ({ reply }) => {
    const fetcher = guest(reply());
    await expect(jadlog(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    // No page tier follows the guest API.
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('reports a rate limit with the wait Geopost asks for', async () => {
    const reply = new Response('', { status: 429, headers: { 'retry-after': '30' } });
    await expect(jadlog(guest(reply)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });

  it.each([
    { name: 'another parcel', payload: { ...fixture('registered.json'), parcelNumber: '10089999999992', shipmentId: '10089999999992' }, kind: 'schema' },
    { name: 'empty history', payload: { ...fixture('registered.json'), parcelHistory: [] }, kind: 'indeterminate' },
  ])('rejects $name rather than manufacturing tracking success', async ({ payload, kind }) => {
    await expect(jadlog(guest(Response.json(payload))).track({ number: NUMBER })).rejects.toMatchObject({ kind });
  });

  it('refuses a number Geopost does not issue before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(jadlog(fetcher).track({ number: '1000000000000' })).rejects.toMatchObject({ kind: 'invalid_input',
      message: expect.stringMatching(/^Jadlog tracking numbers must contain 14 digits/) });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Jadlog's tracker", () => {
  it('posts the number as the form does and reads every row, newest first, on its wall clock', async () => {
    const fetcher = routed(() => html(page('site-delivered.html')));
    const result = await jadlog(fetcher).track({ number: NUMBER });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.jadlog.com.br/jadlog/rastreio');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(String(init!.body)).toBe(`cte=${NUMBER}`);
    // Geopost is not asked.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Produto entregue com sucesso.',
      last_update: null, last_update_local: '2026-03-13T14:21', expected_delivery: null, tracking_url: 'https://www.jadlog.com.br/jadlog/home',
    });
    expect(result.history_truncated).toBeUndefined();
    expect(result.events?.map(event => [event.local_time, event.stage, event.stage_source])).toEqual([
      ['2026-03-13T14:21', 'delivered', 'carrier_map'],
      ['2026-03-12T07:30', 'in_transit', 'carrier_map'],
      ['2026-03-10T22:05', 'in_transit', 'carrier_map'],
      // Collected from the Jadlog point the sender left it at.
      ['2026-03-09T16:40', 'accepted', 'carrier_map'],
      ['2026-03-09T10:15', 'accepted', 'carrier_map'],
    ]);
    expect(result.events?.every(event => event.time === undefined && event.location === undefined && event.provider_code === undefined)).toBe(true);
  });

  it('reads a delivery row before another round to the address as transit', async () => {
    const rows = page('site-delivered.html').replace('Seu produto está em transferência interna para Jadlog destino.', 'Produto entregue com sucesso.');
    const result = await jadlog(routed(() => html(rows))).track({ number: NUMBER });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'in_transit', 'in_transit', 'accepted', 'accepted']);
    expect(result.events?.[2]).toMatchObject({ description: 'Produto entregue com sucesso.', stage_source: 'carrier_map' });
  });

  it('reads a wording no map knows through the shared rules, or leaves it unstaged', async () => {
    const rows = page('site-transit.html').replace('Seu produto está em transferência interna para Jadlog destino.', 'Aguardando instruções do remetente');
    const result = await jadlog(routed(() => html(rows))).track({ number: NUMBER });
    expect(result.events?.[0]).toEqual({ local_time: '2026-03-10T09:53', description: 'Aguardando instruções do remetente' });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Aguardando instruções do remetente' });
  });

  it('asks Geopost when the tracker does not list the number, and reports the number neither knows as not found', async () => {
    await expect(jadlog(guest(Response.json(fixture('registered.json')))).track({ number: NUMBER }))
      .resolves.toMatchObject({ current_stage: 'registered', source: 'mydpd_guest_api' });
    await expect(jadlog(guest(new Response('', { status: 404 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([
    { name: "Cloudflare's challenge", site: () => html(CHALLENGE, 403), kind: 'challenge' },
    { name: 'another number', site: () => html(page('site-transit.html').replace(`consulta: ${NUMBER}`, 'consulta: 10089999999992')), kind: 'schema' },
    { name: 'a page without its result', site: () => html('<html><body>Rastreamento</body></html>'), kind: 'schema' },
    { name: 'a redirect home', site: () => new Response(null, { status: 302, headers: { location: '/jadlog/home' } }), kind: 'indeterminate' },
    { name: 'a sender\'s several shipments', site: () => html(page('site-transit.html').replace('<div class="panel-group', '<div id="heading20000000000002"></div><div class="panel-group')), kind: 'indeterminate' },
    { name: 'a shipment without rows', site: () => html(page('site-transit.html').replace(/class="txt-status"/g, 'class="txt-other"')), kind: 'indeterminate' },
    { name: 'a server error', site: () => html('', 500), kind: 'error' },
    { name: 'a network failure', site: () => Promise.reject(new TypeError('fetch failed')), kind: 'transport' },
  ])('falls back to Geopost after $name, and keeps that failure when Geopost does not know the number', async ({ site, kind }) => {
    await expect(jadlog(routed(site, Response.json(fixture('delivered.json')))).track({ number: NUMBER }))
      .resolves.toMatchObject({ status: 'delivered', source: 'mydpd_guest_api' });
    const failure = jadlog(routed(site, new Response('', { status: 404 }))).track({ number: NUMBER });
    await expect(failure).rejects.toMatchObject(kind === 'error' ? { status: 500 } : { kind });
  });

  it('knows a number the tracker lists without asking Geopost', async () => {
    const fetcher = routed(() => html(page('site-transit.html')));
    await expect(jadlog(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-10T09:53:00' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("lets a tracker row and Geopost's copy of it, less than a minute apart with the same stage, share one row", () => {
    const policy = sameInstantIdentityPolicy('jadlog', { supportsScanMatching: true })!;
    expect(policy).toMatchObject({ matchWithinMinute: true, matchWallClock: true });
    const site = { stage: 'in_transit', description: 'Seu produto está a caminho do seu endereço.', location: '', providerCode: '' };
    const group = { stage: 'in_transit', description: 'At delivery center', location: '', providerCode: 'AT_DELIVERY_CENTER' };
    expect(policy.matches!(site, group)).toBe(true);
    expect(policy.matches!(group, site)).toBe(true);
    expect(policy.matches!(site, { ...site })).toBe(true);
    for (const other of [{ ...group, stage: 'delivered' }, { ...group, stage: '' }, { ...group, location: 'TEST UNIT' }, { ...group, providerCode: 'X1' }, { ...group, providerCode: '' }]) {
      expect(policy.matches!(site, other), JSON.stringify(other)).toBe(false);
    }
  });
});

describe('Jadlog recognition', () => {
  const recognize = (fetcher: typeof fetch) => jadlog(fetcher).recognize!(NUMBER);

  it('knows a parcel the guest API places in Brazil', async () => {
    const fetcher = guest(placed('BR', fixture('registered.json')));
    await expect(recognize(fetcher)).resolves.toEqual({ known: true });
    expect(new URL(String(geopostCalls(fetcher)[3]![0])).searchParams.get('businessUnit')).toBe('JADLOG');
  });

  it.each(['FR', 'DE', 'BE', 'PT', 'ES'])('does not take %s activity for Jadlog', async (countryCode) => {
    await expect(recognize(guest(placed(countryCode)))).resolves.toEqual({ known: false });
  });

  it('leaves a lookup of another unit\'s parcel placed abroad inconclusive', async () => {
    const elsewhere = (countryCode: string, unit: string) => Response.json({ ...fixture('delivered.json'), shipmentBUCode: unit,
      status: { ...fixture('delivered.json').status, countryCode } });
    await expect(jadlog(guest(elsewhere('DE', '015'))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    // Jadlog's own parcel abroad, or one in Brazil whatever its code, is read.
    for (const [countryCode, unit] of [['PT', '060'], ['BR', '015']]) {
      await expect(jadlog(guest(elsewhere(countryCode!, unit!))).track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    }
  });

  it('leaves a reply without a country inconclusive and does not know a missing parcel', async () => {
    await expect(recognize(guest(placed(undefined)))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(recognize(guest(new Response('', { status: 404 })))).resolves.toEqual({ known: false });
  });

  it.each([['DPD Belgium', dpdBe], ['DPD Netherlands', dpdNl], ['DPD Hungary', dpdHu]])(
    "%s does not know a parcel Geopost places in Brazil under Jadlog's business unit",
    async (_unit, unit) => {
      const known = unit(environment(guest(Response.json(fixture('registered.json'))))).recognize!(NUMBER);
      await expect(known).resolves.toEqual({ known: false });
    },
  );

  it('is offered for a bare fourteen-digit number and asked about it only for a lookup in Brazil', () => {
    expect(detectCarrierMatch(NUMBER).candidates).toContain('jadlog');
    expect(recognitionAskedCarriers(NUMBER, { countryHint: 'BR' })).toContain('jadlog');
    for (const countryHint of [undefined, 'FR', 'DE', 'PT']) {
      expect(recognitionAskedCarriers(NUMBER, { countryHint }), String(countryHint)).not.toContain('jadlog');
    }
  });
});

describe('Jadlog status map', () => {
  it("answers Geopost's guest codes and Jadlog's own Portuguese wording", () => {
    const answer = (providerCode: string | null, description: string) => statusMapAnswer({ carrier: 'jadlog', providerCode, description });
    expect(answer('ORDER_CREATED', 'Order created')).toEqual({ kind: 'mapped', stage: 'registered' });
    expect(answer('DELIVERED', 'Delivered')).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(answer('PARCEL_HANDED', 'Parcel handed to DPD')).toMatchObject({ kind: 'intentional_gap' });
    expect(answer(null, 'Em rota de entrega')).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(answer(null, 'Your parcel is on its way')).toEqual({ kind: 'unknown' });
  });

  it('stages every recorded status as statuses.json says', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording), entry.wording).toBe(entry.stage);
    }
  });
});
