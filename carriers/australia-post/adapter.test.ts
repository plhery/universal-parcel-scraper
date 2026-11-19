import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapter, AustraliaPostTracker, australiaPostApiUrl, australiaPostTrackingUrl, normalizeAustraliaPostNumber, parse, type AustraliaPostTrackerOptions } from './adapter.js';
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
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
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
  it.each([401, 403])('keeps a direct HTTP %i refusal in recovery telemetry without its response body', async status => {
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const { fetcher, browser } = direct('PRIVATE_REFUSAL_BODY', status);
    const client = new AustraliaPostTracker({ trawl: browserService(browser), fetcher, recorder });
    await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    const refusedStep = recorder.step.mock.calls.find(([record]) => record.step === 'direct')?.[0];
    const recoveredStep = recorder.step.mock.calls.find(([record]) => record.step === 'trawl')?.[0];
    expect(refusedStep).toMatchObject({ outcome: 'challenge', error: { kind: 'challenge', status, reason: `http_${status}` } });
    expect(recoveredStep).toMatchObject({ outcome: 'ok', fallbackError: refusedStep.error });
    expect(String(refusedStep.error)).toContain(`HTTP ${status}`);
    expect(JSON.stringify(recorder.step.mock.calls)).not.toContain('PRIVATE_REFUSAL_BODY');
    expect(browser).toHaveBeenCalledTimes(1);
    const gateway = new AustraliaPostTracker({ trawl: null, fetcher });
    await expect(gateway.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', status, reason: `http_${status}`,
      message: `Australia Post requires the browser tracking service (tracking API HTTP ${status})` });
  });

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
  it.each([401, 403])('keeps the latest whole-bound HTTP %i refusal in the thrown error and recorder', async status => {
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const otherStatus = status === 401 ? 403 : 401;
    const { trawl, direct: fetcher } = tracker(service([capture({}, otherStatus),
      capture('PRIVATE_REFUSAL_BODY', status), { ...capture({}, otherStatus), url: australiaPostApiUrl(OTHER) }]));
    const client = new AustraliaPostTracker({ trawl, fetcher, recorder });
    await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', status, reason: `http_${status}`,
      message: `Australia Post tracking API returned HTTP ${status}` });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'challenge',
      error: expect.objectContaining({ kind: 'challenge', status, reason: `http_${status}` }) }));
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'challenge',
      error: expect.objectContaining({ status, reason: `http_${status}` }) }));
    expect(JSON.stringify(recorder.step.mock.calls)).not.toContain('PRIVATE_REFUSAL_BODY');
  });

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
  function routed(replies: unknown[], budgetMs?: number, firstRoute?: AustraliaPostTrackerOptions['firstRoute']) {
    const browser = vi.fn<typeof fetch>().mockImplementation(async () => {
      const reply = replies.shift();
      return typeof reply === 'function' ? reply() : Response.json(reply);
    });
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const client = new AustraliaPostTracker({ trawl: browserService(browser),
      fetcher: refused(), recorder, fallbackProxyUrl: proxy, timeoutMs: budgetMs, firstRoute, residentialDailyBytes: Infinity });
    return { client, browser, recorder };
  }
  const bodies = (browser: ReturnType<typeof vi.fn<typeof fetch>>) => browser.mock.calls.map(call => JSON.parse(String(call[1]!.body)) as Record<string, unknown>);

  it('uses the proxy once after a browser challenge, preserving history and route provenance', async () => {
    const { client, browser, recorder } = routed([service([capture({}, 403)]), service()]);
    const result = await client.fetch(NUMBER);
    expect(result).toEqual(parse(fixture(), NUMBER));
    expect(browser).toHaveBeenCalledTimes(2);
    const [primary, retry] = browser.mock.calls.map(call => JSON.parse(String(call[1]!.body)));
    expect(primary).not.toHaveProperty('proxy');
    expect(primary.maxTimeout).toBe(20_000);
    expect(retry).toMatchObject({ proxy, url: australiaPostTrackingUrl(NUMBER), captureResponses: [australiaPostApiUrl(NUMBER)], skipHttp: true, maxTier: 3 });
    expect(retry.maxTimeout).toBeLessThanOrEqual(30_000);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'challenge', networkRoute: 'default', networkAttempt: 'initial', historyAvailable: false }));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok', networkRoute: 'residential', networkAttempt: 'retry', historyAvailable: true }));
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 3, outcome: 'ok' }));
    expect(JSON.stringify(recorder.step.mock.calls)).not.toContain(proxy);
  });

  it('keeps a successful primary browser read without a paid request, leaving the next route its time', async () => {
    const { client, browser } = routed([service()]);
    await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(browser).toHaveBeenCalledTimes(1);
    const first = JSON.parse(String(browser.mock.calls[0]![1]!.body));
    expect(first.maxTimeout).toBe(20_000);
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

  it('sends the first browser read through the proxy when it is the first route, and the retry after a challenge on the original route', async () => {
    const { client, browser, recorder } = routed([service([capture({}, 403)]), service()], undefined, 'residential');
    await expect(client.fetch(NUMBER)).resolves.toEqual(parse(fixture(), NUMBER));
    const [primary, retry] = bodies(browser);
    expect(primary).toMatchObject({ proxy, url: australiaPostTrackingUrl(NUMBER), captureResponses: [australiaPostApiUrl(NUMBER)] });
    expect(primary!.maxTimeout).toBe(20_000);
    expect(retry).not.toHaveProperty('proxy');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'challenge', networkRoute: 'residential', networkAttempt: 'initial' }));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok', networkRoute: 'default', networkAttempt: 'retry', historyAvailable: true }));
    expect(JSON.stringify(recorder.step.mock.calls)).not.toContain(proxy);
  });

  it('keeps an answered first read through the proxy without another', async () => {
    const { client, browser } = routed([service()], undefined, 'residential');
    await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(bodies(browser).map(body => body.proxy)).toEqual([proxy]);
  });

  it('reads on the original route when the proxy fails to carry the first read, and keeps the parcel’s own answers', async () => {
    const { client, browser } = routed([service([]), service()], undefined, 'residential');
    await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(bodies(browser).map(body => body.proxy ?? null)).toEqual([proxy, null]);
    const missing = empty(); missing[0].trackingIds = [NUMBER];
    for (const payload of [service([capture(missing)]), service([capture({}, 429)]), service([{ ...capture(), body: 'invalid-json' }])]) {
      const answered = routed([payload, service()], undefined, 'residential');
      await expect(answered.client.fetch(NUMBER)).rejects.toThrow();
      expect(answered.browser).toHaveBeenCalledTimes(1);
    }
  });

  const trawlFailure = (reason: string, error = 'Max tier reached without success', status = 500) => () => new Response(
    JSON.stringify({ error, timings: [{ tier: 3, status: 'error', reason }] }), { status, headers: { 'Content-Type': 'application/json' } });

  it('reads on the original route when the browser service fails on the first read through the proxy, or the read ran out of its share', async () => {
    for (const failure of [trawlFailure('Navigation failed'), trawlFailure('proxy-connection-failed'), trawlFailure('busy', 'Service unavailable', 503),
      trawlFailure('Scrape deadline exceeded', 'Scrape deadline exceeded')]) {
      const { client, browser, recorder } = routed([failure, service()], undefined, 'residential');
      await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      expect(bodies(browser).map(body => body.proxy ?? null)).toEqual([proxy, null]);
      expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok', networkRoute: 'default', networkAttempt: 'retry' }));
    }
    // Out of the whole budget, refused by TRAWL itself, or a server error Australia Post answered: no second read.
    for (const [failure, failed, budgetMs] of [[trawlFailure('Scrape deadline exceeded', 'Scrape deadline exceeded'), { kind: 'budget' }, 30_000],
      [trawlFailure('busy', 'Too many requests', 429), { kind: 'rate_limited' }, undefined],
      [service([capture({}, 503)]), { provider: 'Australia Post', status: 503 }, undefined]] as const) {
      const { client, browser } = routed([failure, service()], budgetMs, 'residential');
      await expect(client.fetch(NUMBER)).rejects.toMatchObject(failed);
      expect(browser).toHaveBeenCalledTimes(1);
    }
    // On the original route first, a browser service failure takes no proxy request.
    const { client, browser } = routed([trawlFailure('Navigation failed'), service()]);
    await expect(client.fetch(NUMBER)).rejects.toMatchObject({ status: 500 });
    expect(browser).toHaveBeenCalledTimes(1);
  });

  it('keeps the original route first without a proxy, and refuses an unknown first route', async () => {
    const browser = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(service([capture({}, 403)])));
    for (const firstRoute of ['residential', 'adaptive'] as const) {
      const client = new AustraliaPostTracker({ trawl: browserService(browser), fetcher: refused(), firstRoute });
      for (let lookup = 0; lookup < 2; lookup++) await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    }
    expect(bodies(browser).map(body => body.proxy ?? null)).toEqual([null, null, null, null]);
    expect(() => new AustraliaPostTracker({ trawl: null, fallbackProxyUrl: proxy, firstRoute: 'datacenter' as never }))
      .toThrow('Australia Post first route must be default, residential or adaptive');
  });

  describe('adaptive first route', () => {
    const WINDOW_MS = 15 * 60_000;
    let now = 0;
    beforeEach(() => { now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });
    afterEach(() => { vi.mocked(Date.now).mockRestore(); });
    function adaptive(replies: unknown[]) {
      const lookup = routed(replies, undefined, 'adaptive');
      return { ...lookup, routes: () => bodies(lookup.browser).map(body => body.proxy ?? null), advance: (ms: number) => { now += ms; } };
    }

    it('reads through the proxy first only in the window a refusal on the original route opens', async () => {
      const lookups = adaptive([service(), service([capture({}, 403)]), service(), service(), service()]);
      // Before any refusal, an answer on the original route needs no proxy.
      await expect(lookups.client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      expect(lookups.routes()).toEqual([null]);
      // A refusal is retried through the proxy, and opens the window.
      await expect(lookups.client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      expect(lookups.routes()).toEqual([null, null, proxy]);
      lookups.advance(WINDOW_MS - 1);
      await expect(lookups.client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      expect(lookups.routes()).toEqual([null, null, proxy, proxy]);
      // Once it ends, the original route comes first again.
      lookups.advance(1);
      await expect(lookups.client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      expect(lookups.routes()).toEqual([null, null, proxy, proxy, null]);
      expect(lookups.browser).toHaveBeenCalledTimes(5);
    });

    it('records the proxy read as the first attempt in the window, and keeps it open while the original route refuses', async () => {
      const refusal = service([capture({}, 403)]);
      const lookups = adaptive([refusal, service(), refusal, refusal, service(), service()]);
      await lookups.client.fetch(NUMBER);
      lookups.advance(WINDOW_MS - 1);
      // Refused through the proxy too: the original route refuses again, which starts the window again.
      await expect(lookups.client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
      lookups.advance(WINDOW_MS - 1);
      lookups.recorder.step.mockClear();
      await expect(lookups.client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      expect(lookups.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok', networkRoute: 'residential', networkAttempt: 'initial' }));
      lookups.advance(1);
      await lookups.client.fetch(NUMBER);
      expect(lookups.routes()).toEqual([null, proxy, proxy, null, proxy, null]);
    });

    it('lets a refusal through the proxy leave the window as it is', async () => {
      const refusal = service([capture({}, 403)]);
      const lookups = adaptive([refusal, service(), refusal, service(), service()]);
      await lookups.client.fetch(NUMBER);
      lookups.advance(WINDOW_MS - 1);
      await expect(lookups.client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      lookups.advance(1);
      await lookups.client.fetch(NUMBER);
      expect(lookups.routes()).toEqual([null, proxy, proxy, null, null]);
    });

    it('reads on the original route in the window when the browser service fails on the proxy read', async () => {
      const lookups = adaptive([service([capture({}, 403)]), service(), trawlFailure('Navigation failed'), service()]);
      await lookups.client.fetch(NUMBER);
      await expect(lookups.client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      expect(lookups.routes()).toEqual([null, proxy, proxy, null]);
    });

    it('opens no window on a reply the original route answers', async () => {
      const missing = empty(); missing[0].trackingIds = [NUMBER];
      const lookups = adaptive([service([capture(missing)]), service([capture({}, 429)]), service([capture({}, 500)]), service()]);
      for (let lookup = 0; lookup < 3; lookup++) await expect(lookups.client.fetch(NUMBER)).rejects.toThrow();
      await lookups.client.fetch(NUMBER);
      expect(lookups.routes()).toEqual([null, null, null, null]);
    });
  });

  it('reports a browser read TRAWL gave up for lack of time as the budget running out, and its other failures as before', async () => {
    const reply = (reason: string, error = 'Max tier reached without success') => new Response(JSON.stringify({ error,
      timings: [{ tier: 3, status: 'error', durationMs: 20_000, reason }] }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    for (const [answer, kind] of [
      [() => reply('Scrape deadline exceeded', 'Scrape deadline exceeded'), 'budget'],
      [() => reply('evaluate: Australia Post lookup budget exhausted\nframe@page:1:2'), 'budget'],
      [() => reply('evaluate: The operation was aborted. '), 'budget'],
      [() => reply('proxy-connection-failed'), 'indeterminate'],
    ] as const) {
      const recorder = { step: vi.fn(), lookup: vi.fn() };
      const browser = vi.fn<typeof fetch>().mockImplementation(async () => answer());
      const client = new AustraliaPostTracker({ trawl: browserService(browser), fetcher: refused(), recorder });
      const error: unknown = await client.fetch(NUMBER).catch(caught => caught);
      expect(error).toMatchObject({ kind });
      expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: kind === 'budget' ? 'budget' : expect.anything() }));
      if (kind === 'budget') expect((error as Error).cause).toMatchObject({ status: 500 });
      expect(browser).toHaveBeenCalledTimes(1);
    }
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
    const browser = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(service()));
    const instance = adapter({ trawl: browserService(browser), fetcher: refused(), recorder: NOOP_RECORDER,
      env: { AUSTRALIA_POST_FALLBACK_PROXY_URL: proxy }, browserExecutablePath: null });
    await expect(instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(browser).not.toHaveBeenCalled();
    const first = adapter({ trawl: browserService(browser), fetcher: refused(), recorder: NOOP_RECORDER,
      env: { AUSTRALIA_POST_FALLBACK_PROXY_URL: proxy, AUSTRALIA_POST_FIRST_ROUTE: ' residential ' }, browserExecutablePath: null });
    await expect(first.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(browser).not.toHaveBeenCalled();
    await expect(first.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect(bodies(browser).map(body => body.proxy)).toEqual([proxy]);
    const adaptive = adapter({ trawl: browserService(browser), fetcher: refused(), recorder: NOOP_RECORDER,
      env: { AUSTRALIA_POST_FALLBACK_PROXY_URL: proxy, AUSTRALIA_POST_FIRST_ROUTE: 'adaptive' }, browserExecutablePath: null });
    await expect(adaptive.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect(bodies(browser).map(body => body.proxy ?? null)).toEqual([proxy, null]);
    // A misspelt value is the original route, with one warning however many trackers read it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const value of ['Residential', 'proxy']) {
      const misspelt = adapter({ trawl: browserService(browser), fetcher: refused(), recorder: NOOP_RECORDER,
        env: { AUSTRALIA_POST_FALLBACK_PROXY_URL: proxy, AUSTRALIA_POST_FIRST_ROUTE: value }, browserExecutablePath: null });
      await expect(misspelt.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    }
    expect(bodies(browser).map(body => body.proxy ?? null)).toEqual([proxy, null, null, null]);
    expect(warn.mock.calls).toEqual([['AUSTRALIA_POST_FIRST_ROUTE must be default, residential, adaptive; using default']]);
    warn.mockRestore();
  });
});

describe('Australia Post routes, cheapest first', () => {
  const residential = 'http://test-user:test-pass@residential.example.test:8080';
  const datacenter = ['http://dc-user:dc-pass@dc-one.example.test:8080', 'http://dc-user:dc-pass@dc-two.example.test:8080'];
  let now = 0;
  beforeEach(() => { now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });
  afterEach(() => { vi.restoreAllMocks(); });
  function routes(replies: unknown[], options: Partial<AustraliaPostTrackerOptions> = {}) {
    const browser = vi.fn<typeof fetch>().mockImplementation(async () => {
      const reply = replies.shift();
      return typeof reply === 'function' ? reply() : Response.json(reply);
    });
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const client = new AustraliaPostTracker({ trawl: browserService(browser), fetcher: refused(), recorder,
      fallbackProxyUrl: residential, datacenterProxyUrls: datacenter, timeoutMs: 60_000, ...options });
    const proxies = () => browser.mock.calls.map(call => (JSON.parse(String(call[1]!.body)) as { proxy?: string }).proxy ?? null);
    return { client, browser, recorder, proxies };
  }
  const refusal = () => service([capture({}, 403)]);

  it('moves from the original route to a datacenter proxy, then to the residential one, recording each route', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    const { client, recorder, proxies } = routes([refusal(), refusal(), service()]);
    await expect(client.fetch(NUMBER)).resolves.toEqual(parse(fixture(), NUMBER));
    expect(proxies()).toEqual([null, datacenter[1], residential]);
    const steps = recorder.step.mock.calls.map(([record]) => record).filter(record => record.step === 'trawl');
    expect(steps.map(record => [record.networkRoute, record.networkAttempt, record.outcome]))
      .toEqual([['default', 'initial', 'challenge'], ['datacenter', 'retry', 'challenge'], ['residential', 'retry', 'ok']]);
    expect(JSON.stringify(recorder.step.mock.calls)).not.toMatch(/pass@/);
  });

  it('stops at the first route that answers, and keeps a parcel’s own answers', async () => {
    const answered = routes([refusal(), service()]);
    await expect(answered.client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(answered.proxies()).toEqual([null, expect.stringMatching(/^http:\/\/dc-user/)]);
    const limited = routes([refusal(), service([capture({}, 429)]), service()]);
    await expect(limited.client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(limited.browser).toHaveBeenCalledTimes(2);
  });

  it('takes the proxies first in a refusal spell, the datacenter before the residential one, then the original route', async () => {
    const { client, proxies } = routes([refusal(), refusal(), refusal(), service()], { firstRoute: 'adaptive' });
    await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    now += 60_000;
    await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(proxies().map(value => value === residential ? 'residential' : value ? 'datacenter' : 'default'))
      .toEqual(['default', 'datacenter', 'residential', 'datacenter']);
  });

  it('moves on when a datacenter proxy fails to carry a read, but not when the original route does', async () => {
    const carried = routes([refusal(), service([]), service()]);
    await expect(carried.client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(carried.proxies()).toEqual([null, expect.any(String), residential]);
    const original = routes([service([]), service()]);
    await expect(original.client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    expect(original.browser).toHaveBeenCalledTimes(1);
  });

  it('starts a third read only when the budget still fits one', async () => {
    const { client, browser } = routes([refusal(), refusal(), service()], { timeoutMs: 45_000 });
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    browser.mockImplementation(async () => { elapsed += 12_000; return Response.json(refusal()); });
    await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(browser).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  it('cuts a read another route can follow at 20 s, and moves on when the page hangs that long', async () => {
    const hang = () => new Response(JSON.stringify({ error: 'Max tier reached without success',
      timings: [{ tier: 3, status: 'error', reason: 'Australia Post browser budget exhausted (phase=navigation)' }] }),
    { status: 500, headers: { 'Content-Type': 'application/json' } });
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const { client, browser, recorder, proxies } = routes([], { firstRoute: 'adaptive' });
    const timeouts = () => browser.mock.calls.map(call => (JSON.parse(String(call[1]!.body)) as { maxTimeout: number }).maxTimeout);
    const answer = (answered: boolean) => browser.mockImplementation(async (_input, init) => {
      const { maxTimeout } = JSON.parse(String(init!.body)) as { maxTimeout: number };
      elapsed += maxTimeout;
      return maxTimeout === 20_000 || !answered ? hang() : Response.json(service());
    });
    answer(true);
    await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    // 60 s: 20 s on the original route, then all that remains through a datacenter proxy, since a
    // third read would not fit after another 20 s.
    expect(timeouts()).toEqual([20_000, 25_000]);
    expect(proxies().map(value => value === residential ? 'residential' : value ? 'datacenter' : 'default')).toEqual(['default', 'datacenter']);
    const steps = recorder.step.mock.calls.map(([record]) => record).filter(record => record.step === 'trawl');
    expect(steps.map(record => [record.networkRoute, record.outcome])).toEqual([['default', 'budget'], ['datacenter', 'ok']]);
    // The hang on the original route sends the next lookup through the proxies first.
    elapsed = 0; browser.mockClear();
    browser.mockImplementation(async () => Response.json(service()));
    await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(proxies()).toEqual([expect.stringMatching(/^http:\/\/dc-user/)]);
    // Without that window, two hangs fail as the budget, and a 45 s budget leaves the second read the rest.
    const later = routes([], { timeoutMs: 45_000 });
    elapsed = 0;
    browser.mockReset();
    later.browser.mockImplementation(async (_input, init) => { elapsed += (JSON.parse(String(init!.body)) as { maxTimeout: number }).maxTimeout; return hang(); });
    await expect(later.client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'budget' });
    expect(later.browser.mock.calls.map(call => (JSON.parse(String(call[1]!.body)) as { maxTimeout: number }).maxTimeout)).toEqual([20_000, 10_000]);
  });

  it('keeps the whole remaining budget for the last route, and its running out as the budget', async () => {
    const { client, browser } = routes([], { fallbackProxyUrl: undefined, datacenterProxyUrls: [] });
    browser.mockImplementation(async () => new Response(JSON.stringify({ error: 'Scrape deadline exceeded', timings: [] }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }));
    await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'budget' });
    expect(browser).toHaveBeenCalledTimes(1);
    expect((JSON.parse(String(browser.mock.calls[0]![1]!.body)) as { maxTimeout: number }).maxTimeout).toBeGreaterThan(44_000);
  });

  it('reads a datacenter list separated by spaces or commas and validates each entry without exposing it', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { client, proxies } = routes([refusal(), service()], { datacenterProxyUrls: ` ${datacenter[0]}, ${datacenter[1]}\n` });
    await client.fetch(NUMBER);
    expect(proxies()).toEqual([null, datacenter[1]]);
    const invalid = () => new AustraliaPostTracker({ trawl: null, datacenterProxyUrls: [datacenter[0]!, 'http://dc-user:PRIVATE_PASSWORD@dc.example.test/path'] });
    expect(invalid).toThrow('Browser retry proxy must be an HTTP(S) origin');
    try { invalid(); } catch (error) { expect(String(error)).not.toContain('PRIVATE_PASSWORD'); }
    // Datacenter proxies alone are enough for a proxy-first route.
    const alone = routes([service()], { fallbackProxyUrl: undefined, firstRoute: 'residential' });
    await alone.client.fetch(NUMBER);
    expect(alone.proxies()).toEqual([expect.stringMatching(/^http:\/\/dc-user/)]);
  });

  describe('residential daily share', () => {
    const DAY_MS = 86_400_000;

    it('starts with one read and refills at the daily share, warning at most hourly while it is spent', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { client, proxies } = routes(Array.from({ length: 30 }, () => refusal()), { datacenterProxyUrls: undefined, residentialDailyBytes: 1_500_000 });
      const lookup = async () => { await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' }); };
      await lookup();
      expect(proxies()).toEqual([null, residential]);
      // A read's 0.15 MB comes back after a tenth of a day at 1.5 MB a day.
      now += DAY_MS / 10 - 60_000;
      await lookup();
      await lookup();
      expect(proxies()).toEqual([null, residential, null, null]);
      expect(warn.mock.calls).toEqual([['Australia Post: the residential proxy has used its daily share; it carries no read until the share refills']]);
      now += 60_000;
      await lookup();
      expect(proxies().slice(4)).toEqual([null, residential]);
      // The share holds at most a quarter of a day: a long quiet spell does not bank a burst.
      now += 10 * DAY_MS;
      for (let index = 0; index < 4; index++) await lookup();
      expect(proxies().slice(6).filter(value => value === residential)).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('leaves the datacenter route and the original one to carry reads once the share is spent', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { client, proxies } = routes([refusal(), refusal(), service(), refusal(), refusal(), service()]);
      await expect(client.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
      await expect(client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
      expect(proxies().map(value => value === residential ? 'residential' : value ? 'datacenter' : 'default'))
        .toEqual(['default', 'datacenter', 'residential', 'default', 'datacenter']);
    });

    it('can be unbounded, refuses a share that is not a positive number, and reads its setting', async () => {
      const unbounded = routes(Array.from({ length: 6 }, () => refusal()), { datacenterProxyUrls: undefined, residentialDailyBytes: Infinity });
      for (let index = 0; index < 3; index++) await expect(unbounded.client.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
      expect(unbounded.proxies().filter(value => value === residential)).toHaveLength(3);
      for (const value of [0, -1, Number.NaN, '1' as never]) {
        expect(() => new AustraliaPostTracker({ trawl: null, residentialDailyBytes: value }))
          .toThrow('Australia Post residential daily bytes must be a positive number');
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const browser = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(refusal()));
      for (const daily of ['300000', 'lots']) {
        const instance = adapter({ trawl: browserService(browser), fetcher: refused(), recorder: NOOP_RECORDER, browserExecutablePath: null,
          env: { AUSTRALIA_POST_FALLBACK_PROXY_URL: residential, AUSTRALIA_POST_DATACENTER_PROXY_URLS: datacenter.join(','),
            AUSTRALIA_POST_FALLBACK_PROXY_DAILY_BYTES: daily } });
        await expect(instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
      }
      expect(warn.mock.calls).toContainEqual(['AUSTRALIA_POST_FALLBACK_PROXY_DAILY_BYTES must be a positive number; using 33000000']);
    });
  });
});
