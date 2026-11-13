import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { adapter, AustraliaPostTracker, australiaPostApiUrl, australiaPostTrackingUrl, normalizeAustraliaPostNumber, parse } from './adapter.js';
import { TrawlClient } from '../../core/transport/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { DIRECT_REST_MS } from '../../core/runner/directRest.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { sameInstantIdentityPolicy } from '../../app.js';
import { australiaPostStatus } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '7T0000000001000000001';
const OTHER = '7T0000000001000000002';
const UNKNOWN = '7T0000000000000000000';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const empty = () => JSON.parse(readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8'));
const capabilities = (JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')) as { capabilities: string[] }).capabilities;

describe('Australia Post parser', () => {
  it('projects all capabilities without retaining private details or modification times', () => {
    const result = parse(fixture(), NUMBER);
    expect(capabilities).toEqual(['history', 'location', 'provider_code', 'eta', 'delivered_at', 'pickup_point', 'service_name']);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      service_name: 'Parcel Post Small Satchel',
      last_update: '2026-06-08T14:10:00+10:00', delivered_at: '2026-06-08T14:10:00+10:00', expected_delivery: null });
    expect(result.events).toHaveLength(12);
    expect(result.events?.[0]).toEqual({ time: '2026-06-08T14:10:00+10:00', description: 'Delivered',
      location: 'Example sorting facility', stage: 'delivered', provider_code: 'DD-ER15/Delivered' });
    // Each scan keeps its milestone label with its code, which the parcel app's review reads.
    expect(result.events?.slice(1, 3).map((event) => event.provider_code)).toEqual(["AFP-ER13/It's coming today", "TTP-ER81/It's on its way"]);
    expect(result.events?.[1]?.stage).toBe('out_for_delivery');
    expect(result.events?.[8]?.stage).toBe('accepted');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example\.invalid|7T0000000001000000001|14:10:5[78]/);
  });

  it('names no service when the reply gives no product', () => {
    const payload = fixture();
    delete payload[0].shipment.articles[0].details[0].productSubType;
    expect(parse(payload, NUMBER).service_name).toBeUndefined();
  });

  it('sorts by absolute instant, deduplicates scans and preserves their explicit offsets', () => {
    const payload = fixture();
    const events = payload[0].shipment.articles[0].details[0].events;
    events.push(structuredClone(events[0]));
    events.reverse();
    const result = parse(payload, NUMBER);
    expect(result.events).toHaveLength(12);
    expect(result.events?.[0]?.stage).toBe('delivered');
    expect(result.events?.[4]?.time).toBe('2026-06-07T16:10:00+09:30');
    expect(result.events?.map((event) => Date.parse(event.time!))).toEqual(
      result.events?.map((event) => Date.parse(event.time!)).sort((a, b) => b - a),
    );
  });

  it('selects an exact article without promoting a delivered sibling to consignment completion', () => {
    const payload = fixture();
    const target = payload[0].shipment.articles[0];
    const sibling = structuredClone(target);
    sibling.articleId = OTHER;
    sibling.details[0].articleId = OTHER;
    target.trackStatusOfArticle = 'In transit';
    target.details[0].events = target.details[0].events.slice(2);
    payload[0].shipment.articles.unshift(sibling);
    expect(parse(payload, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(parse(payload, NUMBER).delivered_at).toBeUndefined();
    const consignment = payload[0].shipment.consignmentId;
    payload[0].trackingIds = [consignment];
    expect(() => parse(payload, consignment)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    payload[0].shipment.articles = [target];
    expect(parse(payload, consignment).status).toBe('in_transit');
  });

  it('tracks a consignment whose articles are in one state through the article that reached it last', () => {
    const payload = fixture();
    const consignment = payload[0].shipment.consignmentId;
    payload[0].trackingIds = [consignment];
    const first = payload[0].shipment.articles[0];
    const later = structuredClone(first);
    later.articleId = OTHER; later.details[0].articleId = OTHER;
    // Scanned five minutes after its sibling, with the same wording at the same place.
    const at = (article: typeof first, time: string) => {
      const event = article.details[0].events[0];
      event.localeDateTime = time; event.dateTime = Date.parse(time);
    };
    at(later, '2026-06-08T14:15:00+10:00');
    payload[0].shipment.articles.push(later);
    expect(parse(payload, consignment)).toMatchObject({ status: 'delivered', last_update: '2026-06-08T14:15:00+10:00', delivered_at: '2026-06-08T14:15:00+10:00' });
    // Every article delivered, whichever way, delivers the consignment.
    later.details[0].events[0].eventCode = 'DD-ER13';
    expect(parse(payload, consignment)).toMatchObject({ status: 'delivered', delivered_at: '2026-06-08T14:15:00+10:00' });
    for (const article of [first, later]) {
      article.trackStatusOfArticle = 'In transit'; article.details[0].events = article.details[0].events.slice(2);
    }
    at(first, '2026-06-08T09:00:00+10:00'); at(later, '2026-06-08T08:55:00+10:00');
    expect(parse(payload, consignment)).toMatchObject({ status: 'in_transit', last_update: '2026-06-08T09:00:00+10:00' });
    later.details[0].events[0].location = 'Another sorting facility';
    expect(() => parse(payload, consignment)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    // An article without history yet is in a state of its own.
    later.details[0].events = [];
    expect(() => parse(payload, consignment)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
  });

  it('requires matched lookup, article and detail identities, including negative replies', () => {
    expect(() => parse(empty(), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(empty(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (p: ReturnType<typeof fixture>) => { p[0].trackingIds = [OTHER]; },
      (p: ReturnType<typeof fixture>) => { p[0].shipment.articles[0].articleId = OTHER; },
      (p: ReturnType<typeof fixture>) => { p[0].shipment.articles[0].details[0].articleId = OTHER; },
      (p: ReturnType<typeof fixture>) => { p[0].shipment.articles[0].details[0].consignmentId = OTHER; },
      (p: ReturnType<typeof fixture>) => { p[0].shipment.articles.push(structuredClone(p[0].shipment.articles[0])); },
      (p: ReturnType<typeof fixture>) => { p.push(structuredClone(p[0])); },
    ]) {
      const payload = fixture(); change(payload);
      expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const wrongError = empty(); wrongError[0].error.errorCode = 99;
    expect(() => parse(wrongError, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('leaves unknown status and events unclassified rather than borrowing delivery', () => {
    const payload = fixture();
    const article = payload[0].shipment.articles[0];
    article.trackStatusOfArticle = 'Future milestone';
    article.details[0].events[0].milestone = 'Future milestone';
    article.details[0].events[0].eventCode = 'NEW-CODE';
    delete article.details[0].events[1].milestone;
    const result = parse(payload, NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered - Left in a safe place', provider_code: 'NEW-CODE/Future milestone' });
    expect(result.events?.[0]?.stage).toBeUndefined();
    // A scan without a label keeps its code alone.
    expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery', provider_code: 'AFP-ER13' });
  });

  it.each([
    ['Awaiting collection', 'in_transit', 'ready_for_pickup'],
    ['Attempted delivery', 'exception', 'failed_attempt'],
    ['Returned to sender', 'exception', 'returned'],
    ['Delayed', 'exception', 'exception'],
  ])('does not mistake %s for final delivery', (label, status, stage) => {
    const payload = fixture(); payload[0].shipment.articles[0].trackStatusOfArticle = label;
    expect(parse(payload, NUMBER)).toMatchObject({ status, current_stage: stage });
    expect(parse(payload, NUMBER).delivered_at).toBeUndefined();
  });

  it('uses verified epoch milliseconds when local display time is absent', () => {
    const payload = fixture(); delete payload[0].shipment.articles[0].details[0].events[0].localeDateTime;
    expect(parse(payload, NUMBER).last_update).toBe('2026-06-08T04:10:00Z');
  });

  it('rejects schema changes, ambiguous details, invalid and contradictory times', () => {
    for (const change of [
      (p: ReturnType<typeof fixture>) => { p[0].shipment.articles = []; },
      (p: ReturnType<typeof fixture>) => { p[0].shipment.articles[0].details.push(structuredClone(p[0].shipment.articles[0].details[0])); },
      (p: ReturnType<typeof fixture>) => { p[0].shipment.articles[0].details[0].events[0].dateTime += 1000; },
      (p: ReturnType<typeof fixture>) => { Object.assign(p[0].shipment.articles[0].details[0].events[0], { dateTime: 0, localeDateTime: '2026-02-31T10:00:00+10:00' }); },
      (p: ReturnType<typeof fixture>) => { Object.assign(p[0].shipment.articles[0].details[0].events[0], { dateTime: 1780000000, localeDateTime: null }); },
      (p: ReturnType<typeof fixture>) => { p[0].shipment.articles[0].details[0].events[0].description = ''; },
      (p: ReturnType<typeof fixture>) => { p[0].shipment.articles[0].details[0].events = Array(501).fill(p[0].shipment.articles[0].details[0].events[0]); },
    ]) {
      const payload = fixture(); change(payload);
      expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [{}, [], [null]]) expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('calls a known article without scans inconclusive, with no history', () => {
    const payload = fixture();
    const article = payload[0].shipment.articles[0];
    article.trackStatusOfArticle = null;
    article.status = { statusAttributeName: 'status', statusAttributeValue: 'Updating Status' };
    article.details[0].events = [];
    expect(() => parse(payload, NUMBER)).toThrow(NoHistoryError);
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});

type RawEvent = { eventCode: string; description: string; location: string; milestone: string; localeDateTime: string };
function journey(destination: string, events: RawEvent[], summary = 'Delivered', details: Record<string, unknown> = {}) {
  const payload = fixture();
  const article = payload[0].shipment.articles[0];
  article.trackStatusOfArticle = summary;
  Object.assign(article.details[0], details);
  Object.assign(article.details[0].address, { country: destination });
  Object.assign(article.details[0].fromAddress, { country: 'AU' });
  article.details[0].events = events.map((event) => ({ ...event, dateTime: Date.parse(event.localeDateTime) }));
  return parse(payload, NUMBER);
}
const scan = (eventCode: string, description: string, location: string, localeDateTime: string, milestone = "It's on its way") =>
  ({ eventCode, description, location, milestone, localeDateTime });

describe('Australia Post status codes and places', () => {
  it('maps every recorded code and label to its recorded stage', () => {
    for (const entry of statuses.entries) {
      const classified = 'code' in entry ? australiaPostStatus('', entry.code) : australiaPostStatus(entry.wording);
      expect(classified?.stage, 'code' in entry ? entry.code : entry.wording).toBe(entry.stage);
    }
  });

  it('keeps scans of one instant in the reply\'s order, whichever way it lists them', () => {
    const events = [
      scan('DD-ER13', 'Delivered', 'EXAMPLE VIC', '2026-06-12T14:00:00+10:00', 'Delivered'),
      scan('AFP-ER13', 'Onboard for delivery', 'EXAMPLE VIC', '2026-06-12T08:00:00+10:00', "It's coming today"),
      scan('TTP-ER81', 'Processed at facility', 'EXAMPLE VIC', '2026-06-12T08:00:00+10:00'),
    ];
    for (const listed of [events, [...events].reverse()]) {
      expect(journey('AU', listed).events?.map((event) => event.description)).toEqual(['Delivered', 'Onboard for delivery', 'Processed at facility']);
    }
  });

  it('reads the post abroad on its own clock and files its scans by code', () => {
    const events = [
      scan('INT-0037', 'Delivered', 'EXAMPLE CITY CA', '2026-06-12T11:22:00Z', 'Delivered'),
      scan('INT-0075', 'Awaiting collection at UNITED STATES OF AMERICA', 'EXAMPLE CITY CA', '2026-06-12T08:06:00Z', 'Delivered'),
      scan('INT-0036', 'Unsuccessful delivery - Addressee not available', 'UNITED STATES OF AMERICA', '2026-06-11T11:39:00Z'),
      scan('INT-0074', 'Onboard for delivery', 'UNITED STATES OF AMERICA', '2026-06-11T06:10:00Z'),
      scan('INT-0031', 'Item received into Customs for clearance', 'EXAMPLE PORT (US), UNITED STATES OF AMERICA', '2026-06-09T11:14:00-07:00'),
      scan('INT-0008', 'Cleared and awaiting international departure', 'MELBOURNE VIC', '2026-06-06T17:41:25+10:00'),
    ];
    const result = journey('US', events);
    expect(result.events?.map((event) => [event.time ?? `local ${String(event.local_time)}`, event.stage])).toEqual([
      // Labelled 11:22Z and 08:06Z: the wall clock of a Californian office.
      ['2026-06-12T11:22:00-07:00', 'delivered'],
      ['2026-06-12T08:06:00-07:00', 'ready_for_pickup'],
      // Only the country, which keeps several clocks.
      ['local 2026-06-11T11:39:00', 'failed_attempt'],
      ['local 2026-06-11T06:10:00', 'out_for_delivery'],
      ['2026-06-09T11:14:00-07:00', 'customs'],
      ['2026-06-06T17:41:25+10:00', 'in_transit'],
    ]);
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-06-12T11:22:00-07:00',
      last_update: '2026-06-12T11:22:00-07:00', destination_country: 'US' });
    expect(result).not.toHaveProperty('pickup_point');

    const unplaced = journey('US', [{ ...events[0]!, location: 'UNITED STATES OF AMERICA' }, ...events.slice(1)]);
    expect(unplaced).toMatchObject({ last_update: null, last_update_local: '2026-06-12T11:22:00' });
    expect(unplaced.delivered_at).toBeUndefined();
    expect(journey('NL', [scan('INT-0037', 'Delivered', 'EXAMPLE CITY', '2026-06-12T11:22:00Z', 'Delivered')]).events?.[0]?.time)
      .toBe('2026-06-12T11:22:00+02:00');
    // A domestic reply has no post abroad, so a UTC label stands.
    expect(journey('AU', [scan('DD-ER13', 'Delivered', 'EXAMPLE VIC', '2026-06-12T01:22:00Z', 'Delivered')]).last_update)
      .toBe('2026-06-12T01:22:00Z');
    // Scans stored under the UTC label give way to the same scan on its own clock.
    expect(sameInstantIdentityPolicy('australia-post')).toEqual({
      sourceCarrierId: 'australia-post', storedSources: ['australia-post'], requireProviderCode: true, relabelledFrom: 'UTC', matchWallClock: true,
    });
  });

  it("takes the newest scan's coded stage when the summary label says no more than that scan's milestone", () => {
    const received = (milestone?: string) => scan('INT-0001', 'Received item from Sender (Outbound)', 'EXAMPLE COUNTRY',
      '2026-06-05T16:20:00+02:00', milestone);
    expect(journey('AU', [received()], 'In transit'))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'In transit' });
    // A summary further along than the scan's own milestone keeps its stage.
    expect(journey('AU', [received("We've got it")], 'In transit')).toMatchObject({ current_stage: 'in_transit' });
  });

  it('expects the parcel on the days the reply gives, else by the day it names, until it is delivered', () => {
    const departed = scan('AA-0001', 'Item processed at facility', 'MELBOURNE VIC', '2026-06-06T17:41:25+10:00');
    const range = { estimatedDeliveryDateRange: { fromDate: '2026-06-09', toDate: '2026-06-10' }, deliveredByDateISO: '2026-06-10' };
    const result = journey('AU', [departed], 'In transit', range);
    expect(result).toMatchObject({ status: 'in_transit', expected_delivery_from: '2026-06-09', expected_delivery: '2026-06-10' });
    expect(result).not.toHaveProperty('unread_estimates');
    // A range of one day is that day, and without a range the parcel is expected by the day the reply names.
    const oneDay = journey('AU', [departed], 'In transit', { estimatedDeliveryDateRange: { fromDate: '2026-06-10', toDate: '2026-06-10' } });
    expect(oneDay.expected_delivery).toBe('2026-06-10');
    expect(oneDay).not.toHaveProperty('expected_delivery_from');
    expect(journey('AU', [departed], 'In transit', { deliveredByDateISO: '2026-06-10' })).toMatchObject({ expected_delivery: '2026-06-10' });
    // A delivered parcel is expected no more.
    const payload = fixture();
    Object.assign(payload[0].shipment.articles[0].details[0], range);
    const delivered = parse(payload, NUMBER);
    expect(delivered.expected_delivery).toBeNull();
    expect(delivered).not.toHaveProperty('expected_delivery_from');
  });

  it("expects the parcel in the slot the courier's run gives, before any range, until the slot has passed", () => {
    const onboard = scan('AFP-ER13', 'Onboard for delivery', 'EXAMPLE QLD', '2026-06-10T08:12:40+10:00', "It's coming today");
    const slot = { start: '094512', end: '114512', stopsAway: null, minutesAway: null, timeZone: '+10:00', onTimeStatus: null,
      passedWindow: false, deliveryDate: '2026-06-10' };
    const range = { estimatedDeliveryDateRange: { fromDate: '2026-06-10', toDate: '2026-06-11' } };
    const result = journey('AU', [onboard], 'In transit', { ...range, timeWindow: slot });
    expect(result).toMatchObject({ status: 'out_for_delivery', expected_delivery_from: '2026-06-10T09:45:12+10:00',
      expected_delivery: '2026-06-10T11:45:12+10:00' });
    expect(result).not.toHaveProperty('unread_estimates');
    // Without its offset the slot keeps the day's wall clock; once it has passed, the day alone stands.
    expect(journey('AU', [onboard], 'In transit', { timeWindow: { ...slot, timeZone: null } }))
      .toMatchObject({ expected_delivery: '2026-06-10 09:45–11:45' });
    const passed = journey('AU', [onboard], 'In transit', { ...range, timeWindow: { ...slot, passedWindow: true } });
    expect(passed.expected_delivery).toBe('2026-06-10');
    expect(passed).not.toHaveProperty('expected_delivery_from');
    // A countdown on the run, and whether it runs on time, are not read yet.
    expect(journey('AU', [onboard], 'In transit', { timeWindow: { ...slot, stopsAway: 4, minutesAway: 25, onTimeStatus: 'SAMPLE' } }))
      .toMatchObject({ expected_delivery: '2026-06-10T11:45:12+10:00',
        unread_estimates: ['timeWindow.minutesAway', 'timeWindow.stopsAway', 'timeWindow.onTimeStatus'] });
  });

  it('names a slot in another shape, and a range in a shape it does not read, as estimates it does not read yet', () => {
    const departed = scan('AA-0001', 'Item processed at facility', 'MELBOURNE VIC', '2026-06-06T17:41:25+10:00');
    expect(journey('AU', [departed], 'In transit', { timeWindow: { startTime: '09:00', endTime: '12:00' } }))
      .toMatchObject({ expected_delivery: null, unread_estimates: ['timeWindow'] });
    expect(journey('AU', [departed], 'In transit', { estimatedDeliveryDateRange: { from: '10/06/2026' }, timeWindow: null }))
      .toMatchObject({ expected_delivery: null, unread_estimates: ['estimatedDeliveryDateRange'] });
    // An empty slot says nothing, and a delivered parcel's slot still shows its shape.
    expect(journey('AU', [departed], 'In transit', { timeWindow: { startTime: null, endTime: '' } })).not.toHaveProperty('unread_estimates');
    const payload = fixture();
    payload[0].shipment.articles[0].details[0].timeWindow = 'Between 9am and 12pm';
    expect(parse(payload, NUMBER)).toMatchObject({ expected_delivery: null, unread_estimates: ['timeWindow'] });
  });

  it("takes the newest scan's coded stage when it is further along than the summary label", () => {
    const customs = scan('INT-0031', 'Item received into Customs for clearance', 'EXAMPLE PORT (US), UNITED STATES OF AMERICA',
      '2026-06-09T11:14:00-07:00');
    const departed = scan('INT-0008', 'Cleared and awaiting international departure', 'MELBOURNE VIC', '2026-06-06T17:41:25+10:00');
    expect(journey('US', [customs, departed], 'In transit'))
      .toMatchObject({ status: 'in_transit', current_stage: 'customs', last_status_text: 'In transit' });
    // A scan in transit, or a summary already further along, leaves the summary's stage.
    expect(journey('US', [departed], 'In transit')).toMatchObject({ current_stage: 'in_transit' });
    expect(journey('US', [customs, departed], 'Out for delivery')).toMatchObject({ current_stage: 'out_for_delivery' });
  });

  it('names the collection point and follows the newest scan when the summary is unknown', () => {
    const waiting = journey('AU', [
      scan('DD-ER4', 'Awaiting collection at Example Post Office', 'EXAMPLE VIC', '2026-06-12T12:02:24+10:00', 'Awaiting collection'),
      scan('DD-ER5', 'Delivery location closed', 'EXAMPLE VIC', '2026-06-12T10:48:14+10:00', 'Attempted delivery'),
    ], 'Awaiting collection');
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', pickup_point: 'Example Post Office', destination_country: 'AU' });
    const abroad = journey('NL', [scan('INT-2180', 'Flight landed', '', '2026-06-07T17:39:00+11:00')], 'Future summary');
    expect(abroad).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Future summary' });
  });

  it('keeps the collection point once the parcel is collected there, and never after a door delivery', () => {
    const delivered = scan('DD-ER13', 'Delivered', 'EXAMPLE VIC', '2026-06-13T10:15:00+10:00', 'Delivered');
    const waiting = scan('DD-ER4', 'Awaiting collection at Example Post Office', 'EXAMPLE VIC', '2026-06-12T12:02:24+10:00', 'Awaiting collection');
    const attempted = scan('DD-ER5', 'Delivery location closed', 'EXAMPLE VIC', '2026-06-12T10:48:14+10:00', 'Attempted delivery');
    // The point's work-centre id and the collection credentials are never read.
    const collection = { collectionInstruction: { delegate: { allowed: true, reason: 'PRIVATE REASON' },
      facility: { workCentreId: 'PRIVATE FACILITY ID', type: 'WORK_CENTRE' }, accessNumber: 'PRIVATE ACCESS NUMBER' } };
    const collected = journey('AU', [delivered, waiting, attempted], 'Delivered', collection);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered', pickup_point: 'Example Post Office' });
    expect(JSON.stringify(collected)).not.toMatch(/PRIVATE/);
    const locker = scan('NT-ER4', 'Awaiting collection at Example Parcel Locker', 'EXAMPLE VIC', '2026-06-12T12:02:24+10:00', 'Awaiting collection');
    expect(journey('AU', [delivered, locker]).pickup_point).toBe('Example Parcel Locker');

    const onboard = scan('AFP-ER13', 'Onboard for delivery', 'EXAMPLE VIC', '2026-06-13T08:10:00+10:00', "It's coming today");
    const notice = scan('XX-ER99', 'A future notice', 'EXAMPLE VIC', '2026-06-13T08:10:00+10:00', 'A future milestone');
    const safePlace = scan('DD-ER15', 'Delivered - Left in a safe place', 'EXAMPLE VIC', '2026-06-13T10:15:00+10:00', 'Delivered');
    for (const events of [[delivered, onboard, waiting], [delivered, notice, waiting], [safePlace, waiting], [delivered, attempted]]) {
      const result = journey('AU', events);
      expect(result.current_stage).toBe('delivered');
      expect(result).not.toHaveProperty('pickup_point');
    }
    // A scan that names no place gives no point.
    expect(journey('AU', [scan('DD-ER4', 'Awaiting collection', 'EXAMPLE VIC', '2026-06-12T12:02:24+10:00', 'Awaiting collection')],
      'Awaiting collection')).not.toHaveProperty('pickup_point');
  });
});

function capture(body: unknown = fixture(), status = 200) {
  return { url: australiaPostApiUrl(NUMBER), status, body: JSON.stringify(body), headers: {} };
}
// Each tracker its own browser service: a refusal one meets rests no other's direct step.
let services = 0;
const browserService = (fetcher: typeof fetch) => new TrawlClient(`https://browser.example.test/service-${services += 1}`, fetcher);
function service(captures: Array<Record<string, unknown>> = [capture()], extra: Record<string, unknown> = {}) {
  return { url: australiaPostTrackingUrl(NUMBER), html: '<html/>', tier: 2, statusCode: 200,
    capturedResponses: captures, ...extra };
}
const refused = () => vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status: 403 }));
/** A tracker whose direct request is refused, so the browser service answers. */
function tracker(payload: unknown) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
  const trawl = browserService(fetcher);
  const direct = refused();
  return { fetcher, trawl, direct, tracker: new AustraliaPostTracker({ trawl, fetcher: direct }) };
}
function direct(body: unknown = fixture(), status = 200, headers: Record<string, string> = {}) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
  const browser = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(service()));
  return { fetcher, browser, tracker: new AustraliaPostTracker({ trawl: browserService(browser), fetcher }) };
}

describe('Australia Post direct retrieval', () => {
  it('asks the gateway as the official app does and never starts a browser after an answer', async () => {
    const { tracker: client, fetcher, browser } = direct();
    await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(australiaPostApiUrl(NUMBER));
    expect(init!.cache).toBe('default');
    expect(Object.fromEntries(new Headers(init!.headers))).toEqual({ accept: 'application/json', ap_app_id: 'MYPOST',
      ap_channel_name: 'ANDROID', 'user-agent': 'okhttp/4.12.0', 'accept-language': 'en-AU' });
    const unknown = empty(); unknown[0].trackingIds = [NUMBER];
    const missing = direct(unknown);
    await expect(missing.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(browser).not.toHaveBeenCalled();
    expect(missing.browser).not.toHaveBeenCalled();
  });

  it('hands a refused or failed request to the browser service', async () => {
    for (const status of [401, 403, 500]) {
      const { tracker: client, browser } = direct('<html>blocked</html>', status);
      await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      expect(browser).toHaveBeenCalledTimes(1);
    }
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const { fetcher, browser } = direct('{}', 403);
    await adapter({ trawl: browserService(browser), fetcher, recorder, env: {}, browserExecutablePath: null }).track({ number: NUMBER });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'direct', outcome: 'challenge' }));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok', fallbackFrom: 'direct' }));
  });

  it('goes straight to the browser for a while after the gateway refused plain HTTP', async () => {
    const { tracker: client, fetcher, browser } = direct('{}', 403);
    await client.fetch(NUMBER);
    await client.fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(browser).toHaveBeenCalledTimes(2);
    // A gateway error that is no refusal starts no rest.
    const failed = direct('<html>error</html>', 500);
    await failed.tracker.fetch(NUMBER);
    await failed.tracker.fetch(NUMBER);
    expect(failed.fetcher).toHaveBeenCalledTimes(2);
    // Recognition has no browser to go to, and still asks the gateway.
    const gateway = refused();
    const instance = adapter({ trawl: browserService(vi.fn<typeof fetch>().mockImplementation(async () => Response.json(service()))),
      fetcher: gateway, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
    await instance.track({ number: NUMBER });
    await instance.recognize!(NUMBER).catch(() => undefined);
    expect(gateway).toHaveBeenCalledTimes(2);
    // Once the rest is over, the gateway is asked again.
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DIRECT_REST_MS + 1);
    try { await client.fetch(NUMBER); } finally { later.mockRestore(); }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps rate limits, changed schemas and unprocessable references away from the browser', async () => {
    const limited = direct('{}', 429, { 'retry-after': '30' });
    await expect(limited.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    const html = direct('<html>blocked</html>');
    await expect(html.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    const internal = direct([{ status: 500, trackingIds: [NUMBER], error: { errorCode: -1, message: 'Unexpected exception' } }]);
    await expect(internal.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    for (const client of [limited, html, internal]) expect(client.browser).not.toHaveBeenCalled();
  });

  it('answers without a browser service and names it only when the gateway refuses', async () => {
    const answered = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(fixture()));
    await expect(new AustraliaPostTracker({ trawl: null, fetcher: answered }).fetch(NUMBER, { budgetMs: 5_000 })).resolves.toMatchObject({ status: 'delivered' });
    await expect(new AustraliaPostTracker({ trawl: null, fetcher: refused() }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'challenge', message: expect.stringContaining('browser tracking service') });
  });
});

describe('Australia Post recognition', () => {
  it('asks the gateway alone and reads only its not-found entry as unknown', async () => {
    const browser = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(service()));
    const fetcher = vi.fn<typeof fetch>();
    const instance = adapter({ trawl: browserService(browser), fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
    fetcher.mockResolvedValueOnce(Response.json(fixture()));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-06-08T04:10:00.000Z' });
    // A recognition budget past the lookup's minute still asks.
    fetcher.mockResolvedValueOnce(Response.json(fixture()));
    await expect(instance.recognize!(NUMBER, { budgetMs: 120_000 })).resolves.toEqual({ known: true, lastActivityAt: '2026-06-08T04:10:00.000Z' });
    const unknown = empty(); unknown[0].trackingIds = [NUMBER];
    fetcher.mockResolvedValueOnce(Response.json(unknown));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: false });
    // A refusal, an unprocessable reference and a known article without scans are not answers.
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    fetcher.mockResolvedValueOnce(Response.json([{ status: 500, trackingIds: [NUMBER], error: { errorCode: -1, message: 'Unexpected exception' } }]));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    const bare = fixture(); bare[0].shipment.articles[0].details[0].events = [];
    fetcher.mockResolvedValueOnce(Response.json(bare));
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(browser).not.toHaveBeenCalled();
    fetcher.mockClear();
    await expect(instance.recognize!('ABC123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('names itself for any number in its tracking links, including the search route in the fragment', () => {
    // A consignment detection does not name on its own: only the link says whose it is.
    const consignment = '33ZZZ0000001';
    for (const number of [NUMBER, consignment]) {
      for (const link of [
        `https://auspost.com.au/mypost/track/details/${number}`,
        `https://auspost.com.au/mypost/track/#/search?id=${number}`,
        `https://auspost.com.au/mypost/track#/search?lang=en&id=${number}`,
      ]) expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: number, carrier: 'australia-post', confidence: 'high', source: 'link' });
    }
  });
});

describe('Australia Post browser retrieval', () => {
  it('serializes exact capture and page URLs, reserves transport time and records the step', async () => {
    const { trawl, fetcher, direct: refusedDirect } = tracker(service());
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const carrier = adapter({ trawl, fetcher: refusedDirect, recorder, env: {}, browserExecutablePath: null });
    await expect(carrier.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(request).toMatchObject({ url: australiaPostTrackingUrl(NUMBER), skipHttp: true,
      maxTier: 3, captureResponses: [australiaPostApiUrl(NUMBER)] });
    expect(request.maxTimeout).toBeGreaterThan(29_000);
    expect(request.maxTimeout).toBeLessThanOrEqual(30_000);
    expect(JSON.stringify(request)).not.toMatch(/api-key|Cookie|Authorization/);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'australia-post', step: 'trawl', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ok', attempts: 2 }));
  });

  it('uses only the latest exact response, ignoring preflight and unrelated numbers', async () => {
    const unrelated = { ...capture(), url: australiaPostApiUrl(OTHER) };
    await expect(tracker(service([capture({}, 403), capture(), { ...capture({}, 204) }, unrelated])).tracker.fetch(NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    await expect(tracker(service([unrelated])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(tracker(service([capture(), capture({}, 403)])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('classifies the inner matched negative response while HTTP errors remain separate', async () => {
    const payload = empty(); payload[0].trackingIds = [NUMBER];
    await expect(tracker(service([capture(payload)])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    for (const [status, kind] of [[401, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const) {
      await expect(tracker(service([capture({}, status)])).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind });
    }
  });

  it('rejects empty, oversized, incomplete and malformed captures', async () => {
    for (const value of [
      service([]), service([capture()], { tier: 1 }),
      service([{ ...capture(), body: 'not JSON' }]),
      service([{ ...capture(), body: 'x'.repeat(1_000_001) }]),
      service([{ ...capture(), truncated: true }]),
      service([{ ...capture(), base64Encoded: true }]),
      service([{ ...capture(), error: 'capture failed' }]),
    ]) await expect(tracker(value).tracker.fetch(NUMBER)).rejects.toThrow();
  });

  it('validates input and honors cancellation and caller budgets', async () => {
    const { tracker: client, fetcher } = tracker(service());
    await expect(client.fetch('bad')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(client.fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    for (const budgetMs of [0, -1, Infinity, 60_001]) await expect(client.fetch(NUMBER, { budgetMs })).rejects.toThrow('budget');
    await expect(client.fetch('7'.repeat(35))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(client.fetch(NUMBER, { budgetMs: 15_000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    await client.fetch(NUMBER, { budgetMs: 20_000 });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).maxTimeout).toBeLessThanOrEqual(5000);
    expect(normalizeAustraliaPostNumber('7t0000000001000000001')).toBe(NUMBER);
  });

  it('also works through an adapter with the no-op recorder', async () => {
    const { trawl, direct: fetcher } = tracker(service());
    await expect(adapter({ trawl, fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null }).track({ number: NUMBER }))
      .resolves.toMatchObject({ status: 'delivered' });
  });
});

describe('Australia Post opt-in browser proxy recovery', () => {
  const proxy = 'http://test-user:test-pass@proxy.example.test:8080';
  function routed(replies: unknown[], budgetMs?: number) {
    const browser = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(replies.shift()));
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const client = new AustraliaPostTracker({ trawl: browserService(browser),
      fetcher: refused(), recorder, fallbackProxyUrl: proxy, timeoutMs: budgetMs });
    return { client, browser, recorder };
  }

  it('uses the proxy once after a browser challenge, preserving history and route provenance', async () => {
    const { client, browser, recorder } = routed([service([capture({}, 403)]), service()]);
    const result = await client.fetch(NUMBER);
    expect(result).toEqual(parse(fixture(), NUMBER));
    expect(browser).toHaveBeenCalledTimes(2);
    const [primary, retry] = browser.mock.calls.map(call => JSON.parse(String(call[1]!.body)));
    expect(primary).not.toHaveProperty('proxy');
    expect(primary.maxTimeout).toBeGreaterThan(29_000);
    expect(retry).toMatchObject({ proxy, url: australiaPostTrackingUrl(NUMBER), captureResponses: [australiaPostApiUrl(NUMBER)], skipHttp: true, maxTier: 3 });
    expect(retry.maxTimeout).toBeLessThanOrEqual(30_000);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'challenge', networkRoute: 'default', networkAttempt: 'initial', historyAvailable: false }));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok', networkRoute: 'residential', networkAttempt: 'retry', historyAvailable: true }));
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 3, outcome: 'ok' }));
    expect(JSON.stringify(recorder.step.mock.calls)).not.toContain(proxy);
  });

  it('keeps a successful primary browser read and its full budget without a paid request', async () => {
    const { client, browser } = routed([service()]);
    await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(browser).toHaveBeenCalledTimes(1);
    const first = JSON.parse(String(browser.mock.calls[0]![1]!.body));
    expect(first.maxTimeout).toBeGreaterThan(29_000);
    expect(first).not.toHaveProperty('proxy');
  });

  it('does not proxy missing, empty, rate-limited, mismatched or malformed replies', async () => {
    const missing = empty(); missing[0].trackingIds = [NUMBER];
    const noHistory = fixture(); noHistory[0].shipment.articles[0].details[0].events = [];
    const wrong = fixture(); wrong[0].trackingIds = [OTHER];
    for (const payload of [service([capture(missing)]), service([capture(noHistory)]), service([capture({}, 429)]),
      service([capture(wrong)]), service([{ ...capture(), body: 'invalid-json' }]), service([])]) {
      const { client, browser } = routed([payload, service()]);
      await expect(client.fetch(NUMBER)).rejects.toThrow();
      expect(browser).toHaveBeenCalledTimes(1);
    }
  });

  it('preserves a short-budget challenge without recording or sending another attempt', async () => {
    const { client, browser, recorder } = routed([service([capture({}, 403)]), service()], 20_000);
    await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(browser).toHaveBeenCalledTimes(1);
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2, finalStep: 'trawl' }));
  });

  it('accounts for time already spent before deciding whether a proxy request fits', async () => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const browser = vi.fn<typeof fetch>().mockImplementation(async () => { elapsed = 30_000; return Response.json(service([capture({}, 403)])); });
      const client = new AustraliaPostTracker({ trawl: browserService(browser), fetcher: refused(), fallbackProxyUrl: proxy });
      await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
      expect(browser).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });

  it('keeps the proxy reply failure kind and retry-after, with no further recovery', async () => {
    const limited = { ...capture({}, 429), headers: { 'retry-after': '9' } };
    const { client, browser } = routed([service([capture({}, 401)]), service([limited])]);
    await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 9000 });
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it('starts no proxy request after cancellation', async () => {
    const controller = new AbortController();
    const browser = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(new Error('stopped')); return Response.json(service([capture({}, 403)])); });
    const client = new AustraliaPostTracker({ trawl: browserService(browser), fetcher: refused(), fallbackProxyUrl: proxy });
    await expect(client.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(browser).toHaveBeenCalledTimes(1);
  });

  it('requires explicit configuration and validates it without exposing credentials', async () => {
    const { tracker: noProxy, fetcher } = tracker(service([capture({}, 403)]));
    await expect(noProxy.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() => new AustraliaPostTracker({ trawl: null, fallbackProxyUrl: 'http://test-user:PRIVATE_PASSWORD@proxy.example.test/path' }))
      .toThrow('Browser retry proxy must be an HTTP(S) origin');
    try { new AustraliaPostTracker({ trawl: null, fallbackProxyUrl: 'http://test-user:PRIVATE_PASSWORD@proxy.example.test/path' }); }
    catch (error) { expect(String(error)).not.toContain('PRIVATE_PASSWORD'); }
  });

  it('reads host configuration for tracking while HTTP recognition never opens either browser route', async () => {
    const browser = vi.fn<typeof fetch>().mockResolvedValue(Response.json(service()));
    const instance = adapter({ trawl: browserService(browser), fetcher: refused(), recorder: NOOP_RECORDER,
      env: { AUSTRALIA_POST_FALLBACK_PROXY_URL: proxy }, browserExecutablePath: null });
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(browser).not.toHaveBeenCalled();
  });
});
