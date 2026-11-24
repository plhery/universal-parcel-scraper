import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CARGOMINI_PAGE, cargominiLookupUrl, CargominiTracker } from './adapter.js';
import { normalizeCargominiNumber, parseCargomini } from './parser.js';

// The public sample: a consignment flown into Türkiye, cleared and delivered by Kolay Gelsin.
const ITEM = '190230529212TR';
// Kolay Gelsin's number for it.
const PARTNER = '254640506454';
// A synthetic number of the same shape, which the tracker does not know.
const UNKNOWN = '999999999999TR';

type Reply = Record<string, unknown> & { events: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const edited = (change: (reply: Reply) => void) => {
  const reply = fixture('delivered');
  change(reply);
  return reply;
};
const json = (body: unknown, status = 200, type = 'application/json; charset=utf-8', headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type, ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const once = (response: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(response);
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('CargoMini tracking adapter', () => {
  it('asks the tracker for the whole number through the supplied transport', async () => {
    const fetcher = once(json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CargominiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 190230529212tr ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://api.kargomkolay.com/v1/tracking/${ITEM}`);
    expect(url).toBe(cargominiLookupUrl(ITEM));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: CARGOMINI_PAGE, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'cargomini', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample\'s events newest first, with their offsets, codes and the hand-over to Kolay Gelsin', () => {
    const result = parseCargomini(fixture('delivered'), ITEM);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Teslim Edildi', last_update: '2025-11-07T12:05:57.637Z', expected_delivery: null,
      delivery_tracking_number: PARTNER,
    });
    // Kolay Gelsin has no detection rule, so the number stays without a carrier.
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.events).toHaveLength(19);
    expect(result.events![0]).toEqual({ time: '2025-11-07T12:05:57.637Z', description: 'Teslim Edildi', provider_code: '7',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events![1]).toMatchObject({ description: 'Kurye zimmete alma', provider_code: '11', stage: 'out_for_delivery' });
    expect(result.events!.at(-1)).toEqual({ time: '2025-10-24T02:29:14.036Z', description: 'LabelCreated - Etiket Basıldı', provider_code: '1',
      stage: 'registered', stage_source: 'carrier_map' });
    // Events without wording take the tracking page's title for their code.
    expect(result.events!.find((event) => event.provider_code === '19')).toMatchObject({ description: 'Plane has arrived', stage: 'in_transit' });
    expect(result.events!.find((event) => event.provider_code === '4')).toMatchObject({ description: 'Import customs process started', stage: 'customs' });
    expect(result.events!.find((event) => event.description === 'Customs hold')).toMatchObject({ provider_code: '6', stage: 'customs' });
    expect(result.events!.every((event) => event.stage && event.local_time === undefined)).toBe(true);
  });

  it('never reads the sender, the recipient, the postcode, the order reference or the weight', () => {
    const result = parseCargomini(edited((reply) => {
      reply.receiver = { name: 'RECIPIENT NAME', postcode: '00000', city: 'RECIPIENT TOWN', countryCode: 'TR' };
      reply.sender = { name: 'SENDER NAME', city: 'SENDER TOWN', countryCode: 'CN' };
      reply.referenceNo = 'ORDER-REFERENCE';
    }), ITEM);
    expect(JSON.stringify(result)).not.toMatch(/RECIPIENT|SENDER|00000|ORDER-REFERENCE|0\.63/);
  });

  it('keeps events in time order whatever order the tracker lists them in', () => {
    const result = parseCargomini(edited((reply) => { reply.events.reverse(); }), ITEM);
    expect(result.events![0]).toMatchObject({ description: 'Teslim Edildi' });
    expect(result.events!.at(-1)).toMatchObject({ provider_code: '1' });
  });

  it('stands on the consignment status when no event is listed, and has no history without one', () => {
    expect(parseCargomini(edited((reply) => { reply.events = []; reply.status = 4; }), ITEM)).toMatchObject({
      status: 'in_transit', current_stage: 'customs', last_status_text: 'In Customs', summary_only: true, events: [] });
    expect(() => parseCargomini(edited((reply) => { reply.events = []; reply.status = 99; }), ITEM))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('reads the tracker\'s problem reply for an unknown number as not found, and binds the answer to the number asked', async () => {
    await expect(carrier(once(json(fixture('not-found'), 404, 'application/problem+json; charset=utf-8'))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    // An empty 404, a missing route, is no answer about the number.
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }))).track({ number: UNKNOWN }))
      .rejects.not.toMatchObject({ kind: 'not_found' });
    // The reply for another consignment, as a cache could give it, is no answer.
    expect(() => parseCargomini(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps browser checks, rate limits and malformed replies apart from not found', async () => {
    await expect(carrier(once(new Response(BLOCKED, { status: 403, headers: { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' } })))
      .track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(once(new Response(BLOCKED, { status: 200, headers: { 'Content-Type': 'text/html' } }))).track({ number: ITEM }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(once(json({ title: 'Too Many Requests' }, 429))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(once(json('{"consignmentNo":', 200))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'schema' });
    expect(() => parseCargomini(edited((reply) => { reply.events[0]!.date = '2025-10-24 02:29:14'; }), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCargomini(edited((reply) => { reply.events[0]!.event = 'LabelCreated'; }), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCargomini({ title: 'Not Found', status: 404 }, ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts letters and digits only', () => {
    expect(normalizeCargominiNumber(' 190 230 529 212 tr ')).toBe(ITEM);
    expect(() => normalizeCargominiNumber('ABC')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeCargominiNumber('../admin')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});
