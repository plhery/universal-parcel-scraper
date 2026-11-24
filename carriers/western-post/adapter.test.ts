import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, WESTERN_POST_PAGE, WESTERN_POST_TRACK, westernPostLookupBody, WesternPostTracker } from './adapter.js';
import { normalizeWesternPostNumber, parseWesternPost } from './parser.js';
import { statusMap, westernPostStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

type Row = Record<string, unknown>;
type Reply = Record<string, unknown> & { data: Row & { type: unknown; list: Row[]; trackFiles: Row[]; sizeAndWeight: Row[];
  trackAddress: { senderInfo: Row[]; receiverInfo: Row[] } } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const edited = (change: (reply: Reply) => void, name = 'delivered') => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
// The public sample: a parcel taken from the warehouse in Walnut to Ontario, California, and delivered in Indio.
const ITEM = fixture('delivered').data.list[0]!.trackingNumber as string;
// A synthetic number of the same shape, which the tracker does not know.
const UNKNOWN = 'WP9031846275019';
const OTHER = 'WP9031846275027';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const once = (response: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(response);
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Western Post tracking adapter', () => {
  it('posts the whole number as the home page\'s tracking box does, through the supplied transport', async () => {
    const fetcher = once(json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new WesternPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${ITEM.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://www.wpglb.com/trackQuery');
    expect(url).toBe(WESTERN_POST_TRACK);
    expect(init.body).toBe(`trackNumberList=${ITEM}`);
    expect(init.body).toBe(westernPostLookupBody(ITEM));
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: '*/*', 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.wpglb.com', Referer: WESTERN_POST_PAGE, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'western-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s scans as wall clocks with their codes and towns, and the parcel\'s weight and size', () => {
    const result = parseWesternPost(fixture('delivered'), ITEM);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-07-15T13:49:03', expected_delivery: null, weight_kg: 52.2, dimensions_text: '68 × 31 × 11 in',
    });
    expect(result.events).toHaveLength(7);
    expect(result.events![0]).toEqual({ local_time: '2026-07-15T13:49:03', location: 'Indio', description: 'Delivered', provider_code: 'DD',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-07-14T00:32:16', location: 'Walnut', description: 'Shipment Information sent to the Carrier',
      provider_code: 'SI', stage: 'registered', stage_source: 'carrier_map' });
    // Two scans of one second keep the tracker's order, newest first.
    expect(result.events!.slice(4, 6).map((event) => [event.provider_code, event.local_time, event.stage]))
      .toEqual([['PU', '2026-07-14T15:04:02', 'accepted'], ['AC', '2026-07-14T15:04:02', 'accepted']]);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['DD', 'OD', 'AP', 'IT', 'PU', 'AC', 'SI']);
    // Every scan has a mapped stage and no instant: the reply names no zone.
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.time === undefined)).toBe(true);
    // The photo count and the sender's and recipient's towns stay behind.
    expect(result).not.toHaveProperty('receiver_address');
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('signed_by');
    expect(JSON.stringify(result)).not.toMatch(/oraCity|osaCity|fileUrl|trackFiles/);
  });

  it('never reads a person or a street address, should a scan or the reply carry one', () => {
    const result = parseWesternPost(edited((reply) => {
      reply.data.list[0]!.remarks = 'Delivered, signed by SAMPLE SIGNER';
      reply.data.list[0]!.trackAddress = '1 Sample Street, Indio, CA 00000';
      reply.data.list[1]!.remarks = 'Out for delivery 签收人: 示例';
      reply.data.trackFiles = [{ trackingNumber: ITEM, fileUrl: 'https://files.example/photo.jpg' }];
      reply.data.trackAddress.receiverInfo = [{ trackingNumber: ITEM, oraCity: 'Indio', oraName: 'SAMPLE RECIPIENT', oraPhone: '+1 000 000 0000' }];
    }), ITEM);
    expect(result.events![0]).toEqual({ local_time: '2026-07-15T13:49:03', description: 'Delivered', provider_code: 'DD',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events![1]).toMatchObject({ description: 'Out for delivery', location: 'Ontario' });
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|Street|00000|示例|example|\+1/);
    // The page shows the town column only for replies of type 1.
    expect(parseWesternPost(edited((reply) => { reply.data.type = 2; }), ITEM).events!.some((event) => 'location' in event)).toBe(false);
  });

  it('reads the tracker\'s empty reply as not found, and binds an answer to the number asked', async () => {
    expect(() => parseWesternPost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(once(json(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // A reply for another number, as a cache could give it, is no answer.
    expect(() => parseWesternPost(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWesternPost(edited((reply) => { reply.data.sizeAndWeight[0]!.trackingNumber = OTHER; }, 'delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Rows of another number beside the asked one's are left out.
    const mixed = parseWesternPost(edited((reply) => {
      reply.data.list.unshift({ ...reply.data.list[0]!, trackingNumber: OTHER, trackTime: '2026-07-20 09:00:00', remarks: 'Returned', nodeCode: 'RT' });
      reply.data.sizeAndWeight.unshift({ ...reply.data.sizeAndWeight[0]!, trackingNumber: OTHER, ordersWeight: '1.000' });
    }), ITEM);
    expect(mixed).toMatchObject({ status: 'delivered', last_update_local: '2026-07-15T13:49:03', weight_kg: 52.2 });
    expect(mixed.events).toHaveLength(7);
    // The tracker holding the parcel's size but no scan knows the number.
    const listed = edited((reply) => { reply.data.list = []; });
    expect(() => parseWesternPost(listed, ITEM)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate', reason: 'listed' }));
    // A refused lookup's message says nothing about the number.
    for (const refused of [{ success: false, code: 0, message: 'error', data: '查询失败' }, { success: true, code: 500, data: null }]) {
      expect(() => parseWesternPost(refused, ITEM)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('stages a parcel by its newest staged scan and leaves wording nothing knows without a stage', () => {
    const note = (row: Row) => ({ ...row, trackTime: '2026-07-16 09:00:00', remarks: 'Synthetic note', nodeCode: 'ZZ' });
    const moving = edited((reply) => { reply.data.list[0] = note(reply.data.list[0]!); });
    expect(parseWesternPost(moving, ITEM)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
    expect(parseWesternPost(moving, ITEM).events![0]).not.toHaveProperty('stage');
    // A scan nothing knows after the delivery may have undone it.
    const noted = edited((reply) => { reply.data.list.unshift(note(reply.data.list[0]!)); });
    expect(parseWesternPost(noted, ITEM)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
    expect(parseWesternPost(noted, ITEM)).not.toHaveProperty('current_stage');
    const unknown = edited((reply) => { reply.data.list = reply.data.list.slice(0, 1).map((row) => ({ ...row, remarks: 'Synthetic note', nodeCode: 'ZZ' })); });
    expect(parseWesternPost(unknown, ITEM)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
    expect(parseWesternPost(unknown, ITEM)).not.toHaveProperty('current_stage');
    // A code the map does not know keeps the shared wording rules.
    const worded = edited((reply) => { reply.data.list[0]!.nodeCode = 'ZZ'; reply.data.list[0]!.remarks = 'Out for delivery today'; });
    expect(parseWesternPost(worded, ITEM).events![0]).toMatchObject({ provider_code: 'ZZ', stage: 'out_for_delivery' });
    expect(parseWesternPost(worded, ITEM).events![0]!.stage_source).not.toBe('carrier_map');
  });

  it('turns an oldest-first history round and refuses a changed reply', () => {
    const reversed = parseWesternPost(edited((reply) => { reply.data.list.reverse(); }), ITEM).events!;
    expect(reversed[0]).toMatchObject({ local_time: '2026-07-15T13:49:03' });
    expect(reversed.at(-1)).toMatchObject({ local_time: '2026-07-14T00:32:16' });
    const time = (value: unknown) => edited((reply) => { reply.data.list[0]!.trackTime = value; });
    for (const bad of ['15/07/2026 13:49:03', '2026-02-30 13:49:03', '2026-07-15 24:00:00', '2026-07-15T13:49:03+08:00', '', null, 1784123343]) {
      expect(() => parseWesternPost(time(bad), ITEM), String(bad)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseWesternPost(time('2026-07-15 13:49'), ITEM).events![0]).toMatchObject({ local_time: '2026-07-15T13:49:00' });
    for (const reply of [
      null, [], 'ok', { success: 'yes', code: '200' }, { success: true, code: 200 }, { success: true, code: 200, data: { list: {} } },
      edited((value) => { value.data.list[0]!.remarks = ''; }),
      edited((value) => { value.data.list[0]!.remarks = { text: 'Delivered' }; }),
      edited((value) => { value.data.list[0]!.nodeCode = 'D D'; }),
      edited((value) => { value.data.list[0] = 'Delivered' as never; }),
      edited((value) => { delete value.data.list[0]!.trackingNumber; }),
      edited((value) => { value.data.trackFiles = {} as never; }),
      edited((value) => { value.data.trackAddress = 'Indio' as never; }),
      edited((value) => { value.data.list = Array.from({ length: 301 }, () => value.data.list[0]!); }),
    ]) {
      expect(() => parseWesternPost(reply, ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A weight or size it cannot read is left out.
    const unread = parseWesternPost(edited((reply) => { reply.data.sizeAndWeight[0]!.weightUnit = 'OZ'; reply.data.sizeAndWeight[0]!.ordersHeight = ''; }), ITEM);
    expect(unread).not.toHaveProperty('weight_kg');
    expect(unread).not.toHaveProperty('dimensions_text');
    expect(parseWesternPost(edited((reply) => { reply.data.sizeAndWeight[0]!.weightUnit = 'KG'; reply.data.sizeAndWeight[0]!.sizeUnit = 'CM'; }), ITEM))
      .toMatchObject({ weight_kg: 115.081, dimensions_text: '68 × 31 × 11 cm' });
  });

  it('keeps browser checks, refusals, moved routes, maintenance, rate limits and outages apart from a missing parcel, and retries a network failure once', async () => {
    const reading = (response: Response) => carrier(once(response)).track({ number: ITEM });
    await expect(reading(page(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page(BLOCKED, 503))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page('<html><title>403 Forbidden</title></html>', 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(json({}, 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page('<html><title>系统维护</title></html>', 503))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(reading(page('<html><title>404</title></html>', 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(page('', 302, { Location: 'https://www.wpglb.com/' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(json('', 429))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(reading(json('', 500))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(reading(page('<html><title>西邮物流</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(reading(json('{"success":'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(reading(json(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes 6 to 40 letters and digits, in capitals, and refuses anything else before a request', async () => {
    expect(normalizeWesternPostNumber(` ${ITEM.toLowerCase()} `)).toBe(ITEM);
    expect(normalizeWesternPostNumber('wp 9031 8462 75019')).toBe(UNKNOWN);
    for (const bad of ['WP90', 'A'.repeat(41), 'WP903,1846275019', '', 'X'.repeat(65)]) {
      expect(() => normalizeWesternPostNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'WP90' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded code and wording to its stage', () => {
    expect(STATUS_MAPS['western-post']).toBe(statusMap);
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      expect(statusMap.stage(entry.code, wording), entry.code).toBe(entry.stage);
      // A universal provider relays the wording without the code.
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(westernPostStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.stage('ZZ', normalizeStatusWording('Synthetic note'))).toBeUndefined();
  });
});
