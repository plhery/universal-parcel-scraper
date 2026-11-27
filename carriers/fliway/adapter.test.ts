import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS, statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { createTracker } from '../../facade/index.js';
import { adapter, FLIWAY_LOOKUP, FliwayTracker } from './adapter.js';
import { ISRG_ROOT_YR_X1 } from './certificate.js';
import { fliwayMissing, normalizeFliwayNumber, parseFliwayConsignment, parseFliwayItem } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const trusting = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('../../core/transport/https.js', () => ({ fetchTrusting: vi.fn(() => trusting) }));

// The public sample of numbers.json, the number on its one piece's label, and a synthetic number.
const NUMBER = 'NZD1099467';
const ITEM = 'NZD1099467001';
const UNKNOWN = 'QXZ4071953';
type Row = Record<string, unknown>;
type Reply = Row & { trackingRecords: Row[]; pod: Row[] };
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const sample = (): Reply => JSON.parse(text(`${NUMBER}.json`));
const item = (): Row & { trackingRecords: string[] } => JSON.parse(text(`${ITEM}.json`));
const changed = (edit: (reply: Reply) => void) => { const reply = sample(); edit(reply); return reply; };
const milestone = (code: string, edit: (row: Row) => void) => changed((reply) => edit(reply.trackingRecords.find((row) => row.trackEvent === code)!));
// The consignment before its delivery round: the round's milestones not scanned yet, and no proof of delivery.
const onItsWay = (edit: (reply: Reply) => void = () => {}) => changed((reply) => {
  for (const row of reply.trackingRecords) {
    if (row.trackEvent === 'OFD' || row.trackEvent === 'Delivered') row.scanDateTime = '';
    row.isOutForDelivery = false;
  }
  reply.pod = [{ PODName: 'No POD recorded' }];
  reply.status = '1 of 1 In Transit';
  edit(reply);
});
const JSON_TYPE = 'application/json; charset=utf-8';
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': JSON_TYPE } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
// RedShield's block page, as its WAF sends it, trimmed to its words.
const REDSHIELD = '<!DOCTYPE html><html><head><title>Blocked</title></head><body><h3>Something\'s not quite right&hellip;</h3>'
  + '<p>At RedShield, we take security very seriously.</p><p>Alternatively please email support@redshield.co</p></body></html>';
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const bodyOf = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number) => JSON.parse(String(fetcher.mock.calls[call]![1]!.body));

