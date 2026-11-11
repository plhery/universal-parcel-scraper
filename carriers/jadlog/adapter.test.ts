import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter as dpdBe } from '../dpd-be/adapter.js';
import { adapter as dpdHu } from '../dpd-hu/adapter.js';
import { adapter as dpdNl } from '../dpd-nl/adapter.js';
import { adapter } from './adapter.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic: a 14-digit number of DPD's shape that was never issued.
const NUMBER = '10000000000001';
type Reply = Record<string, unknown> & { status: Record<string, unknown>; parcelHistory: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Reply;
const CAPABILITIES = (JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')) as { capabilities: string[] }).capabilities;

/** The guest login a cold tracker goes through, then Geopost's replies. */
function guest(...replies: Response[]) {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ fid: 'synthetic-fid', authToken: { token: 'synthetic-installation', expiresIn: '604800s' } }))
    .mockResolvedValueOnce(Response.json({ entries: { basic_dpd_token: 'c3ludGhldGljOnRva2Vu' } })) // gitleaks:allow
    .mockResolvedValueOnce(Response.json({ access_token: 'synthetic-access', expires_in: 3600 }));
  for (const reply of replies) fetcher.mockResolvedValueOnce(reply);
  return fetcher;
}
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
const jadlog = (fetcher: typeof fetch) => adapter(environment(fetcher));
const placed = (countryCode: string | undefined, reply = fixture('delivered.json')) => Response.json({ ...reply, status: { ...reply.status, countryCode } });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>';

describe('Jadlog guest tracking', () => {
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

    const remoteConfig = JSON.parse(String(fetcher.mock.calls[1]![1]!.body)) as Record<string, unknown>;
    expect(remoteConfig.countryCode).toBe('BR');
    const url = new URL(String(fetcher.mock.calls[3]![0]));
    expect(url.pathname).toBe(`/concept/webservice/v10/parcels/details/${NUMBER}`);
    expect(url.searchParams.get('businessUnit')).toBe('JADLOG');
    expect(url.searchParams.get('continueWithoutVerification')).toBe('true');
    expect(url.searchParams.has('dataForVerification')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
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
    for (const name of ['registered.json', 'delivered.json']) {
      const result = await jadlog(guest(Response.json(fixture(name)))).track({ number: NUMBER });
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
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('reports a rate limit with the wait Geopost asks for', async () => {
    const reply = new Response('', { status: 429, headers: { 'retry-after': '30' } });
    await expect(jadlog(guest(reply)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
  });

  it.each([
    { name: 'another parcel', payload: { ...fixture('registered.json'), parcelNumber: '10000000000002', shipmentId: '10000000000002' }, kind: 'schema' },
    { name: 'empty history', payload: { ...fixture('registered.json'), parcelHistory: [] }, kind: 'indeterminate' },
  ])('rejects $name rather than manufacturing tracking success', async ({ payload, kind }) => {
    await expect(jadlog(guest(Response.json(payload))).track({ number: NUMBER })).rejects.toMatchObject({ kind });
  });

  it('refuses a number Geopost does not issue before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(jadlog(fetcher).track({ number: '1000000000000' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Jadlog recognition', () => {
  const recognize = (fetcher: typeof fetch) => jadlog(fetcher).recognize!(NUMBER);

  it('knows a parcel the guest API places in Brazil', async () => {
    const fetcher = guest(placed('BR', fixture('registered.json')));
    await expect(recognize(fetcher)).resolves.toEqual({ known: true });
    expect(new URL(String(fetcher.mock.calls[3]![0])).searchParams.get('businessUnit')).toBe('JADLOG');
  });

  it.each(['FR', 'DE', 'BE', 'PT', 'ES'])('does not take %s activity for Jadlog', async (countryCode) => {
    await expect(recognize(guest(placed(countryCode)))).resolves.toEqual({ known: false });
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
