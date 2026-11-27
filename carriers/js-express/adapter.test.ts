import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JS_EXPRESS_PAGE, JS_EXPRESS_TRACKER, JsExpressTracker } from './adapter.js';
import { jsExpressReceiver, jsExpressReply, jsExpressScan, normalizeJsExpressNumber, parseJsExpress } from './parser.js';
import { jsExpressMappedStage, jsExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'JSEZZ0000000001YQ';
const IN_TRANSIT = 'JSEZZ0000000002YQ';
const UNKNOWN = 'JSEZZ0000000003YQ';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const parsed = (name: string) => JSON.parse(page(name)) as unknown;
// The lookup answers JSON as HTML.
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
interface Row { date?: unknown; address?: unknown; status?: unknown; timeZone?: string }
// One history row, as the lookup writes it.
const row = (date: string, address: string, status: string): Row => ({ date, status, address, timeZone: '+08:00' });
// A reply for the delivered fixture's number, with these rows and waybill fields.
const waybill = (tracking: unknown, fields: Record<string, unknown> = {}) => ({ code: 0, message: 'Success',
  data: [{ jsWaybillNo: DELIVERED, orderNo: 'SN000000000009', trackNo: '', country: 'Canada', pod: [], tracking, ...fields }] });
const withList = (rows: Row[]) => waybill(rows);
const CLOUDFLARE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={};</script></body></html>';

describe('JS Express tracking adapter', () => {
  it('posts the whole number to the lookup once, as the English tracking page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JsExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jsezz 0000000001 yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(JS_EXPRESS_TRACKER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `card_num=${DELIVERED}`,
      headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded',
        Referer: JS_EXPRESS_PAGE, 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'js-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a parcel delivered abroad in the reply\'s order, with the courier\'s place as the location', () => {
    const result = parseJsExpress(parsed('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-12T20:41:05Z', delivered_at: '2026-03-12T20:41:05Z', expected_delivery: null,
      destination_country: 'CA', delivery_carrier: 'straightship', delivery_tracking_number: 'STRCA0000000000018' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map(event => [event.time ?? event.local_time, event.location, event.description, event.stage])).toEqual([
      // Straightship's rows, on the UTC clock of its own page.
      ['2026-03-12T20:41:05Z', 'Sample Town, ON', 'Delivered', 'delivered'],
      // Straightship's round: the delivery follows the same day.
      ['2026-03-12T11:20:44Z', 'Sample Town, ON', 'Package will be delivered before 9:00pm', 'out_for_delivery'],
      ['2026-03-12T08:02:13Z', 'Sample City, ON', 'Package is received at a Straightship station', 'in_transit'],
      ['2026-03-11T17:45:30Z', 'Sample Hub, ON', 'Package is received at a Straightship station', 'in_transit'],
      ['2026-03-11T17:45:30Z', 'Sample Hub, ON', 'Package Received with Origin Scan warehouse', 'in_transit'],
      // Airports' codes keep their wall clocks.
      ['2026-03-09T18:10:09', 'YYZ', 'Delivery to local courier', 'in_transit'],
      ['2026-03-09T12:31:52', 'YYZ', 'Released From Import Customs', 'in_transit'],
      ['2026-03-09T05:02:40', 'YYZ', 'The goods have been picked up abroad', 'in_transit'],
      ['2026-03-08T03:40:11', 'YYZ', 'NOA-Notification of arrival from GHA', 'in_transit'],
      ['2026-03-07T19:55:26', 'YYZ', 'Item Flight landing', 'in_transit'],
      ['2026-03-07T12:14:37', 'YVR', 'Connecting flights flight takeoff', 'in_transit'],
      // Clocks of different countries: the page's order stands. A flight keeps its wall clock, even filed in China.
      ['2026-03-07T10:20:15', 'China', 'Item Flight departure', 'in_transit'],
      ['2026-03-07T05:31:48', 'YVR', 'Initial landing', 'in_transit'],
      // Rows at places in China, on Beijing time.
      ['2026-03-05T21:10:00+08:00', 'China', 'Released From Export Customs', 'in_transit'],
      ['2026-03-05T19:10:00+08:00', 'China', 'Arrive at international airport to abroad', 'in_transit'],
      ['2026-03-05T09:12:30+08:00', 'South China Transit Center', 'Item departed from origin.', 'in_transit'],
      // The row the page lists twice is kept once.
      ['2026-03-04T15:01:22+08:00', 'Dongguan General Warehouse-Operation Center', 'Item outbound in sorting center.', 'in_transit'],
      ['2026-03-04T03:22:05+08:00', 'Dongguan General Warehouse-Operation Center', 'Item inbound in sorting center.', 'in_transit'],
      ['2026-03-04T03:10:47+08:00', 'Dongguan General Warehouse-Operation Center', 'Item has been collected', 'accepted'],
      // Straightship's record of the data moves nothing; an empty 【】 names no place, and the row is on Straightship's UTC.
      ['2026-03-03T19:40:02Z', undefined, 'Package information is created in the system', undefined],
      ['2026-03-03T08:15:33+08:00', 'Dongguan General Warehouse-Operation Center', 'Electronic notification of order creation received.', 'registered'],
    ]);
    expect(result.events!.every(event => Boolean(event.time) !== Boolean(event.local_time))).toBe(true);
    expect(result.events!.filter(event => event.stage).every(event => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('reads the waybill\'s estimate as a day, and Straightship\'s round as its own day, until the end', () => {
    const estimate = (estimateArriveTime: unknown) => parseJsExpress(JSON.parse(page('in-transit').replace('"estimateArriveTime": ""',
      `"estimateArriveTime": ${JSON.stringify(estimateArriveTime)}`)), IN_TRANSIT).expected_delivery;
    expect(estimate('2026-04-22')).toBe('2026-04-22');
    // A clock without a zone keeps its day alone.
    expect(estimate('2026-04-22 23:59:59')).toBe('2026-04-22');
    for (const none of ['', '0000-00-00', '2026-02-30', 'Apr 22', null]) expect(estimate(none)).toBeNull();
    // On Straightship's round, the day in the town's province; a delivery leaves none.
    const onRound = JSON.parse(page('delivered').replace('"estimateArriveTime": ""', '"estimateArriveTime": "2026-03-14"')) as
      { data: { tracking: unknown[] }[] };
    expect(parseJsExpress(onRound, DELIVERED).expected_delivery).toBeNull();
    onRound.data[0]!.tracking.shift();
    expect(parseJsExpress(onRound, DELIVERED)).toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: '2026-03-12' });
    onRound.data[0]!.tracking.shift();
    expect(parseJsExpress(onRound, DELIVERED)).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2026-03-14' });
  });

  it('reads a parcel announced at the destination airport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('in-transit')));
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    // The airport's row keeps its wall clock, so the last update has no instant.
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'NOA-Notification of arrival from GHA', last_update: null, last_update_local: '2026-04-16T06:12:00' });
    expect(result.events).toHaveLength(16);
    expect(result.events!.slice(0, 3)).toEqual([
      { local_time: '2026-04-16T06:12:00', location: 'AMS', description: 'NOA-Notification of arrival from GHA', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-04-15T22:30:00', location: 'AMS', description: 'Item Flight landing', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-04-15T22:30:00', location: 'AMSTERDAM', description: 'ARRIVED AT DESTINATION AIRPORT', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.find(event => event.description === 'SHIPPING INFORMATION RECEIVED')).toEqual(
      { local_time: '2026-04-15T10:44:18', description: 'SHIPPING INFORMATION RECEIVED' });
    expect(result.events!.at(-1)).toEqual({ time: '2026-04-11T23:10:58+08:00', location: 'China, Transit Center',
      description: 'Electronic notification of order creation received.', stage: 'registered', stage_source: 'carrier_map' });
    // Rows at places in China are on Beijing time; the flights and the rows at Hong Kong, Amsterdam or no place keep their wall clocks.
    expect(result.events!.filter(event => event.time).map(event => [event.time, event.location])).toEqual([
      ['2026-04-14T21:58:00+08:00', 'China'],
      ['2026-04-14T19:58:00+08:00', 'China'],
      ['2026-04-14T09:01:36+08:00', 'South China Transit Center'],
      ['2026-04-14T01:06:50+08:00', 'China, Transit Center'],
      ['2026-04-13T22:35:12+08:00', 'China, Transit Center'],
      ['2026-04-13T17:44:09+08:00', 'China, Transit Center'],
      ['2026-04-11T23:10:58+08:00', 'China, Transit Center'],
    ]);
    expect(fetcher.mock.calls[0]![1]!.body).toBe(`card_num=${IN_TRANSIT}`);
  });

  it('dates rows at places in China on Beijing time, and keeps flights, airports\' codes and other places on their wall clocks', () => {
    const clocks = (...rows: Row[]) => parseJsExpress(withList(rows), DELIVERED).events!.map(event => event.time ?? event.local_time);
    expect(clocks(
      // The country, a region, a province and cities, each opening the label.
      row('2026-05-01 09:00:00', 'China', 'Released From Export Customs'),
      row('2026-05-01 08:00:00', 'China,  Transit Center', 'Item outbound in sorting center.'),
      row('2026-05-01 07:00:00', 'East China Transit Center', 'Item departed from origin.'),
      row('2026-05-01 06:00:00', 'Zhejiang', 'Domestic allocation has begun'),
      row('2026-05-01 05:00:00', 'Yiwu Sorting Center', 'Item inbound in sorting center.'),
      row('2026-05-01 04:00:00', "Xi'an Operation Center", 'Item has been collected'),
      // A warehouse written in Chinese.
      row('2026-05-01 03:00:00', '示例总仓库-操作中心', 'Item has been collected'),
    )).toEqual(['2026-05-01T09:00:00+08:00', '2026-05-01T08:00:00+08:00', '2026-05-01T07:00:00+08:00', '2026-05-01T06:00:00+08:00',
      '2026-05-01T05:00:00+08:00', '2026-05-01T04:00:00+08:00', '2026-05-01T03:00:00+08:00']);
    expect(clocks(
      // A flight filed in China, an airport's code in China, Hong Kong and no place.
      row('2026-05-02 09:00:00', 'China', 'Item Flight departure'),
      row('2026-05-02 08:00:00', 'Sample Town', 'Connecting flights flight takeoff'),
      row('2026-05-02 07:00:00', 'TNA', 'Arrive at international airport to abroad'),
      row('2026-05-02 06:00:00', 'HONG KONG', 'UPLIFTED FROM TRANSSHIPMENT HUB'),
      row('2026-05-02 05:00:00', '', 'Arrive at transit center'),
      // Towns abroad that start like China's names, a town named China in a US state, and a center no name places.
      row('2026-05-02 04:00:00', 'China Grove', 'Out for delivery'),
      row('2026-05-02 03:30:00', 'Chinatown', 'Out for delivery'),
      row('2026-05-02 03:00:00', 'China', 'Delivered (China, ME)'),
      row('2026-05-02 02:00:00', 'Sample General Warehouse-Operation Center', 'Item has been collected'),
      // Hong Kong, written in its script.
      row('2026-05-02 01:30:00', '香港转运中心', 'Arrive at transit center'),
    )).toEqual(['2026-05-02T09:00:00', '2026-05-02T08:00:00', '2026-05-02T07:00:00', '2026-05-02T06:00:00', '2026-05-02T05:00:00',
      '2026-05-02T04:00:00', '2026-05-02T03:30:00', '2026-05-02T03:00:00', '2026-05-02T02:00:00', '2026-05-02T01:30:00']);
    // GOFO's regional agency at its site code, on a parcel to France, is on France's clock, not an airport's of that code.
    const gofo = (country: string) => parseJsExpress(waybill([row('2026-11-23 15:17:10', 'MSL', 'Arrived at GOFO Regional Destination Facility')],
      { country }), DELIVERED).events!.map((event) => event.time ?? event.local_time);
    expect([gofo('France'), gofo('United States')]).toEqual([['2026-11-23T15:17:10+01:00'], ['2026-11-23T15:17:10']]);
    // Places written in Japanese, in kana or with a courier branch's kanji, are on Japan's clock, whatever offset JS Express gives them.
    expect(clocks(
      row('2026-05-03 02:00:00', '見本営業所', 'The package delivery failed'),
      row('2026-05-03 01:00:00', '東京センター', 'Arrive at transit center'),
    )).toEqual(['2026-05-03T02:00:00+09:00', '2026-05-03T01:00:00+09:00']);
  });

  it('dates Straightship\'s rows on UTC only in a history that names it, and keeps other couriers\' wall clocks', () => {
    const clocks = (...rows: Row[]) => parseJsExpress(withList(rows), DELIVERED).events!.map(event => [event.time ?? event.local_time, event.location]);
    const attempt = 'An attempt was made to deliver your package-consignee closed (please e-mail SS@straightship.com to make arrangement)';
    expect(clocks(
      row('2026-05-03 21:10:00', 'Sample Town', 'Delivered (Sample Town, BC)'),
      // An attempt without a place names Straightship.
      row('2026-05-02 20:00:00', '', attempt),
      row('2026-05-02 08:00:00', 'Sample City', 'Package is received at a Straightship station (Sample City, BC)'),
      // A town of a US state and an airport's code keep their wall clocks.
      row('2026-05-01 12:00:00', 'Sample Port', 'Delivered (Sample Port, WA)'),
      row('2026-05-01 10:00:00', 'YVR', 'Delivery to local courier'),
      // Straightship's record of the data, as its own page dates it.
      row('2026-04-28 19:00:00', '', 'Package information is created in the system'),
    )).toEqual([
      ['2026-05-03T21:10:00Z', 'Sample Town, BC'],
      ['2026-05-02T20:00:00Z', undefined],
      ['2026-05-02T08:00:00Z', 'Sample City, BC'],
      ['2026-05-01T12:00:00', 'Sample Port, WA'],
      ['2026-05-01T10:00:00', 'YVR'],
      ['2026-04-28T19:00:00Z', undefined],
    ]);
    // Without a row naming Straightship, a courier's town and province and a record of the data are no clock.
    expect(clocks(row('2026-05-03 21:10:00', 'Sample Town', 'Delivered (Sample Town, BC)'),
      row('2026-05-02 08:00:00', 'Sample City', 'Package arrived at transit station (Sample City, BC)'),
      row('2026-04-28 19:00:00', '', 'Package information is created in the system')))
      .toEqual([['2026-05-03T21:10:00', 'Sample Town, BC'], ['2026-05-02T08:00:00', 'Sample City, BC'], ['2026-04-28T19:00:00', undefined]]);
  });

  it('follows the newest row\'s instant with the last update, and a dated delivery\'s with the delivery time', () => {
    const read = (...rows: Row[]) => {
      const { current_stage, last_update, last_update_local, delivered_at } = parseJsExpress(withList(rows), DELIVERED);
      return { current_stage, last_update, last_update_local, delivered_at };
    };
    const china = [row('2026-05-01 18:00:00', 'Sample Hub', 'Package information is created in the system'),
      row('2026-05-01 09:00:00', 'Shenzhen Sorting Center', 'Item has been collected')];
    // In China: the collection's instant, though an older-looking record of the data has none.
    expect(read(china[1]!)).toEqual({ current_stage: 'accepted', last_update: '2026-05-01T09:00:00+08:00', last_update_local: undefined, delivered_at: undefined });
    // A newer row without an instant leaves the last update a wall clock.
    expect(read(...china)).toEqual({ current_stage: 'accepted', last_update: null, last_update_local: '2026-05-01T18:00:00', delivered_at: undefined });
    expect(read(row('2026-05-03 10:00:00', 'China', 'Item Flight departure'), china[1]!))
      .toMatchObject({ last_update: null, last_update_local: '2026-05-03T10:00:00' });
    // Straightship's delivery dates the parcel's delivery.
    const straightship = [row('2026-05-09 08:00:00', 'Sample City', 'Package is received at a Straightship station (Sample City, ON)'),
      row('2026-05-08 19:00:00', 'YYZ', 'Delivery to local courier'), china[1]!];
    expect(read(...straightship)).toEqual({ current_stage: 'in_transit', last_update: '2026-05-09T08:00:00Z', last_update_local: undefined, delivered_at: undefined });
    expect(read(row('2026-05-10 17:30:00', 'Sample Town', 'Delivered (Sample Town, ON)'), ...straightship))
      .toEqual({ current_stage: 'delivered', last_update: '2026-05-10T17:30:00Z', last_update_local: undefined, delivered_at: '2026-05-10T17:30:00Z' });
    // Another courier's delivery keeps its wall clock, and gives no delivery time.
    const imile = [row('2026-05-10 15:40:00', 'Sample01', '【Sample01】Delivered, Receiver Type:【Self】.'), row('2026-05-08 19:00:00', 'LGG', 'Delivery to local courier'), china[1]!];
    expect(read(...imile))
      .toEqual({ current_stage: 'delivered', last_update: null, last_update_local: '2026-05-10T15:40:00', delivered_at: undefined });
    // It keeps iMile's receiver type in its wording and gives it as who took the parcel.
    const kept = parseJsExpress(withList(imile), DELIVERED);
    expect(kept).toMatchObject({ signed_by: 'Self', last_status_text: '【Sample01】Delivered, Receiver Type:【Self】.' });
    expect(kept.events![0]).toMatchObject({ description: '【Sample01】Delivered, Receiver Type:【Self】.', stage: 'delivered' });
  });

  it('moves a courier\'s place into the location, stages a delivery without who took it and drops phone numbers', () => {
    expect(jsExpressScan('Delivered (Sample Town, ON)', 'Sample Town')).toEqual({ description: 'Delivered', location: 'Sample Town, ON' });
    // A place the label does not name stays in the wording.
    expect(jsExpressScan('Held at depot (weekend)', 'Sample Town')).toEqual({ description: 'Held at depot (weekend)', location: 'Sample Town' });
    expect(jsExpressScan('Delivered (Sample Town, ON)', '')).toEqual({ description: 'Delivered (Sample Town, ON)', location: '' });
    expect(jsExpressScan('Delivered, signed by A SAMPLE PERSON', 'Sample Town').description).toBe('Delivered');
    expect(jsExpressScan('Delivered - received by A SAMPLE PERSON (Sample Town, ON)', 'Sample Town').description).toBe('Delivered');
    expect(jsExpressScan('Delivered Signature: SAMPLE', 'Sample Town').description).toBe('Delivered');
    // The wording shown keeps who took the parcel, and the name is read from it.
    const kept = jsExpressScan('Delivered - received by A SAMPLE PERSON (Sample Town, ON)', 'Sample Town', { receiver: true });
    expect(kept).toEqual({ description: 'Delivered - received by A SAMPLE PERSON', location: 'Sample Town, ON' });
    expect(jsExpressReceiver(kept.description)).toBe('A SAMPLE PERSON');
    expect(jsExpressReceiver('Delivered Signature: SAMPLE')).toBe('SAMPLE');
    expect(jsExpressReceiver('Delivered, signed')).toBe('');
    expect(jsExpressReceiver('【Sample DS】Delivered, Receiver Type:【Mailbox】.')).toBe('');
    expect(jsExpressReceiver('Package received by Sample Station')).toBe('');
    const signed = parseJsExpress(withList([row('2026-05-10 17:30:00', 'Sample Town', 'Delivered, signed by A SAMPLE PERSON'),
      row('2026-05-08 19:00:00', 'YYZ', 'Delivery to local courier')]), DELIVERED);
    expect(signed).toMatchObject({ current_stage: 'delivered', signed_by: 'A SAMPLE PERSON',
      events: [{ description: 'Delivered, signed by A SAMPLE PERSON', stage: 'delivered' }, {}] });
    expect(jsExpressScan('Delivery attempted, call +1 555 000 0000', 'Sample Town').description).toBe('Delivery attempted, call');
    // JS Express's own notice loses the label of the local office's number with it.
    expect(jsExpressScan('收件人地址不详或有误，派送失败，麻烦让收件人联系下当地，当地电话：555 0000 0000', 'US').description)
      .toBe('收件人地址不详或有误，派送失败，麻烦让收件人联系下当地');
    // Its English, the number gone and a slash left after the label.
    const notice = 'The delivery address is incorrect. Please ask the recipient to contact their local area? Local phone number:/';
    expect(jsExpressScan(notice, 'US').description).toBe('The delivery address is incorrect. Please ask the recipient to contact their local area?');
    expect(jsExpressScan(notice.replace(':/', ':/555 0000 0000'), 'US').description)
      .toBe('The delivery address is incorrect. Please ask the recipient to contact their local area?');
    expect(jsExpressScan('Delivery failed. Phone: +1 555 000 0000', 'Sample Town').description).toBe('Delivery failed.');
    // A label without a letter names no place, and the row reads as it would without one.
    expect(jsExpressScan(notice, '1')).toEqual({ description: 'The delivery address is incorrect. Please ask the recipient to contact their local area?', location: '' });
    // Nor does the tracker's "Array" for a partner's place it holds as a list.
    expect(jsExpressScan('Arrival from abroad', 'Array')).toEqual({ description: 'Arrival from abroad', location: '' });
    expect(jsExpressScan('Arrival from abroad', 'Arrayville')).toEqual({ description: 'Arrival from abroad', location: 'Arrayville' });
    const history = (label: string) => parseJsExpress(withList([
      row('2026-05-03 10:20:00', label, notice),
      row('2026-05-02 09:00:00', 'Sample Town, NY', 'Departed USPS Facility'),
    ]), DELIVERED).events?.[0];
    expect(history('1')).toEqual(history(''));
    // The notice waits for the recipient's answer about the address: an exception, not a missed round.
    expect(history('')).toMatchObject({ stage: 'exception', stage_source: 'carrier_map' });
    expect(jsExpressMappedStage('收件人地址不详或有误，派送失败，逾期退回或销毁的具体费用以账单为准，麻烦让收件人联系下当地')).toBe('exception');
    expect(history('1')).not.toHaveProperty('location');
    // The row stored with it is taken over by the row without it, and only such a row.
    const policy = sameInstantIdentityPolicy('js-express', { supportsScanMatching: true });
    const scan = { stage: 'exception', description: history('')!.description!, location: '', providerCode: '' };
    expect(policy?.matches?.(scan, { ...scan, location: '1' })).toBe(true);
    expect(policy?.matches?.(scan, { ...scan, location: 'Sample Town, NY' })).toBe(false);
    // So is a row stored at the tracker's "Array", whatever stage it had, and an iMile delivery stored with its receiver type.
    const collection = { stage: 'ready_for_pickup', description: 'Item arrival at collection point for pick-up', location: '', providerCode: '' };
    expect(policy?.matches?.(collection, { ...collection, location: 'Array', stage: 'in_transit' })).toBe(true);
    expect(policy?.matches?.(collection, { ...collection, location: 'Array', description: 'Arrival from abroad' })).toBe(false);
    expect(policy?.matches?.({ ...collection, location: 'Sample Town' }, { ...collection, location: 'Array' })).toBe(false);
    const delivered = { stage: 'delivered', description: '【Sample DS】Delivered.', location: 'Sample DS', providerCode: '' };
    expect(policy?.matches?.(delivered, { ...delivered, description: '【Sample DS】Delivered, Receiver Type:【Self or family】.' })).toBe(true);
    expect(policy?.matches?.(delivered, { ...delivered, description: '【Other DS】Delivered, Receiver Type:【Self or family】.' })).toBe(false);
    expect(policy?.matches?.(delivered, { ...delivered, description: '【Sample DS】Delivered.', location: 'Other DS' })).toBe(false);
    // A delivery stored without the clause is taken over by the row that now keeps it.
    expect(policy?.matches?.({ ...delivered, description: '【Sample DS】Delivered, Receiver Type:【Self or family】.' }, delivered)).toBe(true);
    const courier = { stage: 'delivered', description: 'Delivered, signed by A SAMPLE PERSON', location: 'Sample Town, ON', providerCode: '' };
    expect(policy?.matches?.(courier, { ...courier, description: 'Delivered' })).toBe(true);
    expect(policy?.matches?.(courier, { ...courier, description: 'Delivered to neighbour' })).toBe(false);
    // China Post's scan from the feed that keeps seconds and the office's code takes over, less than a minute away,
    // the row from the feed that keeps minutes and the town, in the same words or China Post's two for one arrival,
    // and the other way round.
    expect(policy).toMatchObject({ matchWithinMinute: true });
    const post = { stage: 'in_transit', description: '邮件离开【示例中心】，正在发往下一站', location: '示例市 00000001', providerCode: 'OIT' };
    expect(policy?.matches?.(post, { ...post, location: '示例市' })).toBe(true);
    expect(policy?.matches?.({ ...post, location: '示例市' }, post)).toBe(true);
    const arrival = { ...post, description: '邮件到达【示例中心】' };
    expect(policy?.matches?.(arrival, { ...arrival, description: '快件到达【示例中心】，示例口号！', location: '示例市' })).toBe(true);
    for (const stored of [{ ...post, location: '示例市' }, { ...arrival, location: '别的市' }, { ...arrival, location: '示例市 00000002' }, arrival,
      { ...arrival, description: '快件到达【别的中心】', location: '示例市' }, { ...arrival, location: '示例市', providerCode: 'OPU' }]) {
      expect(policy?.matches?.(arrival, stored), JSON.stringify(stored)).toBe(false);
    }
    // Only a delivery's wording loses a "by" clause.
    expect(jsExpressScan('Picked up by the airline', 'HKG').description).toBe('Picked up by the airline');
  });

  it('stages new wording through the shared rules and keeps the rest without a stage', () => {
    const one = (wording: string) => parseJsExpress(withList([row('2026-05-01 09:00:00', 'Sample Town', wording)]), DELIVERED);
    expect(one('Out for delivery')).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    const unknown = one('Sample counter scan');
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample counter scan', last_update_local: '2026-05-01T09:00:00' });
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events).toEqual([{ local_time: '2026-05-01T09:00:00', location: 'Sample Town', description: 'Sample counter scan' }]);
    // A partner's record of the data is the newest row: the older scan sets the stage.
    const recorded = parseJsExpress(withList([row('2026-05-01 10:00:00', '', 'SHIPMENT CREATED'),
      row('2026-05-01 09:00:00', 'Sample Center', 'Item has been collected')]), DELIVERED);
    expect(recorded).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'SHIPMENT CREATED' });
  });

  it('keeps the stage of the scan before an e-mail to the recipient', () => {
    const notified = parseJsExpress(withList([{ ...row('2026-05-02 11:00:00', '', 'E-MAIL NOTIFICATION HAS BEEN SENT TO THE RECIPIENT.'), code: 'OIT' } as Row,
      row('2026-05-02 09:00:00', 'Sample Town', 'Out for delivery')]), DELIVERED);
    expect(notified).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(notified.events?.[0]?.stage).toBeUndefined();
    expect(statusMap.stage('OIT', normalizeStatusWording('E-MAIL NOTIFICATION HAS BEEN SENT TO THE RECIPIENT.'))).toBeUndefined();
  });

  it("stages a customs warehouse's inbound, and a courier's announcement of the parcel moves nothing", () => {
    const announced = parseJsExpress(withList([
      row('2026-05-02 10:00:00', 'Sample Town', 'Your package is being prepared by the sender and will be handed over to us soon'),
      row('2026-05-02 09:00:00', 'AMS', 'Inbound to customs temporary warehouse')]), DELIVERED);
    expect(announced).toMatchObject({ status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map' });
    expect(announced.events?.map((event) => [event.stage, event.stage_source])).toEqual([[undefined, undefined], ['customs', 'carrier_map']]);
  });

  it.each([
    'Your package is being prepared by the sender and will be handed over to us soon',
    'Your parcel will soon be handed over to us! It is being prepared by the sender.',
    'PRE-ADVICE',
  ])("leaves a partner's pre-advice %s, coded like the scans, without a stage", (wording) => {
    const advised = parseJsExpress(withList([{ ...row('2026-05-03 10:00:00', '', wording), code: 'OIT' } as Row,
      row('2026-05-02 09:00:00', 'Sample Center', 'Item has been collected')]), DELIVERED);
    expect(advised).toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
    expect(advised.events?.[0]?.stage).toBeUndefined();
    expect(statusMap.stage('OIT', normalizeStatusWording(wording))).toBeUndefined();
  });

  it('reads the rows after Colissimo sends the parcel back as the way back, and its delivery as the return', () => {
    const back = parseJsExpress(withList([
      row('2026-05-09 08:45:00', 'FR', "Votre colis est livré à son expéditeur à la suite d'un retour."),
      row('2026-05-08 23:27:00', 'FR', 'Votre colis est en transit sur nos plateformes logistiques.'),
      row('2026-05-06 06:14:00', 'FR', '到达待取'),
      row('2026-05-02 12:29:00', 'FR', "Votre Colissimo n'a pas pu vous être livré en raison d'un problème d'adresse. Il va être retourné à l'expéditeur."),
      row('2026-05-01 07:25:00', 'FR', 'Votre Colissimo est en cours de traitement sur le site de tri local.'),
    ]), DELIVERED);
    expect(back.events!.map((event) => [event.stage, event.provider_leg])).toEqual([
      ['returned', 'return'], ['exception', 'return'], ['exception', 'return'], ['exception', undefined], ['in_transit', undefined]]);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned' });
    const waiting = parseJsExpress(withList([row('2026-05-06 06:14:00', 'FR', '到达待取'),
      row('2026-05-02 12:29:00', 'FR', "Votre Colissimo n'a pas pu vous être livré en raison d'un problème d'adresse. Il va être retourné à l'expéditeur.")]), DELIVERED);
    expect(waiting).toMatchObject({ current_stage: 'exception', current_stage_source: 'carrier_map' });
  });

  it('shows its own status in Chinese in English, staged as the Chinese, and the map stages the English too', () => {
    const waiting = parseJsExpress(withList([row('2026-05-03 09:00:00', 'FR', '到达待取')]), DELIVERED);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'Arrived, awaiting collection' });
    expect(waiting.events).toMatchObject([{ description: 'Arrived, awaiting collection', stage: 'ready_for_pickup', stage_source: 'carrier_map' }]);
    expect(statusMap.stage(null, normalizeStatusWording('Arrived, awaiting collection'))).toBe('ready_for_pickup');
    expect(statusMap.stage('OIT', normalizeStatusWording('Start on-site transportation and shipment'))).toBe('in_transit');
  });

  it.each(['Item delivery operation', '飞机进港，飞机进港（到达目的地）'])('reads the JS Express transit scan %s', (wording) => {
    const scan = { ...row('2026-05-03 09:00:00', '', wording), code: 'OIT' };
    const result = parseJsExpress(withList([scan]), DELIVERED);
    expect(result.events![0]).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('records the bracketed iMile self-pickup agreement as an intentional gap', () => {
    const wording = 'The delivery method has been confirmed with the recipient as 【self-pickup】.';
    const scan = { ...row('2026-05-03 09:00:00', '', wording), code: 'OIT' };
    const result = parseJsExpress(withList([scan]), DELIVERED);
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: wording })).toMatchObject({ kind: 'intentional_gap' });
  });

  it("reads iMile's lines relayed without their centre: the airport receipt with its flight, and a booked re-delivery day", () => {
    const flight = 'Origin port warehouse receive，Flight Schedule ETD【HKG】2030-01-02 04:05:13, ETA【AMS】2030-01-03 06:08:36.';
    expect(jsExpressStage(flight, 'OIT')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: flight })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    const booked = 'NDR re-delivery audit confirmed,appointment date [2030-01-07]';
    const scan = { ...row('2030-01-03 09:40:00', '', booked), code: 'OIT' };
    const result = parseJsExpress(withList([scan]), DELIVERED);
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: booked })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: 'NDR re-delivery audit confirmed' })).toEqual({ kind: 'unknown' });
  });

  it("reads USPS's forwarding alert, which names its time, day and town, as the parcel going on", () => {
    const alert = 'Alert, Forwarded -> Your item was forwarded to a different address at 7:00 am on January 2, 2030 in SAMPLE TOWN, MA. '
      + 'This was because of forwarding instructions or because the address or ZIP Code on the label was incorrect.';
    expect(jsExpressMappedStage(alert)).toBe('in_transit');
    expect(statusMapAnswer({ carrier: 'js-express', description: alert })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(jsExpressMappedStage('Alert, Forwarded')).toBeUndefined();
  });

  it('reads its notice that the destination courier holds a parcel it could not deliver, whatever contacts follow, as an exception', () => {
    const notice = '交货异常，投递失败，逾期退回或销毁的具体费用以账单为准，麻烦让收件人联系当地，当地电话：邮箱：support@example.com';
    expect(jsExpressStage(notice, 'FFW')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'FFW', description: notice })).toEqual({ kind: 'mapped', stage: 'exception' });
  });

  it("reads USPS's status before its sentence about the item or the package by the status's own entry, and USPS's row between facilities", () => {
    const arrived = 'On the Way, Arrived at USPS Facility -> Your item arrived at our USPS facility in SAMPLE TOWN DISTRIBUTION CENTER '
      + 'on January 2, 2030 at 12:05 am. The item is currently in transit to the destination.';
    expect(jsExpressStage(arrived, 'OIT')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: arrived })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(jsExpressMappedStage('On the Way, Sample Status -> Your item is somewhere')).toBeUndefined();
    expect(jsExpressStage('In Transit to Next Facility', 'OIT')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    const onTime = 'On the Way, In Transit, Arriving On Time -> Your package is moving within the USPS network and is on track to be '
      + 'delivered by the expected delivery date. As of 12:05 am on January 2, 2030, it is currently in transit to the next facility.';
    expect(jsExpressStage(onTime, 'OIT')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: onTime })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it("reads the posts' IPS scans after their country, China Post's posting as on its way, and China Post's destination labels", () => {
    const rows: readonly (readonly [string, string, string])[] = [
      ['OIT', 'CHINA Posting of item', 'in_transit'],
      ['OIT', 'CHINA Receive item at origin country gateway', 'in_transit'],
      ['OCP', 'CHINA Send item to customs', 'customs'],
      ['OIT', 'CHINA Dispatch item to destination country', 'in_transit'],
      ['OIT', 'PHILIPPINES Receive at country of destination', 'in_transit'],
      ['OCP', 'PHILIPPINES Send item to customs', 'customs'],
      ['OCE', 'PHILIPPINES Returned from Customs (CUSTOMS STATUS: Import authorized, no taxes or duties to be paid, Amount: PhP0.00 )', 'in_transit'],
      ['OIT', 'PHILIPPINES Enroute to delivery office', 'in_transit'],
      ['DCF', '寄达地海关允许进口（无需缴税）', 'in_transit'],
    ];
    for (const [code, wording, stage] of rows) {
      expect(jsExpressStage(wording, code), wording).toEqual({ stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'js-express', providerCode: code, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    // A name that is no country, or a country's code, does not stand for the office's country.
    expect(jsExpressMappedStage('SAMPLELAND Receive at country of destination')).toBeUndefined();
    expect(jsExpressMappedStage('CN Send item to customs')).toBeUndefined();
  });

  it("reads SpeedX's day-end delay, relayed under DDE, as the parcel still on its way", () => {
    expect(jsExpressStage('Delay in transit', 'DDE')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'DDE', description: 'Delay in transit' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it("reads USPS's address problem after its round as a missed delivery, and the return it starts as not yet back", () => {
    expect(jsExpressStage('Insufficient Address', 'DDE')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'DDE', description: 'Insufficient Address' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(jsExpressStage('Return to Sender', 'DRS')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'DRS', description: 'Return to Sender' })).toEqual({ kind: 'mapped', stage: 'exception' });
    // iMile's centre receiving the returning parcel, as JS Express relays its return handling.
    expect(jsExpressStage('【AUT RDC】Shipment received.', 'DOP')).toEqual({ stage: 'exception', source: 'carrier_map' });
  });

  it("reads the clearance agent's wait at the cargo terminal as transit and its pickup as customs, and a call to the recipient as moving nothing", () => {
    for (const [code, description, stage] of [
      ['OIT', 'Arrived at export center', 'in_transit'], ['OIT', 'Exports Center Sorting and Packing', 'in_transit'], ['OIT', 'Arrived at Origin Port', 'in_transit'],
      ['OIT', 'The customs clearance agent is queuing up to pick up the goods', 'in_transit'],
      ['OIT', 'The customs clearance agent has picked up the goods', 'customs'],
      ['DCF', 'Released from customs: customs cleared.', 'in_transit'], ['OIT', 'Depart from the destination distribution center.', 'in_transit'],
      ['OIT', 'Accepted at USPS Facility', 'in_transit'], ['DOP', 'Enviado', 'in_transit'], ['OIT', 'Nuevo reparto', 'in_transit'], ['OIT', 'Label creation', 'registered'],
      ['DDE', 'Incidencia en el reparto', 'exception'], ['DDE', 'Incidencia en el reparto.Dirección incorrecta', 'exception'], ['DRS', 'En devolución', 'exception'], ['OIT', 'Consignee Contacted', 'pending'],
      ['DZT', 'The recipient has selected a Packstation as the new delivery address.', 'pending'],
      ['OIT', 'There is a preferred location/neighbour for this item.', 'pending'],
      ['OIT', 'PREFERRED APM APPLIED', 'pending'], ['DZT', 'REDIRECT TO LOCKER', 'pending'], ['OIT', 'SCANNED AS PART OF SECURE PROCESS', 'in_transit'],
    ] as const) {
      expect(jsExpressStage(description, code), description).toEqual({ stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'js-express', providerCode: code, description }), description).toEqual({ kind: 'mapped', stage });
    }
  });

  it("reads Canada Post's records abroad, relayed after JS Express's own acceptance, and a transfer station as transit", () => {
    for (const description of [
      'International item mailed in originating country', 'International item processed in originating country',
      'International item has left originating country and is en route to Canada', '中转站转运中',
    ]) {
      expect(jsExpressStage(description, 'OIT'), description).toEqual({ stage: 'in_transit', source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description }), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
  });

  it("reads the destination courier's sorting before its own scans, and GOFO France's departure relayed, as transit", () => {
    for (const description of [
      'Being processed at local sorting center', 'Sorting completed, awaiting transshipment', 'The package left sorting center',
    ]) {
      expect(jsExpressStage(description, 'OIT'), description).toEqual({ stage: 'in_transit', source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description }), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
  });

  it("reads FedEx's status between its facilities on the line it delivers", () => {
    expect(jsExpressStage('On the way', 'OIT')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: 'On the way' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it("reads China Post's express item arriving at a centre, slogan and all, as its mail arriving", () => {
    const arrived = '快件到达【示例集散中心】，该处理中心已实现光伏绿色能源供电，绿色邮政，绿动未来！';
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: arrived })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: '快件离开【示例集散中心】' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it("reads China Post's flight landing between the airline's departures as the journey", () => {
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: '飞机进港' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(jsExpressStage('飞机进港', 'OIT')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });

  it("reads iMile's scans as its destination courier by iMile's sentences, whichever centres they name", () => {
    for (const [wording, stage] of [
      ['【iMile Sample DC Center】Received.', 'in_transit'],
      ['【iMile Sample DC Center】Parcel shipped to【Sample01】.', 'in_transit'],
      ['【Other Hub】Parcel shipped to【Other02】.', 'in_transit'],
      ['【Other Hub】Shipment dispatched.', 'in_transit'],
      ['【Sample DS】Shipment out for delivery.', 'out_for_delivery'],
      ['【Sample DS】Delivered.', 'delivered'],
    ] as const) {
      expect(jsExpressMappedStage(wording), wording).toBe(stage);
      expect(statusMapAnswer({ carrier: 'js-express', description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    // iMile's delivery is staged without who took the parcel.
    expect(jsExpressScan('【Sample DS】Delivered, Receiver Type:【Self or family】.', 'Sample DS').description).toBe('【Sample DS】Delivered.');
    // Only a wording that opens with a centre's name in 【】 is iMile's; a scan that moves nothing has no stage.
    expect(jsExpressMappedStage('Parcel shipped to【Sample01】.')).toBeUndefined();
    expect(jsExpressMappedStage('【Sample Hub】Inventory count scan.')).toBeUndefined();
  });

  it("reads J&T Express Germany's German scans by their entries, whichever district and sites they name", () => {
    for (const wording of [
      '【Sample District】【Sample000】Ihr Sendung wurde abgeholt.',
      '【Sample District】Die Sendung hat【Sample000】verlassen. Weiterversand nach【Sample HUB】',
      '【Other District】Die Sendung hat【Sample HUB】verlassen. Weiterversand nach【SMP001】',
      '【Other District】Die Sendung ist bei【Sample HUB】 angekommen.',
      '【Sample, Stadt】Die Sendung ist bei【SMP001】 angekommen.',
    ]) {
      expect(jsExpressMappedStage(wording), wording).toBe('in_transit');
      expect(jsExpressStage(wording, 'OIT'), wording).toEqual({ stage: 'in_transit', source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: wording }), wording).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    // The places are dropped only from a wording that opens with one; the sentence itself must match.
    expect(jsExpressMappedStage('Die Sendung ist bei【Sample HUB】 angekommen.')).toBeUndefined();
    expect(jsExpressMappedStage('【Sample District】Die Sendung wurde umgeleitet.')).toBeUndefined();
    // Its return to a hub, named in square brackets, under the return code: the parcel goes back.
    expect(jsExpressStage('Ihre Sendung ist zu [Sample HUB] zurückgekehrt.', 'DRS')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'DRS', description: 'Ihre Sendung ist zu [Other HUB] zurückgekehrt.' }))
      .toEqual({ kind: 'mapped', stage: 'exception' });
    expect(jsExpressMappedStage('Ihre Sendung ist zu Sample HUB zurückgekehrt.')).toBeUndefined();
  });

  it("dates J&T Express Germany's rows by the offset they state, and other rows as before", () => {
    const stated = (date: string, address: string, status: string, timeZone: string, code = 'OIT') => ({ ...row(date, address, status), timeZone, code });
    const result = parseJsExpress(waybill([
      stated('2026-11-04 12:17:18', 'SMP001', 'Ihr Paket wurde erfolgreich zugestellt. Die Zustellart ist 【Sample】 .', '-01:00', 'DSD'),
      stated('2026-11-04 05:58:24', 'SMP001', 'Die Sendung von 【Sample GmbH】 in 【Sample District】 ist unterwegs zur Zustellung.', '-01:00', 'DIG'),
      stated('2026-11-04 05:53:00', 'Sample HUB', '【Sample District】Die Sendung ist bei【Sample HUB】 angekommen.', '-01:00'),
      stated('2026-11-03 09:46:00', 'Sample Town', 'Delivery to local courier', '+01:00'),
      stated('2026-11-02 14:30:00', 'AMS', 'Item Flight landing', '+01:00'),
      stated('2026-10-30 17:52:27', '', 'Die Auftragsdaten für diese Sendung wurden elektronisch an J&T Express übermittelt', '-01:00'),
      stated('2026-10-30 16:59:57', 'Sample Center', 'Item has been collected', '+08:00', 'OPU'),
    ], { country: 'Germany' }), DELIVERED);
    expect(result.events?.map((event) => event.time ?? event.local_time)).toEqual([
      '2026-11-04T12:17:18-01:00', '2026-11-04T05:58:24-01:00', '2026-11-04T05:53:00-01:00',
      '2026-11-03T09:46:00', '2026-11-02T14:30:00', '2026-10-30T17:52:27-01:00', '2026-10-30T16:59:57',
    ]);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-11-04T12:17:18-01:00', last_update: '2026-11-04T12:17:18-01:00' });
    // iMile's rows open with a centre in 【】 too, in English: they keep their wall clock whatever offset they state.
    const imile = parseJsExpress(waybill([stated('2026-11-04 12:00:00', 'Sample DS', '【Sample DS】Arrived.', '-01:00')], { country: 'Germany' }), DELIVERED);
    expect(imile.events?.[0]).toMatchObject({ local_time: '2026-11-04T12:00:00' });
    // A J&T sentence without an offset keeps its wall clock.
    const unstated = parseJsExpress(waybill([stated('2026-11-04 12:00:00', 'SMP001', '【Sample District】Die Sendung ist bei【Sample HUB】 angekommen.', '')], { country: 'Germany' }), DELIVERED);
    expect(unstated.events?.[0]).toMatchObject({ local_time: '2026-11-04T12:00:00' });
  });

  it("dates Micro Express's copied rows on UTC, whatever their place, and maps them", () => {
    const stated = (date: string, address: string, status: string, timeZone: string, code = 'OIT') => ({ ...row(date, address, status), timeZone, code });
    const result = parseJsExpress(waybill([
      stated('2026-11-23 03:57:45', 'Sample Suburb(VIC)', 'Item processed by local courier at sorting facility', '+08:00'),
      stated('2026-11-23 03:56:45', 'Sample Suburb(VIC)', 'Item has been received by local delivery depot', '+08:00'),
      stated('2026-11-18 10:29:18', 'MEL', 'Delivery to local courier', '+10:00'),
      stated('2026-11-12 13:38:20', '', 'Order Creation, order submitted, pending to receive.', '+08:00'),
    ], { country: 'Australia' }), DELIVERED);
    // Micro Express's own tracker gives the same scans at 14:57:45 and 14:56:45 in Melbourne.
    expect(result.events?.map((event) => event.time ?? event.local_time)).toEqual([
      '2026-11-23T03:57:45Z', '2026-11-23T03:56:45Z', '2026-11-18T10:29:18', '2026-11-12T13:38:20Z',
    ]);
    expect(result.events?.map((event) => [event.stage, event.stage_source])).toEqual([
      ['in_transit', 'carrier_map'], ['in_transit', 'carrier_map'], ['in_transit', 'carrier_map'], ['registered', 'carrier_map'],
    ]);
  });

  it("reads a destination post's rows as JS Express relays them, its collection point as waiting for pickup", () => {
    const waiting = parseJsExpress(withList([
      row('2026-05-06 08:00:00', 'Array', 'Item arrival at collection point for pick-up'),
      row('2026-05-05 13:00:00', 'Sample Town', 'Not Delivered - Addressee not present- Message left'),
      row('2026-05-05 12:00:00', 'Array', 'Arrival distribution office'),
      row('2026-05-03 11:00:00', 'Array', 'Arrival from abroad'),
      row('2026-05-01 22:00:00', 'Array', 'Departure to country of destination'),
      row('2026-05-01 20:00:00', 'Sample Hub', 'Package scanned at carrier facility'),
    ]), DELIVERED);
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map' });
    expect(waiting.events?.map((event) => [event.stage, event.stage_source, event.location])).toEqual([
      ['ready_for_pickup', 'carrier_map', undefined], ['failed_attempt', 'carrier_map', 'Sample Town'], ['in_transit', 'carrier_map', undefined],
      ['in_transit', 'carrier_map', undefined], ['in_transit', 'carrier_map', undefined], ['in_transit', 'carrier_map', 'Sample Hub']]);
    // A partner's record of the data, filed with JS Express's order notice, moves nothing.
    const recorded = parseJsExpress(withList([row('2026-05-01 16:38:20', 'Sample Hub', 'Processed'),
      row('2026-05-01 16:38:19', 'Sample Hub', 'Shipment Data Uploaded'), row('2026-05-01 09:00:00', 'Sample Center', 'Item has been collected')]), DELIVERED);
    expect(recorded).toMatchObject({ current_stage: 'accepted', last_status_text: 'Processed' });
  });

  it("keeps the stage of the scan before it on the depot's receipt, a missed delivery's included, without a source of its own", () => {
    const coded = (date: string, status: string, code: string) => ({ ...row(date, 'Sample Depot', status), timeZone: '+01:00', code }) as Row;
    const rows = [
      coded('2026-11-06 18:21:54', 'RECEIVED AT LOCAL DEPOT', 'OIT'),
      coded('2026-11-06 13:25:48', 'DELIVERY ATTEMPTED: 3RD DELIVERY ATTEMPT', 'DDE'),
      coded('2026-11-06 08:30:04', 'OUT FOR DELIVERY', 'DIG'),
      coded('2026-11-06 08:26:27', 'RECEIVED AT LOCAL DEPOT', 'OIT'),
      coded('2026-11-05 19:44:55', 'RECEIVED AT LOCAL DEPOT', 'OIT'),
      coded('2026-11-05 12:25:08', 'DELIVERY ATTEMPTED: 2ND DELIVERY ATTEMPT', 'DDF'),
      coded('2026-11-05 08:05:17', 'OUT FOR DELIVERY', 'DIG'),
      coded('2026-11-05 08:00:44', 'RECEIVED AT LOCAL DEPOT', 'OIT'),
      coded('2026-11-04 21:10:00', 'DEPARTED FROM DEPOT', 'OIT'),
    ];
    const result = parseJsExpress(waybill(rows, { country: 'Germany' }), DELIVERED);
    expect(result.events?.map((event) => [event.stage, event.stage_source])).toEqual([
      ['failed_attempt', 'none'], ['failed_attempt', 'carrier_map'], ['out_for_delivery', 'carrier_map'], ['failed_attempt', 'none'],
      ['failed_attempt', 'none'], ['failed_attempt', 'carrier_map'], ['out_for_delivery', 'carrier_map'], ['in_transit', 'none'],
      ['in_transit', 'carrier_map'],
    ]);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map', last_status_text: 'RECEIVED AT LOCAL DEPOT' });
    // The map declares the receipt a notice, so a replay restages a stored row on the scan before it.
    const answer = statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: 'RECEIVED AT LOCAL DEPOT' });
    expect(answer.kind).toBe('intentional_gap');
    expect(answer.kind === 'intentional_gap' && answer.note).toContain('keeps the stage of the scan before it');
    // The recipient's redirect after the third miss moves the parcel on, and a receipt after it is the depot's again.
    const redirected = parseJsExpress(waybill([coded('2026-11-07 09:30:00', 'RECEIVED AT LOCAL DEPOT', 'OIT'),
      coded('2026-11-07 08:08:48', "SHIPMENT REDIRECTED: ON CONSIGNEE'S REQUEST", 'OIT'), coded('2026-11-07 08:08:04', 'RECEIVED AT LOCAL DEPOT', 'OIT'),
      ...rows], { country: 'Germany' }), DELIVERED);
    expect(redirected.events?.slice(0, 3).map((event) => [event.stage, event.stage_source])).toEqual([
      ['in_transit', 'none'], ['in_transit', 'carrier_map'], ['failed_attempt', 'none']]);
    expect(redirected).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    // USPS's reminder to book a redelivery is a notice too: it keeps the missed delivery's stage.
    const reminded = parseJsExpress(waybill([coded('2026-11-07 10:00:00', 'Reminder to Schedule Redelivery of your item', 'OIT'), ...rows],
      { country: 'Germany' }), DELIVERED);
    expect(reminded.events?.slice(0, 2).map((event) => [event.stage, event.stage_source])).toEqual([['failed_attempt', 'none'], ['failed_attempt', 'none']]);
    expect(reminded).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });
    // The call to the recipient at the second of the missed delivery moves nothing: the miss leads, and the receipt keeps it.
    const called = parseJsExpress(waybill([rows[0]!, coded('2026-11-06 13:25:48', 'Consignee Contacted', 'OIT'), ...rows.slice(1)],
      { country: 'Germany' }), DELIVERED);
    expect(called.events?.slice(0, 3).map((event) => [event.stage, event.stage_source])).toEqual([
      ['failed_attempt', 'none'], ['pending', 'carrier_map'], ['failed_attempt', 'carrier_map']]);
    expect(called).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });
  });

  it("reads USPS's scans relayed to the second on UTC, and those to the minute on their town's clock", () => {
    const result = parseJsExpress(waybill([
      { ...row('2026-11-07 14:39:42', 'EXAMPLE IL DISTRIBUTION CENTER', 'Arrived at USPS Facility'), timeZone: '-06:00', code: 'OIT' },
      { ...row('2026-11-06 12:16:00', 'EXAMPLE, WA', 'Arrived at USPS Facility'), timeZone: '-08:00', code: 'OIT' },
    ], { country: 'United States' }), DELIVERED);
    expect(result.events?.map((event) => [event.time, event.local_time])).toEqual([
      ['2026-11-07T14:39:42Z', undefined], [undefined, '2026-11-06T12:16:00']]);
  });

  it("reads USPS's other rows on UTC in a history whose USPS scans come to the second, when to the second or at a town without a state", () => {
    const scan = (date: string, address: string, status: string, code: string, timeZone = '-05:00'): Row & { code: string } =>
      ({ ...row(date, address, status), timeZone, code });
    const rows = [
      scan('2026-11-16 08:00:00', '', 'Reminder to Schedule Redelivery of your item', 'OIT'),
      // JS Express's own note, at the offset of its own clock, keeps its wall clock.
      scan('2026-11-15 10:20:00', '9', 'There is no available secure delivery location', 'DDF', '+08:00'),
      scan('2026-11-12 16:06:54', 'SAMPLE TOWN', 'Delivered, In/At Mailbox', 'DSD'),
      // The round on a whole minute, at the minute USPS's own tracker gives it on UTC.
      scan('2026-11-12 11:10:00', 'SAMPLE TOWN', 'Out for Delivery', 'DIG'),
      scan('2026-11-11 14:32:47', 'SAMPLE TOWN', 'Arrived at Post Office', 'OIT'),
      scan('2026-11-11 13:13:37', 'SAMPLE TOWN', 'Arrived at USPS Facility', 'OIT'),
      scan('2026-11-10 11:41:54', '', 'In Transit to Next Facility', 'OIT'),
      // A row to the minute at a town and its state keeps its town's clock.
      scan('2026-11-10 03:31:00', 'EXAMPLE, WA 99999', 'Arrived at Post Office', 'OIT', '-08:00'),
      scan('2026-11-03 17:56:00', 'Sample Hub', 'Delivery to local courier', 'OIT'),
    ];
    const result = parseJsExpress(waybill(rows, { country: 'United States' }), DELIVERED);
    expect(result.events?.map((event) => event.time ?? event.local_time)).toEqual([
      '2026-11-16T08:00:00Z', '2026-11-15T10:20:00', '2026-11-12T16:06:54Z', '2026-11-12T11:10:00Z', '2026-11-11T14:32:47Z',
      '2026-11-11T13:13:37Z', '2026-11-10T11:41:54Z', '2026-11-10T03:31:00', '2026-11-03T17:56:00']);
    // Without USPS's scans to the second, the same round keeps its town's clock.
    const minute = parseJsExpress(waybill([rows[3]!, rows[8]!], { country: 'United States' }), DELIVERED);
    expect(minute.events?.map((event) => event.time ?? event.local_time)).toEqual(['2026-11-12T11:10:00', '2026-11-03T17:56:00']);
  });

  it("reads USPS's feed to the second that writes its towns \"Town,ST\" on its places' clocks, its labels too", () => {
    const scan = (date: string, address: string, status: string, code = 'OIT'): Row & { code: string } =>
      ({ ...row(date, address, status), timeZone: '-06:00', code });
    const result = parseJsExpress(waybill([
      scan('2026-11-14 10:58:30', 'Example Town,TX', 'Delivered, In/At Mailbox', 'DSD'),
      scan('2026-11-14 07:35:26', 'Example Town,TX', 'Out for Delivery', 'DIG'),
      scan('2026-11-14 04:47:42', '', 'In Transit to Next Facility'),
      scan('2026-11-13 11:42:40', 'EXAMPLE TX DISTRIBUTION CENTER', 'Arrived at USPS Regional Facility'),
      // USPS's own tracker gives the acceptance at 10:27 on Central time.
      scan('2026-11-13 10:27:40', 'Example Town,TX', 'Accepted at USPS Origin Facility'),
      // USPS's own tracker gives the label at 08:20 on Central time.
      scan('2026-11-07 08:20:54', 'Example Town,TX', 'Shipping Label Created, USPS Awaiting Item'),
      scan('2026-11-07 08:20:54', 'Example Town,TX', 'Shipping Label Created'),
    ], { country: 'United States' }), DELIVERED);
    expect(result.events?.map((event) => event.time ?? event.local_time)).toEqual([
      '2026-11-14T10:58:30-06:00', '2026-11-14T07:35:26-06:00', '2026-11-14T04:47:42', '2026-11-13T11:42:40-06:00',
      '2026-11-13T10:27:40-06:00', '2026-11-07T08:20:54-06:00', '2026-11-07T08:20:54-06:00']);
  });

  it("reads CTT Express's statuses two hours after their instant, whatever Madrid's offset or the row's", () => {
    const result = parseJsExpress(waybill([
      { ...row('2026-03-12 16:20:31', '', 'Entregado'), timeZone: '+01:00' },
      row('2026-03-12 09:41:07', '', 'En reparto'),
      row('2026-03-02 15:12:44', '', 'Pendiente de recepción en CTT Express'),
    ], { country: 'Spain' }), DELIVERED);
    expect(result.events?.map((event) => event.time ?? event.local_time)).toEqual([
      '2026-03-12T16:20:31+02:00', '2026-03-12T09:41:07+02:00', '2026-03-02T15:12:44+02:00']);
  });

  it("dates a row without a place on the destination's one clock when the offset it states is that clock's, and keeps its code", () => {
    const stated = (date: string, address: string, status: string, timeZone: string, code?: string): Row & { code?: string } =>
      ({ ...row(date, address, status), timeZone, ...(code ? { code } : {}) });
    const rows = [
      stated('2026-10-30 08:18:00', 'Array', 'Item arrival at collection point for pick-up', '+02:00', 'DOD'),
      stated('2026-10-29 13:02:00', 'Array', 'Your shipment has arrived at the postal operator of the country of destination', '+02:00', 'OIT'),
      stated('2026-10-29 13:02:00', 'Array', 'Arrival distribution office', '+02:00', 'OIT'),
      // Before the clock change the destination's offset was +03:00.
      stated('2026-10-24 01:24:00', 'Array', 'Departure to country of destination', '+03:00', 'OIT'),
      // A row at a place takes that place's clock later, whatever offset it states.
      stated('2026-10-23 22:07:39', 'Sample Hub', 'Package scanned at carrier facility', '+03:00', 'OIT'),
      // An offset that is not the destination's, or not one at all, leaves the wall clock.
      stated('2026-10-23 13:15:00', '', 'Sample courier note', '+08:00', 'OIT'),
      stated('2026-10-23 12:15:00', '', 'Sample courier note', 'GMT+2', 'oit'),
      stated('2026-10-18 21:27:54', 'Shenzhen General Warehouse', 'Item has been collected', '+08:00', 'OPU'),
    ];
    for (const offset of ['+02:00', '+03:00']) {
      const overlap = stated('2026-10-25 03:15:00', '', 'Item arrival at collection point for pick-up', offset);
      expect(parseJsExpress(waybill([overlap], { country: 'Cyprus' }), DELIVERED).events?.[0]?.time)
        .toBe('2026-10-25T03:15:00' + offset);
    }
    const cyprus = parseJsExpress(waybill(rows, { country: 'Cyprus' }), DELIVERED);
    expect(cyprus.events?.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-10-30T08:18:00+02:00', 'DOD', 'ready_for_pickup'],
      ['2026-10-29T13:02:00+02:00', 'OIT', 'in_transit'],
      ['2026-10-29T13:02:00+02:00', 'OIT', 'in_transit'],
      ['2026-10-24T01:24:00+03:00', 'OIT', 'in_transit'],
      ['2026-10-23T22:07:39', 'OIT', 'in_transit'],
      ['2026-10-23T13:15:00', 'OIT', undefined],
      ['2026-10-23T12:15:00', undefined, undefined],
      ['2026-10-18T21:27:54+08:00', 'OPU', 'accepted'],
    ]);
    expect(cyprus).toMatchObject({ last_update: '2026-10-30T08:18:00+02:00', current_stage: 'ready_for_pickup' });
    // A destination with several clocks, or none named, leaves every such row on its wall clock.
    for (const fields of [{ country: 'United States' }, { country: '' }]) {
      const result = parseJsExpress(waybill(rows.map((scan) => ({ ...scan, timeZone: '-05:00' })), fields), DELIVERED);
      expect(result.events?.slice(0, 4).map((event) => event.time ?? event.local_time)).toEqual([
        '2026-10-30T08:18:00', '2026-10-29T13:02:00', '2026-10-29T13:02:00', '2026-10-24T01:24:00']);
    }
    // The destination courier's record of the merchant's data at +00:00 is on UTC where the destination's clock never is:
    // a minute after the warehouse's inbound scan, as the destination courier's own tracker gives it.
    const data = stated('2026-11-12 12:53:21', '', 'Package information received.', '+00:00', 'OIT');
    const inbound = stated('2026-11-12 20:52:18', 'Shenzhen General Warehouse', 'Item inbound in Shenzhen General Warehouse', '+08:00', 'OIT');
    expect(parseJsExpress(waybill([inbound, data], { country: 'Netherlands' }), DELIVERED).events?.map((event) => event.time ?? event.local_time))
      .toEqual(['2026-11-12T20:52:18+08:00', '2026-11-12T12:53:21Z']);
    // So it is in a destination of several clocks none of which is ever +00:00, and at the destination's country code alone,
    // where another offset still leaves the wall clock.
    const label = stated('2026-11-12 12:53:21', 'CA', 'Label Generated for', '+00:00', 'OIT');
    expect(parseJsExpress(waybill([inbound, label, { ...label, date: '2026-11-12 07:53:21', timeZone: '-05:00' }], { country: 'Canada' }), DELIVERED)
      .events?.map((event) => event.time ?? event.local_time)).toEqual(['2026-11-12T20:52:18+08:00', '2026-11-12T12:53:21Z', '2026-11-12T07:53:21']);
    expect(parseJsExpress(waybill([inbound, { ...label, address: 'Sample Town' }], { country: 'Canada' }), DELIVERED).events?.[1]?.local_time)
      .toBe('2026-11-12T12:53:21');
    // The code alone is the parcel's destination, not the row's place.
    expect(parseJsExpress(waybill([inbound, label], { country: 'Canada' }), DELIVERED).events?.[1]).not.toHaveProperty('location');
    // London keeps +00:00 in winter, so in summer that offset leaves the wall clock.
    for (const [date, expected] of [['2026-07-12 12:53:21', '2026-07-12T12:53:21'], ['2026-11-12 12:53:21', '2026-11-12T12:53:21Z']]) {
      const event = parseJsExpress(waybill([{ ...data, date }], { country: 'United Kingdom' }), DELIVERED).events?.[0];
      expect(event?.time ?? event?.local_time).toBe(expected);
    }
    // A code that settles a stage gives it to a wording the map lacks.
    const unknown = parseJsExpress(withList([{ ...row('2026-10-23 13:15:00', '', 'Sample courier note'), code: 'DSD' } as Row]), DELIVERED);
    expect(unknown.events?.[0]).toMatchObject({ provider_code: 'DSD', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it("keeps a Colissimo leg's announced return open until the parcel is back with its sender", () => {
    const announced = parseJsExpress(withList([
      row('2026-05-03 14:00:00', 'Sample Center', "Votre Colissimo n'a pas pu vous être livré en raison d'un problème d'adresse. Il va être retourné à l'expéditeur.")]), DELIVERED);
    expect(announced).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map' });
    const back = parseJsExpress(withList([
      row('2026-05-05 10:00:00', 'Sample Center', "Votre colis est livré à son expéditeur à la suite d'un retour."),
      row('2026-05-03 14:00:00', 'Sample Center', "Votre Colissimo n'a pas pu vous être livré en raison d'un problème d'adresse. Il va être retourné à l'expéditeur.")]), DELIVERED);
    expect(back).toMatchObject({ current_stage: 'returned', current_stage_source: 'carrier_map' });
  });

  it('reads the lookup\'s "no data" answer as not found, a waybill without scans as no history, and an empty reply as inconclusive', async () => {
    expect(() => parseJsExpress(parsed('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJsExpress(withList([]), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    // The Chinese page's lookup answers a wrong captcha so; a refusal alone is a block too.
    expect(() => parseJsExpress({ code: -1, message: '验证码错误，请重新输入' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseJsExpress({ code: 1, message: '非法请求' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseJsExpress({ code: 1, data: null, message: 'Sample service notice' }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, number = UNKNOWN) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('  ')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(CLOUDFLARE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>Sample maintenance page</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('{"code":1,"message":"非法请求"}')).rejects.toMatchObject({ kind: 'challenge' });
    // Without the page as its referrer, the lookup prints its refusal and then answers.
    await expect(lookup(`{"code":1,"message":"非法请求"}${page('delivered')}`, DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(() => jsExpressReply('{"code":1,"message":"非法请求"}{"code":0')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the reply to the whole requested number and rejects a changed reply', () => {
    expect(() => parseJsExpress(parsed('delivered'), 'JSEZZ0000000009YQ'))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'JS Express answered for another waybill' }));
    expect(parseJsExpress(JSON.parse(page('delivered').replace(`"${DELIVERED}"`, `"${DELIVERED.toLowerCase()}"`)), DELIVERED).events).toHaveLength(21);
    const delivered = page('delivered');
    const scans = (parsed('delivered') as { data: { tracking: Row[] }[] }).data[0]!.tracking;
    const first = (change: Partial<Row>) => waybill([{ ...scans[0]!, ...change }, ...scans.slice(1)]);
    for (const changed of [
      [],
      {},
      { code: '0', data: [] },
      { code: 0, data: {} },
      { code: 0, data: [{ waybill: DELIVERED, tracking: scans }] },
      waybill(scans, { jsWaybillNo: 'JSEZZ0000000009YQ' }),
      { code: 0, data: [...waybill(scans).data, ...waybill(scans).data] },
      waybill({}),
      waybill(scans, { country: 1 }),
      first({ date: '12/03/2026 20:41' }),
      first({ date: '2026-02-30 20:41:05' }),
      first({ date: '2026-03-12 24:00:00' }),
      first({ date: undefined }),
      first({ status: ' ' }),
      first({ status: 1 }),
      first({ address: ['Sample Town'] }),
      JSON.parse(delivered.replace('"tracking": [', '"tracking": [1, ')),
    ]) {
      expect(() => parseJsExpress(changed, DELIVERED), JSON.stringify(changed).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const long = Array.from({ length: 501 }, () => row('2026-05-01 09:00:00', 'Sample Town', 'Item Flight landing'));
    expect(() => parseJsExpress(withList(long), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('names the destination courier\'s number, and the courier when the catalog settles the number for one at home where the parcel goes', () => {
    const scans = [row('2026-05-03 10:00:00', 'YYZ', 'Delivery to local courier')];
    const read = (fields: Record<string, unknown>) => {
      const { destination_country, destination_country_name, delivery_carrier, delivery_tracking_number } = parseJsExpress(waybill(scans, fields), DELIVERED);
      return { destination_country, destination_country_name, delivery_carrier, delivery_tracking_number };
    };
    expect(read({ trackNo: 'STRCA0000000000018', country: 'Canada' }))
      .toEqual({ destination_country: 'CA', delivery_carrier: 'straightship', delivery_tracking_number: 'STRCA0000000000018' });
    expect(read({ trackNo: 'H1000000000000000001', country: 'Germany' }))
      .toEqual({ destination_country: 'DE', delivery_carrier: 'hermes-de', delivery_tracking_number: 'H1000000000000000001' });
    expect(read({ trackNo: '6A12345678905', country: 'France' }))
      .toEqual({ destination_country: 'FR', delivery_carrier: 'la-poste', delivery_tracking_number: '6A12345678905' });
    // A USPS routing barcode gives its package identifier.
    expect(read({ trackNo: '420000009400100000000000000006', country: 'United States' }))
      .toEqual({ destination_country: 'US', delivery_carrier: 'usps', delivery_tracking_number: '9400100000000000000006' });
    // A courier that does not work where the parcel goes, a number the catalog does not settle, or no country names no courier.
    expect(read({ trackNo: 'H1000000000000000001', country: 'France' }))
      .toEqual({ destination_country: 'FR', delivery_tracking_number: 'H1000000000000000001' });
    expect(read({ trackNo: '19999999999980', country: 'Germany' })).toEqual({ destination_country: 'DE', delivery_tracking_number: '19999999999980' });
    expect(read({ trackNo: 'STRCA0000000000018', country: 'Sample Land' }))
      .toEqual({ destination_country_name: 'Sample Land', delivery_tracking_number: 'STRCA0000000000018' });
    // No number yet, the waybill's own, or one that is no tracking number.
    for (const trackNo of ['', null, DELIVERED, 'SAMPLE NUMBER?']) expect(read({ trackNo, country: 'Canada' }), String(trackNo)).toEqual({ destination_country: 'CA' });
    // A shape DHL Paket shares with other couriers names DHL in Germany when the history holds DHL Paket's own rows.
    const dhl = [row('2026-05-04 09:00:00', '', 'The shipment has been processed in the parcel center of origin'), ...scans];
    const viaDhl = (fields: Record<string, unknown>, rows = dhl) => {
      const { delivery_carrier, delivery_tracking_number } = parseJsExpress(waybill(rows, fields), DELIVERED);
      return { delivery_carrier, delivery_tracking_number };
    };
    for (const trackNo of ['000000000016', 'JJD0000000000000001']) {
      expect(detectCarrierMatch(trackNo), trackNo).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['dhl']) });
      expect(viaDhl({ trackNo, country: 'Germany' }), trackNo).toEqual({ delivery_carrier: 'dhl', delivery_tracking_number: trackNo });
      expect(viaDhl({ trackNo, country: 'Germany' }, scans), trackNo).toEqual({ delivery_tracking_number: trackNo });
      expect(viaDhl({ trackNo, country: 'Austria' }), trackNo).toEqual({ delivery_tracking_number: trackNo });
    }
    expect(viaDhl({ trackNo: '000000000016', country: 'Germany' }, [row('2026-05-04 09:00:00', '', 'The shipment is in transit to DHL.'), ...scans]))
      .toEqual({ delivery_carrier: 'dhl', delivery_tracking_number: '000000000016' });
    // A shape DHL does not issue names no courier, whatever the rows.
    expect(viaDhl({ trackNo: '19999999999980', country: 'Germany' })).toEqual({ delivery_tracking_number: '19999999999980' });
    expect(deliveryHandoff('js-express', DELIVERED, parseJsExpress(waybill(dhl, { trackNo: 'JJD0000000000000001', country: 'Germany' }), DELIVERED)))
      .toEqual({ carrier: 'dhl', number: 'JJD0000000000000001', basis: 'partner' });
    // The tracker hands the parcel to the courier's adapter.
    expect(deliveryHandoff('js-express', DELIVERED, parseJsExpress(parsed('delivered'), DELIVERED)))
      .toEqual({ carrier: 'straightship', number: 'STRCA0000000000018', basis: 'partner' });
    expect(deliveryHandoff('js-express', IN_TRANSIT, parseJsExpress(parsed('in-transit'), IN_TRANSIT)))
      .toEqual({ carrier: 'hermes-de', number: 'H1000000000000000001', basis: 'partner' });
  });

  it('keeps the newest hundred rows of a long history and says it cut the rest', () => {
    const rows = Array.from({ length: 120 }, (_, index) =>
      row(`2026-05-01 ${String(Math.floor((119 - index) / 60)).padStart(2, '0')}:${String((119 - index) % 60).padStart(2, '0')}:00`, 'Sample Hub', 'Item Flight landing'));
    const result = parseJsExpress(withList(rows), DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-05-01T01:59:00' });
  });

  it("reads a shop's order number by the waybill the lookup answers it with, which becomes the canonical number", async () => {
    const ORDER = 'SN000000000009';
    const answer = waybill([row('2026-05-01 10:00:00', 'Sample Hub', 'Item Flight landing')]);
    expect(parseJsExpress(answer, ORDER)).toMatchObject({ status: 'in_transit', canonical_tracking_number: DELIVERED });
    expect(parseJsExpress(answer, DELIVERED)).not.toHaveProperty('canonical_tracking_number');
    // Another order's waybill is not this one's, and a waybill is matched by its own number only.
    expect(() => parseJsExpress(answer, 'SN000000000008')).toThrow('another waybill');
    expect(() => parseJsExpress(waybill([], { orderNo: IN_TRANSIT }), IN_TRANSIT)).toThrow('another waybill');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(answer)));
    await expect(carrier(fetcher).track({ number: ' sn 000000000009 ' })).resolves.toMatchObject({ canonical_tracking_number: DELIVERED });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: `card_num=${ORDER}` });
    // Recognition asks about waybills and JCH's references: another order number names no carrier.
    await expect(carrier(fetcher).recognize!(ORDER)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("recognizes a JCH reference the lookup answers with the waybill JCH booked it on", async () => {
    const JCH = 'JCHSG9900000000001';
    const answer = waybill([row('2026-05-01 10:00:00', 'China, Transit Center', 'Item outbound in sorting center.')], { orderNo: JCH });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(JSON.stringify(answer)))
      .mockResolvedValueOnce(reply(page('not-found')));
    await expect(carrier(fetcher).recognize!(JCH)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!('JCHSG9900000000002')).resolves.toEqual({ known: false });
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: `card_num=${JCH}` });
    // A JCH reference is thirteen digits after JCHSG.
    await expect(carrier(fetcher).recognize!('JCHSG990000000001')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(detectCarrierMatch(JCH)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['jch', 'js-express'] });
  });

  it("takes JS Express waybills and shops' order numbers, and nothing else, without a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JSEZZ000000001YQ', 'JSEZZ00000000001YQ', 'JSEZZ0000000001YR', 'FEISH0000000001YQ', 'WNBZZ0000000001YQ',
      'JSE0000000000001YQ', '12345678901', `JSEZZ${'0'.repeat(70)}YQ`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJsExpressNumber(' jsezz-0000 0000 01 yq ')).toBe(DELIVERED);
    // A letter O among the digits is a zero typed as a letter, and the tracker is asked with the zero.
    expect(normalizeJsExpressNumber('JSEZZOOOOOOOOO1YQ')).toBe(DELIVERED);
    // A zero typed for the second letter is the letter O, and the tracker is asked with the letter.
    expect(normalizeJsExpressNumber('JSEZ00000000001YQ')).toBe('JSEZO0000000001YQ');
  });

  it('recognizes a known parcel and an unknown number from plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('delivered'))).mockResolvedValueOnce(reply(page('in-transit')))
      .mockResolvedValueOnce(reply(page('not-found')));
    // The newest dated row dates the parcel's last activity: the delivery, or the export release before the flight's wall clocks.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-12T20:41:05.000Z', finished: true });
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-14T13:58:00.000Z' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [302, 'indeterminate'], [404, 'transport'], [410, 'transport'],
    [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s during retrieval and recognition, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('not-found'), status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('tries once more after a failed connection, inside the caller\'s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    await expect(carrier(immediate).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(256 * 1024 + 1)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('routes a JS Express waybill, which detection settles, to the adapter, which names the destination courier', async () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'js-express', confidence: 'high' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'js-express', source: 'js-express',
      result: { current_stage: 'delivered', delivery_carrier: 'straightship', delivery_tracking_number: 'STRCA0000000000018' } });
    expect(String(fetcher.mock.calls[0]![0])).toBe(JS_EXPRESS_TRACKER);
    expect(fetcher.mock.calls.filter(([url]) => String(url) === JS_EXPRESS_TRACKER)).toHaveLength(1);
  });

  it('answers a destination courier\'s waybill made after the parcel moved as transit, as the tracker reads every result', async () => {
    const rows = [row('2026-05-03 10:00:00', '', 'Waybill Generated for ZZ0000000000000'),
      row('2026-05-02 18:00:00', 'YYZ', 'Delivery to local courier')];
    // The parser keeps the row's own reading; the tracker's answer reads a registration after a movement as transit.
    expect(parseJsExpress(withList(rows), DELIVERED)).toMatchObject({ current_stage: 'registered' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(JSON.stringify(withList(rows))));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'js-express', result: { current_stage: 'in_transit', events: [{ stage: 'in_transit' }, {}] } });
  });
});

describe('JS Express status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and leaves records of data and forecasts out', () => {
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      if (!('stage' in entry)) {
        expect(statusMap.stage(null, wording), entry.wording).toBeUndefined();
        expect(statusMapAnswer({ carrier: 'js-express', description: entry.wording }), entry.wording).toMatchObject({ kind: 'intentional_gap' });
        expect(jsExpressStage(entry.wording), entry.wording).toBeNull();
        continue;
      }
      expect(jsExpressMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'js-express', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(jsExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.gaps.every(gap => gap.wording && gap.note)).toBe(true);
    for (const wording of ['constructor', 'toString', 'Sample delivered note']) expect(jsExpressMappedStage(wording), wording).toBeUndefined();
    expect(jsExpressStage('')).toBeNull();
    // The destination courier's waybill with its reference after the wording.
    const waybill = 'Waybill Generated for ZZ0000000000000';
    expect(jsExpressStage(waybill, 'OIT')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: waybill })).toEqual({ kind: 'mapped', stage: 'registered' });
    expect(jsExpressMappedStage('Waybill Generated for the sample shop')).toBeUndefined();
  });

  it('reads a wording the map lacks by its code where the code settles the stage alone, and a gap whatever its code', () => {
    const unknown = 'Sample courier note';
    for (const [code, stage] of [['OIR', 'registered'], ['OPU', 'accepted'], ['DIG', 'out_for_delivery'], ['DOD', 'ready_for_pickup'],
      ['DDF', 'failed_attempt'], ['DSD', 'delivered']] as const) {
      expect(statusMap.stage(code, normalizeStatusWording(unknown)), code).toBe(stage);
      expect(jsExpressStage(unknown, code), code).toEqual({ stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'js-express', providerCode: code, description: unknown }), code).toEqual({ kind: 'mapped', stage });
    }
    // Most rows are OIT whatever happened, and the courier's exceptions DDE, a forward among them: those take the wording.
    for (const code of ['OIT', 'DDE', 'OCP', 'DCF', '7']) expect(statusMap.stage(code, normalizeStatusWording(unknown)), code).toBeUndefined();
    expect(jsExpressStage('Alert, Forwarded -> Your item was forwarded to a different address', 'DDE')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // iMile's German centres name who took the parcel; iMile's reading delivers it under any code.
    expect(jsExpressStage('【Sample01】Delivered, receiver type:【Neighbour】.', 'OIT')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    // The wording's map comes first, and a record of data stays a gap under any code.
    expect(statusMap.stage('DSD', normalizeStatusWording('Item has been collected'))).toBe('accepted');
    const gap = statuses.entries.find((entry) => !('stage' in entry))!.wording;
    expect(statusMap.stage('OIR', normalizeStatusWording(gap))).toBeUndefined();
    expect(jsExpressStage(gap, 'OIR')).toBeNull();
    expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: gap })).toMatchObject({ kind: 'intentional_gap' });
    // A bare collection or receipt is the journey going on under OIT; a code that settles the stage reads it, and
    // without a code it has no stage.
    for (const wording of ['Collected', 'Received']) {
      expect(jsExpressStage(wording, 'OIT'), wording).toEqual({ stage: 'in_transit', source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'js-express', providerCode: 'OIT', description: wording }), wording).toEqual({ kind: 'mapped', stage: 'in_transit' });
      expect(jsExpressStage(wording, 'DSD'), wording).toEqual({ stage: 'delivered', source: 'carrier_map' });
      expect(jsExpressStage(wording), wording).toBeNull();
    }
  });
});