describe('Fliway adapter', () => {
  it('posts the number to the lookup the tracker page asks, once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(text(`${NUMBER}.json`)));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new FliwayTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(FLIWAY_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'SyntheticHost/1' } });
    expect(bodyOf(fetcher, 0)).toEqual({ requestType: 'PTRK', connoteNumber: NUMBER });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'fliway', step: 'direct', outcome: 'ok' }));
  });

  it('reads the lookup over the global fetch trusting the root its chain leaves out, and a host’s own fetcher as given', async () => {
    trusting.mockImplementation(async () => json(text(`${NUMBER}.json`)));
    await expect(new FliwayTracker().fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(createTracker({ providers: [], env: {} }).track({ number: NUMBER, carrier: 'fliway' })).resolves.toMatchObject({ source: 'fliway' });
    expect(trusting).toHaveBeenCalledTimes(2);
    expect(fetchTrusting).toHaveBeenCalledWith([ISRG_ROOT_YR_X1]);
    const own = vi.fn<typeof fetch>().mockImplementation(async () => json(text(`${NUMBER}.json`)));
    await expect(createTracker({ fetcher: own, providers: [], env: {} }).track({ number: NUMBER, carrier: 'fliway' })).resolves.toMatchObject({ source: 'fliway' });
    expect(own).toHaveBeenCalledOnce();
    expect(trusting).toHaveBeenCalledTimes(2);
  });

  it('reads the public sample as delivered, each milestone on New Zealand’s clock, without the receiver', () => {
    const result = parseFliwayConsignment(sample(), NUMBER);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: '1 of 1 Delivered',
      last_update: '2024-07-22T09:18:27+12:00', last_update_local: '2024-07-22T09:18:27', expected_delivery: null,
      delivered_at: '2024-07-22T09:18:27+12:00',
    });
    expect(result.events!.map((event) => [event.local_time, event.time, event.description, event.location ?? null, event.stage, event.provider_code])).toEqual([
      ['2024-07-22T09:18:27', '2024-07-22T09:18:27+12:00', 'Delivered', 'Palmerston North', 'delivered', 'Delivered'],
      ['2024-07-22T07:24:30', '2024-07-22T07:24:30+12:00', 'Out for Delivery', 'Palmerston North', 'out_for_delivery', 'OFD'],
      ['2024-07-18T05:00:46', '2024-07-18T05:00:46+12:00', 'Unload', 'Palmerston North', 'in_transit', 'Unload'],
      ['2024-07-17T20:09:44', '2024-07-17T20:09:44+12:00', 'On Linehaul', 'Auckland', 'in_transit', 'OnLinehaul'],
      ['2024-07-17T13:29:29', '2024-07-17T13:29:29+12:00', 'In Depot', 'Auckland', 'in_transit', 'InDepot'],
      ['2024-07-17T13:29:19', '2024-07-17T13:29:19+12:00', 'Pickup', 'Auckland', 'accepted', 'Pickup'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Pacific/Auckland' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
    // The receiver's name, the signature and the consignment's ids stay behind.
    expect(JSON.stringify(result)).not.toMatch(/Receiver Name|base64|data:|17729261|37549773/);
  });

  it('reads a summer clock on New Zealand’s summer offset, and keeps a depot it cannot name by its code', () => {
    const result = parseFliwayConsignment(milestone('Delivered', (row) => { row.scanDateTime = '2025-12-24T16:05:00'; row.location = 'CHC'; }), NUMBER);
    expect(result.events![0]).toMatchObject({ local_time: '2025-12-24T16:05:00', time: '2025-12-24T16:05:00+13:00', location: 'CHC' });
    expect(result.delivered_at).toBe('2025-12-24T16:05:00+13:00');
    const unplaced = parseFliwayConsignment(milestone('Delivered', (row) => { row.location = ''; }), NUMBER);
    expect(unplaced.events![0]).not.toHaveProperty('location');
    for (const clock of ['2024-07-22 09:18:27', '2024-07-22T09:18', '22/07/2024 09:18', '2024-07-22T24:00:00', '2024-02-30T09:18:27', '1999-07-22T09:18:27', 7]) {
      expect(() => parseFliwayConsignment(milestone('Delivered', (row) => { row.scanDateTime = clock; }), NUMBER), String(clock))
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('dates a delivery its milestone does not clock by the proof of delivery, unless that is the placeholder', () => {
    const podOnly = parseFliwayConsignment(milestone('Delivered', (row) => { row.scanDateTime = ''; }), NUMBER);
    expect(podOnly).toMatchObject({ current_stage: 'delivered', delivered_at: '2024-07-22T09:18:27+12:00' });
    expect(podOnly.events![0]).toMatchObject({ local_time: '2024-07-22T09:18:27', description: 'Delivered', provider_code: 'Delivered' });
    const placeholder = parseFliwayConsignment(changed((reply) => {
      reply.trackingRecords.find((row) => row.trackEvent === 'Delivered')!.scanDateTime = '';
      reply.pod = [{ PODName: 'No POD recorded', PODDateTime: '' }];
    }), NUMBER);
    expect(placeholder).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(placeholder.delivered_at).toBeUndefined();
  });

  it('reads a consignment some of whose pieces are not delivered yet as still on its way', () => {
    const partly = parseFliwayConsignment(changed((reply) => { reply.status = '1 of 2 Delivered'; }), NUMBER);
    expect(partly).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: '1 of 2 Delivered' });
    expect(partly.delivered_at).toBeUndefined();
    expect(partly.events![0]).toMatchObject({ stage: 'delivered' });
  });

  it('gives a consignment on its way the slot arranged with the receiver, else its expected day', () => {
    const arranged = parseFliwayConsignment(onItsWay(), NUMBER);
    expect(arranged).toMatchObject({ current_stage: 'in_transit', last_status_text: '1 of 1 In Transit',
      expected_delivery_from: '2024-07-22T09:00:00+12:00', expected_delivery: '2024-07-22T12:00:00+12:00' });
    // The residential milestone's placeholder date, today's with an offset, is no estimate and no scan.
    expect(arranged.events!.map((event) => event.provider_code)).toEqual(['Unload', 'OnLinehaul', 'InDepot', 'Pickup']);
    const delivery = (edit: (row: Row) => void) => onItsWay((reply) => edit(reply.trackingRecords.find((row) => row.trackEvent === 'Delivered')!));
    expect(parseFliwayConsignment(delivery((row) => { row.hasFutiledDelivery = true; row.expectedDate = '2024-07-23T00:00:00'; }), NUMBER))
      .toMatchObject({ expected_delivery: '2024-07-23' });
    const unarranged = parseFliwayConsignment(delivery((row) => { row.deliveryArranged = false; row.expectedDate = '2024-07-19T00:00:00'; }), NUMBER);
    expect(unarranged.expected_delivery).toBe('2024-07-19');
    expect(unarranged.expected_delivery_from).toBeUndefined();
    // A slot or day already past the newest scan is no estimate.
    expect(parseFliwayConsignment(delivery((row) => { row.arrangedEndDateTime = '2024-07-18T04:00:00'; row.arrangedStartDateTime = '2024-07-18T01:00:00'; }), NUMBER))
      .toMatchObject({ expected_delivery: null });
    expect(parseFliwayConsignment(delivery((row) => { row.deliveryArranged = false; row.expectedDate = '2024-07-17T00:00:00'; }), NUMBER))
      .toMatchObject({ expected_delivery: null });
  });

  it('reads an item’s history, placing pickups and depots and leaving the signer out', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: `Connote Number ${ITEM} is not found.` }))
      .mockResolvedValueOnce(json(text(`${ITEM}.json`)));
    const result = await carrier(fetcher).track({ number: ITEM });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetcher, 0)).toEqual({ requestType: 'PTRK', connoteNumber: ITEM });
    expect(bodyOf(fetcher, 1)).toEqual({ requestType: 'PTRK', trackNum: ITEM });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2024-07-22T09:18:00+12:00', delivered_at: '2024-07-22T09:18:00+12:00' });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2024-07-22T09:18:00', 'Delivered', null, 'delivered'],
      ['2024-07-22T07:24:00', 'Out For Delivery', null, 'out_for_delivery'],
      ['2024-07-19T15:38:00', 'In Transit', null, 'in_transit'],
      ['2024-07-18T16:30:00', 'In Transit', null, 'in_transit'],
      ['2024-07-18T05:00:00', 'Arrived PALMERSTON NORTH Depot', 'Palmerston North', 'in_transit'],
      ['2024-07-17T20:09:00', 'In Transit Linehaul', null, 'in_transit'],
      ['2024-07-17T13:29:00', 'Arrived AUCKLAND Depot', 'Auckland', 'in_transit'],
      ['2024-07-17T13:29:00', 'Picked Up East Tamaki', 'East Tamaki', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Receiver Name|Signed By/i);
  });

  it('reads an item row it has no rule for by the shared wording rules, and rejects a row without its clock', () => {
    const above = (row: unknown) => { const reply = item(); reply.trackingRecords.push(row as string); return reply; };
    expect(parseFliwayItem(above('23 Jul 24 08:00 Returned to sender'), ITEM)).toMatchObject({ current_stage: 'returned' });
    const unread = parseFliwayItem(above('23 Jul 24 08:00 Contact us'), ITEM);
    expect(unread.events![0]).not.toHaveProperty('stage');
    // A newer row the map does not know may have undone the delivery.
    expect(unread).toMatchObject({ status: 'unknown' });
    expect(unread.current_stage).toBeUndefined();
    for (const row of ['Delivered', '23 July 24 08:00 Delivered', '32 Jul 24 08:00 Delivered', '23 Jul 2024 08:00 Delivered', '23 Jul 24 8:00 Delivered', 7, null]) {
      expect(() => parseFliwayItem(above(row), ITEM), String(row)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads a number as not found only when both lookups say they do not know it', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(text('not-found.json')))
      .mockResolvedValueOnce(json(text('item-not-found.json')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const missing = (connote: unknown, item?: unknown) => {
      const answers = vi.fn<typeof fetch>().mockResolvedValueOnce(json(connote));
      if (item !== undefined) answers.mockResolvedValueOnce(json(item));
      return carrier(answers).track({ number: UNKNOWN });
    };
    // An answer for another number, another error or an item reply for another item says nothing about this one.
    await expect(missing({ error: 'Connote Number QXZ4071954 is not found.' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(missing({ error: 'Object reference not set to an instance of an object.' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(missing({ error: 42 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(missing(JSON.parse(text('not-found.json')), { error: 'Unknown Ticket: QXZ407195' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(missing(JSON.parse(text('not-found.json')), { error: 'Ticket lookup failed' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(missing(JSON.parse(text('not-found.json')), { ...item(), trackNum: 'QXZ4071954' })).rejects.toMatchObject({ kind: 'indeterminate' });
    // The item lookup's answer is not the consignment lookup's, nor the other way round.
    expect(() => fliwayMissing(JSON.parse(text('item-not-found.json')), UNKNOWN, 'connote')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(fliwayMissing({ error: `Connote Number ${UNKNOWN.toLowerCase()} is not found.` }, UNKNOWN, 'connote')).toBe(true);
    expect(fliwayMissing(sample(), NUMBER, 'connote')).toBe(false);
  });

  it('reads RedShield’s refusal as a challenge, never as a missing parcel', async () => {
    for (const answer of [() => html(REDSHIELD, 403), () => html(REDSHIELD), () => html('', 403), () => json({ message: 'Forbidden' }, 401)]) {
      await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => answer())).track({ number: UNKNOWN }))
        .rejects.toMatchObject({ kind: 'challenge' });
    }
  });

  it('reads a moved lookup, a page or a malformed reply as a failure, never as a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => answer())).track({ number: NUMBER });
    await expect(lookup(() => new Response('', { status: 302, headers: { Location: 'https://online.fliway.com/Account/Login' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('<!DOCTYPE html><title>Not Found</title>', 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('<!DOCTYPE html><html><title>Login - Fliway Portal</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json('{"connoteNumber":'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json('[]'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the reply to the whole number asked', () => {
    for (const other of ['NZD1099468', `${NUMBER}1`, NUMBER.slice(1)]) {
      expect(() => parseFliwayConsignment(changed((reply) => { reply.connoteNumber = other; }), NUMBER), other)
        .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const missing of ['', null, 42, [NUMBER], undefined]) {
      expect(() => parseFliwayConsignment(changed((reply) => { reply.connoteNumber = missing; }), NUMBER), String(missing))
        .toThrowError(expect.objectContaining({ kind: 'schema' }));
      expect(() => parseFliwayItem({ ...item(), trackNum: missing }, ITEM), String(missing)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseFliwayConsignment(changed((reply) => { reply.connoteNumber = ` ${NUMBER.toLowerCase()} `; }), NUMBER).events).toHaveLength(6);
  });

  it('reads a known consignment or item without a scan as no history, never as missing', () => {
    const unscanned = changed((reply) => { for (const row of reply.trackingRecords) row.scanDateTime = ''; reply.pod = []; });
    expect(() => parseFliwayConsignment(unscanned, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => parseFliwayConsignment(changed((reply) => { reply.trackingRecords = []; reply.pod = []; }), NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => parseFliwayItem({ ...item(), trackingRecords: [] }, ITEM)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('rejects a reply that is not a list of complete milestones', () => {
    for (const reply of [milestone('Pickup', (row) => { delete row.trackEvent; }), milestone('Pickup', (row) => { row.trackEvent = 'Picked Up'; }),
      milestone('Pickup', (row) => { row.location = 7; }), changed((reply) => { reply.trackingRecords.push(null as unknown as Row); }),
      changed((reply) => { (reply as Row).trackingRecords = {}; }), changed((reply) => { reply.trackingRecords = Array(301).fill(reply.trackingRecords[0]); }),
      changed((reply) => { (reply as Row).pod = {}; }), changed((reply) => { reply.pod = [null as unknown as Row]; }),
      changed((reply) => { reply.pod[0]!.PODDateTime = '22/07/2024'; }), changed((reply) => { reply.status = 3; }), null, [], 'Delivered']) {
      expect(() => parseFliwayConsignment(reply, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('takes the letters and digits of a consignment or item number, and nothing else', () => {
    expect(normalizeFliwayNumber(' nzd 1099467 ')).toBe(NUMBER);
    expect(normalizeFliwayNumber(ITEM)).toBe(ITEM);
    for (const bad of ['', 'NZD', 'NZ1', `${'A'.repeat(30)}1`, 'NZD10994"67']) {
      expect(() => normalizeFliwayNumber(bad), bad).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers each recorded milestone and row by its map, registered for the carrier', () => {
    expect(STATUS_MAPS.fliway).toBe(statusMap);
    for (const entry of statuses.entries) {
      const answer = statusMapAnswer({ carrier: 'fliway', providerCode: 'code' in entry ? entry.code : null, description: entry.wording });
      expect(answer, entry.wording).toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'unknown' });
    }
  });
});
