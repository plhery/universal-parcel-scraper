import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, NEXT_SMART_SHIP_LOOKUP } from './adapter.js';
import { normalizeNextSmartShipNumber, parseNextSmartShip } from './parser.js';
import { nextSmartShipStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples' whole replies; the tests derive invented entries from them.
const US = 'NSS3623110762978891776';
const AU = 'NSS3309831094921615360';
const UNKNOWN = 'NSS9000000000000000017';
const OTHER = 'NSS9000000000000000025';

type Item = { content: string; timestamp: string };
type Entry = Record<string, unknown> & { tracking_number: string; track_detail: (Record<string, unknown> & { status: string; items: Item[] }) | null };
type Reply = { code: number; message: string; data: { list: Entry[] } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const sampleEntry = (number: string) => fixture(number).data.list[0]!;
/** The Australian sample's entry under another number, with its status, its scans or other fields replaced. */
const reply = (changes: { status?: string; items?: Item[]; entry?: Record<string, unknown> } = {}): Reply => {
  const sample = sampleEntry(AU);
  const detail = { ...sample.track_detail!, ...(changes.status === undefined ? {} : { status: changes.status }), ...(changes.items ? { items: changes.items } : {}) };
  return { code: 0, message: 'success', data: { list: [{ ...sample, tracking_number: OTHER, track_detail: detail, ...changes.entry }] } };
};
const item = (content: string, timestamp: string): Item => ({ content, timestamp });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scans = (result: ReturnType<typeof parseNextSmartShip>) => result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage ?? null]);

describe('Next Smart Ship numbers', () => {
  it('takes NSS and letters or digits, in capitals', () => {
    expect(normalizeNextSmartShipNumber(` ${US.toLowerCase()} `)).toBe(US);
    for (const other of ['', 'NSS', 'NSS12345', 'NSSABCDEFGH', 'XSS3623110762978891776', 'NSS3623110762978891776/1', `NSS${'1'.repeat(38)}`]) {
      expect(() => normalizeNextSmartShipNumber(other), other).toThrow('Next Smart Ship numbers start with NSS');
    }
  });
});

