import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, E24_SEARCH, E24_SEARCH_KEY, E24_STATUSES, E24Tracker } from './adapter.js';
import { e24Token, normalizeE24Number, parseE24 } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's replies, with the delivery photos taken out of the feedback block.
const DELIVERED = '363C38-8B1AA496';
const INVENTED = '000000-00000000';

type Statuses = Record<string, unknown> & { processStatusLogDomainList: { processStatusLogDto: Record<string, unknown>[] }[] };
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const statusesOf = (name: string) => JSON.parse(read(name)) as Statuses;
const logsOf = (reply: Statuses) => reply.processStatusLogDomainList[0]!.processStatusLogDto;
const withLogs = (reply: Statuses, logs: Record<string, unknown>[]) => ({ ...reply, processStatusLogDomainList: [{ ...reply.processStatusLogDomainList[0], processStatusLogDto: logs }] });
const text = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/plain' } });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The search's reply, then the statuses' reply, for any further call.
const replies = (search: () => Response, after: () => Response = () => json(statusesOf('delivered.json'))) =>
  vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(E24_SEARCH) ? search() : after()));

describe('E24 numbers', () => {
  it('takes six and eight hexadecimal digits and writes them in capitals with the dash', () => {
    expect(normalizeE24Number(` ${DELIVERED.toLowerCase()} `)).toBe(DELIVERED);
    expect(normalizeE24Number('363c388b1aa496')).toBe(DELIVERED);
    for (const other of ['', '363C38-8B1AA49', '363C38-8B1AA4967', '363G38-8B1AA496', 'AM010034806']) {
      expect(() => normalizeE24Number(other), other).toThrow('six and eight hexadecimal digits');
    }
  });
});

describe('E24 tracking adapter', () => {
  it("searches the number with the public page's key, then reads the statuses of the first page it gives", async () => {
    const fetcher = replies(() => text(read('search.txt')));
    await expect(new E24Tracker({ fetcher, recorder: NOOP_RECORDER }).fetch('363c388b1aa496')).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [search, searchInit] = fetcher.mock.calls[0]!;
    expect(String(search)).toBe(`${E24_SEARCH}?encodedString=${encodeURIComponent(E24_SEARCH_KEY)}&param1=${DELIVERED}&settingType=BASIC&language=en`);
    expect(searchInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    const token = e24Token(read('search.txt'));
    expect(token).toMatch(/^yqrHCbU65ryU/);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${E24_STATUSES}?url=${encodeURIComponent(token)}&isReturn=false&isMultiShipment=false&universalTracking=true`);
    expect(carrier(fetcher)).toMatchObject({ id: 'e24metro-ca', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it("reads the search's NO URL FOUND as not found, without a second request", async () => {
    const fetcher = replies(() => text(read('not-found.txt')));
    await expect(carrier(fetcher).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps refusals, block pages, error replies and redirects apart from a missing parcel', async () => {
    const answer = async (search: () => Response, after?: () => Response) => carrier(replies(search, after))
      .track({ number: INVENTED }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    const found = () => text(read('search.txt'));
    expect(await answer(() => html('<html><title>403 Forbidden</title></html>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><title>Just a moment...</title><script>_cf_chl_opt={}</script></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(found, () => html('<html><title>Just a moment...</title><script>_cf_chl_opt={}</script></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><body>FarEye</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => text('[]'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => text('[https://tracking-ca.fareye.co/tracking?abc#/]'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => text(''))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => text('Too Many Requests', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => text('Service Unavailable', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.fareye.com/' } }))).toMatchObject({ kind: 'transport' });
    // The tracker answers a token it does not take with HTTP 400 and no body.
    expect(await answer(found, () => new Response(null, { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(found, () => json({ message: 'error' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(found, () => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(found, () => json([]))).toMatchObject({ kind: 'schema' });
  });
});

describe('E24 replies', () => {
  it('reads the delivered sample: its statuses newest first, on their UTC clock', () => {
    const staged = (time: string, description: string, stage: string) => ({ time, description, stage, stage_source: 'carrier_map' });
    expect(parseE24(statusesOf('delivered.json'), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-08-05T14:21:13Z', expected_delivery: null,
      events: [
        staged('2026-08-05T14:21:13Z', 'Delivered', 'delivered'),
        staged('2026-08-05T14:20:55Z', 'You are Next', 'out_for_delivery'),
        staged('2026-08-05T13:15:17Z', 'Driver Out For Delivery', 'out_for_delivery'),
        staged('2026-08-05T03:57:05Z', 'Assigned to Last mile Driver for Delivery', 'in_transit'),
        staged('2026-08-04T23:07:53Z', 'Shipment received at Facility after pickup', 'accepted'),
        staged('2026-08-04T18:28:57Z', 'Order Confirmed', 'registered'),
      ],
    });
  });

  it("stages the bilingual page's wordings as the English ones, and halves of one it has not seen", () => {
    const result = parseE24(statusesOf('delivered-bilingual.json'), DELIVERED);
    expect(result.events!.map(({ stage }) => stage)).toEqual(['delivered', 'out_for_delivery', 'out_for_delivery', 'in_transit', 'accepted', 'registered']);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered/Livré' });
    const reply = statusesOf('delivered.json');
    const log = { ...logsOf(reply)[3]!, status: 'Driver Out For Delivery/Sorti en route pour la livraison' };
    expect(parseE24(withLogs(reply, [log]), DELIVERED)).toMatchObject({ current_stage: 'out_for_delivery' });
    const mixed = { ...log, status: 'Delivered/Chauffeur pour la livraison' };
    expect(parseE24(withLogs(reply, [mixed]), DELIVERED)).toMatchObject({ status: 'unknown', events: [{ description: mixed.status }] });
  });

  it('rejects a reply for another parcel and malformed statuses, and leaves a parcel without statuses open', () => {
    const reply = statusesOf('delivered.json');
    expect(() => parseE24(reply, INVENTED)).toThrow('another parcel');
    expect(() => parseE24(withLogs(reply, []), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    expect(() => parseE24({ ...reply, processStatusLogDomainList: {} }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A status with E24's own clock but not the UTC one is a changed reply: its zone is not stated.
    for (const broken of [{ statusClientTime: '2026-08-04 24:00:00' }, { statusClientTime: null }, { status: '' }, { referenceNumber: null }]) {
      expect(() => parseE24(withLogs(reply, [{ ...logsOf(reply)[0], ...broken }]), DELIVERED), JSON.stringify(broken))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it("answers every wording statuses.json records by E24's map", () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(statusMapAnswer({ carrier: 'e24metro-ca', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});