describe('Next Smart Ship tracking adapter', () => {
  it('posts the number in capitals to the lookup behind the tracker page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(US)));
    await expect(carrier(fetcher).track({ number: US.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(NEXT_SMART_SHIP_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }) });
    expect(init?.body).toBe(JSON.stringify({ search: [US] }));
    expect(carrier(fetcher)).toMatchObject({ id: 'next-smart-ship', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the empty entry the tracker shows as "Logistics tracking not found" as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, checks, failures, pages and moved routes apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({ message: 'Too Many Requests' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('<html>Request blocked</html>', { status: 403, headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('', { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('<title>502 Bad Gateway</title>', { status: 502, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response(null, { status: 301, headers: { Location: 'https://www.nextsmartship.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ code: 3, message: 'invalid argument' }))).toMatchObject({ kind: 'indeterminate' });
    // A reply that lists another number says nothing about this one.
    expect(await answer(() => json(fixture('not-found')))).toMatchObject({ kind: 'indeterminate' });
  });
});

describe('Next Smart Ship replies', () => {
  it('reads the Australian sample: its scans as instants, their places and the Australia Post hand-off', () => {
    const sample = sampleEntry(AU);
    const result = parseNextSmartShip(fixture(AU), AU);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-04-09T06:05:36Z', delivered_at: '2026-04-09T06:05:36Z', expected_delivery: null, destination_country: 'AU',
      delivery_carrier: 'australia-post', delivery_tracking_number: sample.last_mile_tracking_number,
    });
    expect(scans(result)).toEqual([
      ['2026-04-09T06:05:36Z', 'Delivered', 'Taralga,AU', 'delivered'],
      ['2026-04-08T02:09:26Z', 'Awaiting collection at TARALGA LPO', 'AU', 'ready_for_pickup'],
      ['2026-04-07T23:43:04Z', 'Transferred', 'AU', 'in_transit'],
      ['2026-04-07T22:03:36Z', 'Accepted by driver for transfer', 'AU', 'in_transit'],
      ['2026-04-07T09:04:26Z', 'Item processed at sorting facility', 'AU', 'in_transit'],
      // Two lines at one instant: the reply's later one is the newer.
      ['2026-04-07T03:36:00Z', 'Received by Australia Post for transportation to processing facility', 'AU', 'in_transit'],
      ['2026-04-07T03:36:00Z', 'Delivered to local carrier', null, 'in_transit'],
      ['2026-04-07T02:36:00Z', 'Arrived at sort facility', null, 'in_transit'],
      ['2026-04-03T09:20:47Z', 'Order is shipped out.', null, 'accepted'],
      ['2026-04-02T08:21:34Z', 'Order is being processed', null, 'registered'],
    ]);
    expect(result.events!.find((event) => event.description === 'Order is shipped out.')).toMatchObject({ stage_source: 'carrier_map' });
    // The last mile's phone and website, the origin and the days in transit stay behind.
    expect(JSON.stringify(result)).not.toMatch(/Tel:|auspost\.com\.au|6\.9/);
  });

  it('reads the US sample: the line’s scans, USPS’s and the USPS hand-off', () => {
    const sample = sampleEntry(US);
    const result = parseNextSmartShip(fixture(US), US);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered, Parcel Locker', last_update: '2026-11-13T00:31:21Z',
      delivered_at: '2026-11-13T00:31:21Z', destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: sample.last_mile_tracking_number,
    });
    expect(result.events).toHaveLength(27);
    expect(result.events![0]).toEqual({ time: '2026-11-13T00:31:21Z', description: 'Delivered, Parcel Locker', location: 'CHARLOTTE, NC 28202',
      stage: 'delivered', stage_source: expect.stringMatching(/^wording:/) });
    // A bracket naming an agent is no place.
    expect(result.events!.find((event) => event.description!.startsWith('Parcel departure in Transit Facility'))).not.toHaveProperty('location');
    expect(result.events!.find((event) => event.description === 'Parcel departure in Shenzhen Sorting Centre.')).toMatchObject({ location: 'Shenzhen' });
    expect(result.events!.find((event) => event.description === 'Customs declaration completed')).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('lets the newest scan say how far the last mile went within In Transit, never past the status', () => {
    const items = sampleEntry(AU).track_detail!.items.slice(0, 8);
    const at = (content: string) => parseNextSmartShip(reply({ status: 'TRACK_STATUS_IN_TRANSIT', items: [...items, item(content, '2026-04-08T02:09:26Z')] }), OTHER);
    expect(at('[AU] Awaiting collection at TARALGA LPO')).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(at('[AU] Onboard for delivery')).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(at('[AU] Delivered')).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(at('[AU] Transferred')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Transferred' });
    // An unknown status leaves the stage to the scans.
    expect(parseNextSmartShip(reply({ status: 'TRACK_STATUS_SOMETHING' }), OTHER)).toMatchObject({ current_stage: 'delivered' });
  });

  it('shows an entry flagged for compensation as Abnormal, as the tracker does', () => {
    expect(parseNextSmartShip(reply({ entry: { oms_compensation_exception: true } }), OTHER))
      .toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', last_status_text: 'Delivered' });
    expect(parseNextSmartShip(reply({ entry: { oms_compensation_exception: true, track_detail: null } }), OTHER)).toMatchObject({
      status: 'exception', current_stage: 'exception', provider_code: 'TRACK_STATUS_EXCEPTION', last_status_text: 'Abnormal', summary_only: true, events: [] });
  });

  it('answers a status without scans by the status, and an entry without either as listed or missing', () => {
    expect(parseNextSmartShip(reply({ status: 'TRACK_STATUS_RECEIVED', items: [] }), OTHER)).toMatchObject({
      status: 'pending', current_stage: 'registered', provider_code: 'TRACK_STATUS_RECEIVED', last_status_text: 'Info Received', summary_only: true, events: [] });
    // The tracker sends the reader to another tracker for this number.
    const linked = () => parseNextSmartShip(reply({ entry: { track_detail: null, tracking_url: 'https://t.17track.net/en' } }), OTHER);
    expect(linked).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed', deliveryCarrier: 'australia-post' }));
    expect(() => parseNextSmartShip(reply({ status: '', items: [] }), OTHER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseNextSmartShip(reply({ entry: { track_detail: {} } }), OTHER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    // Only an entry that holds nothing is missing.
    const empty = { ...fixture('not-found').data.list[0]!, tracking_number: OTHER };
    expect(() => parseNextSmartShip({ code: 0, data: { list: [{ ...empty, track_detail: {} }] } }, OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseNextSmartShip({ code: 0, data: { list: [{ ...empty, last_mile_tracking_number: '34YEM9999999' }] } }, OTHER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', deliveryTrackingNumber: '34YEM9999999' }));
    expect(() => parseNextSmartShip(reply({ status: 'TRACK_STATUS_SOMETHING', items: [] }), OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('hands over only a last-mile carrier whose rules fit the number', () => {
    const sample = sampleEntry(US);
    const routed = parseNextSmartShip(reply({ entry: { ...sample, tracking_number: OTHER,
      last_mile_tracking_number: `42028202${String(sample.last_mile_tracking_number)}` } }), OTHER);
    expect(routed).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: sample.last_mile_tracking_number });
    const unnamed = parseNextSmartShip(reply({ entry: { last_mile_service_provider: 'Some Courier', last_mile_tracking_url: '' } }), OTHER);
    expect(unnamed).not.toHaveProperty('delivery_carrier');
    expect(unnamed).toHaveProperty('delivery_tracking_number', sampleEntry(AU).last_mile_tracking_number);
    const misfit = parseNextSmartShip(reply({ entry: { last_mile_service_provider: 'USPS', last_mile_tracking_url: '' } }), OTHER);
    expect(misfit).not.toHaveProperty('delivery_carrier');
    expect(parseNextSmartShip(reply({ entry: { last_mile_tracking_number: '' } }), OTHER)).not.toHaveProperty('delivery_tracking_number');
  });

  it('flags a delivery estimate it has not seen a reply give', () => {
    expect(parseNextSmartShip(reply({ entry: { estimated_delivery_date: '2026-04-10' } }), OTHER))
      .toMatchObject({ expected_delivery: null, unread_estimates: ['estimated_delivery_date'] });
    expect(parseNextSmartShip(reply(), OTHER)).not.toHaveProperty('unread_estimates');
  });

  it('does not follow an order split into packages under other numbers', () => {
    expect(() => parseNextSmartShip(reply({ entry: { sub_tracks: [sampleEntry(AU)] } }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const changed = [null, {}, { code: '0' }, { code: 0, data: {} }, { code: 0, data: { list: [{ tracking_number: 7 }] } },
      reply({ entry: { track_detail: 'none' } }), reply({ items: 'none' as unknown as Item[] }), reply({ items: [item('Transferred', '2026-04-07 23:43:04')] }),
      reply({ items: [item('Transferred', '2026-02-30T23:43:04Z')] }), reply({ items: [7 as unknown as Item] }), reply({ entry: { sub_tracks: {} } }),
      reply({ entry: { oms_compensation_exception: 'no' } }), reply({ entry: { destination_country: 7 } })];
    for (const payload of changed) {
      expect(() => parseNextSmartShip(payload, OTHER), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('claims its numbers, and the hand-off numbers stay with their carriers', () => {
    for (const number of [US, AU]) expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'next-smart-ship', confidence: 'high' });
    expect(detectCarrierMatch(String(sampleEntry(US).last_mile_tracking_number))).toMatchObject({ carrier: 'usps' });
    expect(detectCarrierMatch(String(sampleEntry(AU).last_mile_tracking_number))).toMatchObject({ carrier: 'australia-post' });
  });
});

describe('Next Smart Ship status vocabulary', () => {
  it('records every status and wording with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      if (entry.code) {
        expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
        expect(statusMapAnswer({ carrier: 'next-smart-ship', providerCode: entry.code, description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
        continue;
      }
      expect(nextSmartShipStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'next-smart-ship', providerCode: null, description: 'Order is shipped out.' })).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMap.stage('TRACK_STATUS_SOMETHING', 'anything')).toBeUndefined();
  });
});
