import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { dateLocalClocks } from '../../places/index.js';
import { adapter, normalizeUSPSNumber, parseUSPSTrackingHtml, USPSTracker, uspsTrackingUrl } from './adapter.js';
import { uspsStage, uspsStatus } from './status.js';

// 9400111899223397910421 and 9400111899223397910438 are made-up numbers in
// USPS's published format. No real shipment, recipient or signatory appears
// in this file.
const DELIVERED_NUMBER = '9400111899223397910421';
const IN_TRANSIT_NUMBER = '9400111899223397910438';
const TRAWL_URL = 'http://trawl.internal:8191';
// Reads pause per browser service after a run of outage redirects, so a test that meets them asks its own.
let services = 0;
const ownTrawl = () => new TrawlClient(`http://trawl-${++services}.internal:8191`);
const DELIVERED_PAGE = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const IN_TRANSIT_PAGE = readFileSync(new URL('./fixtures/in-transit.html', import.meta.url), 'utf8');
const TIMELINE_PAGE = readFileSync(new URL('./fixtures/timeline.html', import.meta.url), 'utf8');
const ESTIMATE_PAGE = readFileSync(new URL('./fixtures/estimate.html', import.meta.url), 'utf8');
const HEADER_ONLY_PAGE = '<html><head><title>USPS Tracking® | USPS</title></head><body><div class="Widgets_Container"><div id="g-navigation">Navigation</div></div></body></html>';
// The bot check's interstitial: no title, no content, one inline script (synthetic here).
const HEAD_ONLY_PAGE = '<!DOCTYPE html><html lang="en"><head><title>USPS Tracking® | USPS</title><script src="scripts/libs/jquery.min.js"></script></head></html>';
const INTERSTITIAL_PAGE = '<!DOCTYPE html><html><head><title></title><style>html, body { margin: 0; }</style></head><body><script>(function () { /* synthetic check */ })();</script></body></html>';
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function stepRecorder(): { recorder: StepRecorder; records: string[] } {
  const records: string[] = [];
  return {
    records,
    recorder: {
      step: (record) => records.push(`${record.step}:${record.outcome}`),
      lookup: (record) => records.push(`lookup:${record.finalStep}:${record.outcome}`),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('USPS international numbers', () => {
  // Synthetic S10 serial; the check digit is independent of the country suffix.
  it.each(['CN', 'GB', 'CH', 'US'])('accepts a valid postal number issued in %s', (country) => {
    const raw = `lz 123.456-785 ${country.toLowerCase()}`;
    const expected = `LZ123456785${country}`;
    expect(normalizeUSPSNumber(raw)).toBe(expected);
    expect(uspsTrackingUrl(raw)).toBe(`https://tools.usps.com/tracking/${expected}`);
  });

  it.each(['LZ123456789CN', 'LZ123456789US', 'LZ12345678CN', 'LZ123456785C'])(
    'rejects invalid international number %s before making a request', async (number) => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch'));
      const lookup = new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(number);
      await expect(lookup).rejects.toThrow('checksum-valid UPU S10');
      await expect(lookup).rejects.toMatchObject({ kind: 'invalid_input' });
      expect(fetcher).not.toHaveBeenCalled();
    });
});

describe('USPS status vocabulary', () => {
  it('maps the wording, and nothing else', () => {
    expect(uspsStage('Delivered, In/At Mailbox')).toBe('delivered');
    expect(uspsStage('Out for Delivery')).toBe('out_for_delivery');
    expect(uspsStage('Notice Left')).toBe('failed_attempt');
    // A Post Office counter's receipt for an item handed in, before "Departed Post Office".
    expect(uspsStage('USPS electronic receipt of item for mailing')).toBe('accepted');
    expect(uspsStage('Insufficient Address')).toBe('failed_attempt');
    expect(uspsStage('Refused')).toBe('returned');
    expect(uspsStage('Pre-Shipment')).toBe('registered');
    // A label printed at the counter, dated by its day alone; the scan of the item that follows is the acceptance.
    expect(uspsStage('Shipping Label Printed at Post Office')).toBe('registered');
    expect(uspsStage('Available for Pickup')).toBe('ready_for_pickup');
    // The destination post holding international mail until the recipient pays its import charges.
    expect(uspsStage('Payment of charges - Item being held, addressee being notified')).toBe('customs');
    // The delivering post office's arrival comes before the delivery round; a held parcel waits for collection.
    expect(uspsStage('Arrived at Post Office')).toBe('in_transit');
    // A cleared customs line, in either word order, is a step in transit.
    expect(uspsStage('Cleared Customs')).toBe('in_transit');
    expect(uspsStage('Customs Clearance')).toBe('customs');
    expect(uspsStage('Held at Post Office, At Customer Request')).toBe('ready_for_pickup');
    expect(uspsStage('Held at Delivery Depot/Delivery Office')).toBe('ready_for_pickup');
    expect(uspsStage('Accepted at USPS Origin Facility')).toBe('accepted');
    expect(uspsStage('Acceptance')).toBe('accepted');
    expect(uspsStage('Acceptance Pending')).toBe('registered');
    expect(uspsStage('Arrived at USPS Facility')).toBe('in_transit');
    expect(uspsStage('Arrived at USPS Regional Facility')).toBe('in_transit');
    // The international service center's export dispatch, before the flight abroad.
    expect(uspsStage('International Dispatch Ready')).toBe('in_transit');
    // A delivery day ended without a delivery scan: the delivery moves to the next business day.
    expect(uspsStage('Awaiting Delivery')).toBe('in_transit');
    expect(uspsStage('Awaiting Delivery Scan')).toBe('in_transit');
    expect(uspsStatus('Delivered')).toBe('delivered');
    expect(uspsStatus('Out for Delivery')).toBe('out_for_delivery');
    // Unrecognized wording only means "moving" once the shipment has scans.
    expect(uspsStatus('Wording USPS has not used before')).toBe('unknown');
    expect(uspsStatus('Wording USPS has not used before', true)).toBe('in_transit');
    expect(uspsStage('Wording USPS has not used before')).toBeNull();
  });
});

describe('USPS rendered page', () => {
  it('reads current and collapsed timeline scans without letting old exceptions override delivery', () => {
    const result = parseUSPSTrackingHtml(TIMELINE_PAGE, DELIVERED_NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2025-03-14T12:17:00-04:00', expected_delivery: null });
    expect(result.events).toHaveLength(5);
    expect(result.events?.map(event => event.description)).toEqual([
      'Delivered', 'Out for Delivery', 'Notice Left (No Authorized Recipient Available)',
      'In Transit, Arriving On Time', 'Accepted at USPS Origin Facility',
    ]);
    expect(result.events?.[2]!.stage).toBe('failed_attempt');
    expect(result.events?.[3]).toEqual({ description: 'In Transit, Arriving On Time',
      local_time: '2025-03-12T16:31:00', stage: 'in_transit' });
    expect(result.events?.[4]!.time).toBe('2025-03-11T21:45:00-07:00');
    expect(JSON.stringify(result)).not.toContain('PRIVATE RECIPIENT');
  });

  it('reads USPS taking over a parcel its shipping partner already moved as transit', () => {
    const scan = (detail: string, date: string) => `<div class="tb-step collapsed"><div><p class="tb-status-detail">${detail}</p>`
      + `<p class="tb-location">EXAMPLE CITY, CA 00000</p><p class="tb-date">${date}</p></div></div>`;
    const steps = TIMELINE_PAGE.slice(TIMELINE_PAGE.indexOf('<div class="tb-step current-step">'), TIMELINE_PAGE.indexOf('<div class="tb-step"><p'));
    const page = TIMELINE_PAGE.replace('<div class="banner-header">Delivered</div>', '<div class="banner-header">In Transit</div>')
      .replace(steps, `<div class="tb-step current-step"><p class="tb-status">Accepted</p><p class="tb-status-detail">USPS in possession of item</p>`
        + '<p class="tb-location">EXAMPLE CITY, CA 00000</p><p class="tb-date">March 13, 2025 9:58 AM</p></div>'
        + scan('Departed Shipping Partner Facility', 'March 12, 2025 12:24 PM') + scan('Picked Up by Shipping Partner', 'March 11, 2025 2:18 PM'));
    const result = parseUSPSTrackingHtml(page, DELIVERED_NUMBER);
    expect(result.current_stage).toBe('in_transit');
    expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'in_transit', 'accepted']);
    // Without the partner's transit, USPS's own possession scan stays the acceptance.
    const alone = parseUSPSTrackingHtml(page.replace(scan('Departed Shipping Partner Facility', 'March 12, 2025 12:24 PM'), ''), DELIVERED_NUMBER);
    expect(alone.current_stage).toBe('accepted');
    expect(alone.events?.map(event => event.stage)).toEqual(['accepted', 'accepted']);
  });

  it('reads the scans after a return started as the trip back to the sender', () => {
    const scan = (detail: string, date: string) => `<div class="tb-step collapsed"><div><p class="tb-status-detail">${detail}</p>`
      + `<p class="tb-location">EXAMPLE CITY, CA 00000</p><p class="tb-date">${date}</p></div></div>`;
    const steps = TIMELINE_PAGE.slice(TIMELINE_PAGE.indexOf('<div class="tb-step current-step">'), TIMELINE_PAGE.indexOf('<div class="tb-step"><p'));
    const page = (banner: string, current: string) => TIMELINE_PAGE.replace('<div class="banner-header">Delivered</div>', `<div class="banner-header">${banner}</div>`)
      .replace(steps, `<div class="tb-step current-step"><p class="tb-status">${banner}</p><p class="tb-status-detail">${current}</p>`
        + '<p class="tb-location">EXAMPLE CITY, CA 00000</p><p class="tb-date">March 14, 2025 9:58 AM</p></div>'
        + scan('Refused', 'March 12, 2025 12:40 PM') + scan('Return to Sender Processed', 'March 12, 2025 12:13 PM')
        + scan('Out for Delivery', 'March 12, 2025 8:02 AM') + scan('Insufficient Address', 'March 11, 2025 4:55 PM'));
    const back = parseUSPSTrackingHtml(page('In Transit', 'Arrived at USPS Facility'), DELIVERED_NUMBER);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Arrived at USPS Facility' });
    expect(back.events?.map(event => [event.description, event.stage, event.provider_leg ?? null])).toEqual([
      ['Arrived at USPS Facility', 'returned', 'return'],
      ['Refused', 'returned', 'return'],
      ['Return to Sender Processed', 'returned', 'return'],
      ['Out for Delivery', 'out_for_delivery', null],
      ['Insufficient Address', 'failed_attempt', null],
    ]);
    const home = parseUSPSTrackingHtml(page('Delivered', 'Delivered, To Original Sender'), DELIVERED_NUMBER);
    expect(home).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned to the sender' });
    expect(home.events?.[0]).toMatchObject({ description: 'Returned to the sender', stage: 'returned', provider_leg: 'return' });
    // Without a return, the same scans are the delivery to the recipient.
    const out = parseUSPSTrackingHtml(page('In Transit', 'Arrived at USPS Facility').replace(scan('Refused', 'March 12, 2025 12:40 PM'), '')
      .replace(scan('Return to Sender Processed', 'March 12, 2025 12:13 PM'), ''), DELIVERED_NUMBER);
    expect(out).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(out.events?.some(event => event.provider_leg)).toBe(false);
  });

  it('keeps an unresolved newest scan as local time and rejects another parcel’s timeline', () => {
    const result = parseUSPSTrackingHtml(TIMELINE_PAGE.replaceAll('EXAMPLE CITY, NY 00000', ''), DELIVERED_NUMBER);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2025-03-14T12:17:00' });
    expect(result.events?.[0]!.time).toBeUndefined();
    expect(() => parseUSPSTrackingHtml(TIMELINE_PAGE, IN_TRANSIT_NUMBER)).toThrow('requested parcel');
  });

  it('reads the state a facility names before its kind', () => {
    for (const [facility, time] of [['EXAMPLE NY DISTRIBUTION CENTER', '2025-03-14T12:17:00-04:00'],
      ['EXAMPLE CITY CA NETWORK DISTRIBUTION CENTER', '2025-03-14T12:17:00-07:00'], ['ISC EXAMPLE CITY IL (USPS)', '2025-03-14T12:17:00-05:00'],
      ['EXAMPLE CITY PA PACKAGE SORTING CENTER', '2025-03-14T12:17:00-04:00'], ['EXAMPLE CITY LA PROCESSING CENTER', '2025-03-14T12:17:00-05:00']] as const) {
      const result = parseUSPSTrackingHtml(TIMELINE_PAGE.replace('EXAMPLE CITY, NY 00000', facility), DELIVERED_NUMBER);
      expect(result.events?.[0], facility).toMatchObject({ location: facility, time });
    }
    const unnamed = parseUSPSTrackingHtml(TIMELINE_PAGE.replace('EXAMPLE CITY, NY 00000', 'EXAMPLE DISTRIBUTION CENTER'), DELIVERED_NUMBER);
    expect(unnamed.events?.[0]).toMatchObject({ local_time: '2025-03-14T12:17:00' });
  });

  it('reads a town of Florida\'s Panhandle on Central time, and the rest of the state on Eastern', () => {
    for (const [place, time] of [['PENSACOLA, FL 32501', '2025-03-14T12:17:00-05:00'], ['PENSACOLA FL DISTRIBUTION CENTER', '2025-03-14T12:17:00-05:00'],
      ['PENSACOLA FL PROCESSING CENTER', '2025-03-14T12:17:00-05:00'],
      ['ORLANDO, FL 32801', '2025-03-14T12:17:00-04:00'], ['EXAMPLE CITY, FL 32000', '2025-03-14T12:17:00-04:00']] as const) {
      const result = parseUSPSTrackingHtml(TIMELINE_PAGE.replace('EXAMPLE CITY, NY 00000', place), DELIVERED_NUMBER);
      expect(result.events?.[0], place).toMatchObject({ location: place, time });
    }
  });

  it('reads a place that gives only its ZIP code in the state of that ZIP code', () => {
    for (const [place, time] of [['EXAMPLE CITY 94000', '2025-03-14T12:17:00-07:00'], ['60000', '2025-03-14T12:17:00-05:00'],
      ['EXAMPLE CITY 10000-0000', '2025-03-14T12:17:00-04:00']] as const) {
      const result = parseUSPSTrackingHtml(TIMELINE_PAGE.replace('EXAMPLE CITY, NY 00000', place), DELIVERED_NUMBER);
      expect(result.events?.[0], place).toMatchObject({ location: place, time });
    }
    // A military or unassigned prefix, or a place with other digits, gives no state.
    for (const place of ['EXAMPLE 09000', 'EXAMPLE CITY 00000', 'EXAMPLE 1 60000']) {
      const result = parseUSPSTrackingHtml(TIMELINE_PAGE.replace('EXAMPLE CITY, NY 00000', place), DELIVERED_NUMBER);
      expect(result.events?.[0], place).toMatchObject({ local_time: '2025-03-14T12:17:00' });
    }
  });

  it('reads a scan abroad on the clock of the country it names, not on a US town of the same name', () => {
    for (const [place, time, zone] of [
      ['UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND', '2025-03-14T12:17:00+00:00', 'Europe/London'],
      ['LANGLEY HWDC, UNITED KINGDOM OF GREAT BRITAIN AND NORTHERN IRELAND', '2025-03-14T12:17:00+00:00', 'Europe/London'],
      ['NETHERLANDS', '2025-03-14T12:17:00+01:00', 'Europe/Amsterdam']] as const) {
      const result = parseUSPSTrackingHtml(TIMELINE_PAGE.replace('EXAMPLE CITY, NY 00000', place), DELIVERED_NUMBER);
      expect(result.events?.[0], place).toMatchObject({ location: place, local_time: '2025-03-14T12:17:00' });
      expect(dateLocalClocks('usps', result).events?.[0], place).toMatchObject({ time, time_zone: zone, time_zone_basis: 'place' });
    }
  });

  it('keeps the day of a date-only update without inventing a clock time', () => {
    const result = parseUSPSTrackingHtml(TIMELINE_PAGE.replace('March 14, 2025 12:17 PM', 'March 14, 2025'), DELIVERED_NUMBER);
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', local_time: '2025-03-14' });
    expect(result.events?.[0]!.time).toBeUndefined();
    expect(result.events?.[0]!.raw_time).toBeUndefined();
    expect(result).toMatchObject({ last_update: null, last_update_local: '2025-03-14' });
    // Local-clock dating gives a day no instant.
    expect(dateLocalClocks('usps', result).events?.[0]).toEqual(result.events?.[0]);
    // Pre-shipment info comes dated by its day alone, without a place.
    const announced = parseUSPSTrackingHtml(TIMELINE_PAGE.replace('March 14, 2025 12:17 PM', 'March 14, 2025')
      .replace(/(<p class="tb-status-detail">)[^<]*/, '$1Pre-Shipment Info Sent to USPS, USPS Awaiting Item')
      .replace(/(<p class="tb-location">)[^<]*/, '$1'), DELIVERED_NUMBER);
    expect(announced.events?.[0]).toEqual({ description: 'Pre-Shipment Info Sent to USPS, USPS Awaiting Item', stage: 'registered',
      local_time: '2025-03-14' });
    // A date that is no day keeps its text.
    expect(parseUSPSTrackingHtml(TIMELINE_PAGE.replace('March 14, 2025 12:17 PM', 'February 30, 2025'), DELIVERED_NUMBER).events?.[0])
      .toMatchObject({ raw_time: 'February 30, 2025' });
  });

  it('reads a clock time with seconds on the state\'s zone', () => {
    const result = parseUSPSTrackingHtml(TIMELINE_PAGE.replace('March 14, 2025 12:17 PM', 'March 14, 2025 12:17:35 pm'), DELIVERED_NUMBER);
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', time: '2025-03-14T12:17:35-04:00' });
    expect(result.last_update).toBe('2025-03-14T12:17:35-04:00');
  });

  it('projects the delivered history with state-zone timestamps', () => {
    const result = parseUSPSTrackingHtml(DELIVERED_PAGE, DELIVERED_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2025-03-14T08:00:00-04:00',
      expected_delivery: null,
    });
    expect(result.events).toEqual([
      { time: '2025-03-14T08:00:00-04:00', location: 'WASHINGTON, DC 20212', description: 'Delivered', stage: 'delivered' },
      { time: '2025-03-14T07:00:00-04:00', location: 'WASHINGTON, DC 20212', description: 'Out for Delivery', stage: 'out_for_delivery' },
      { time: '2025-03-13T18:15:00-04:00', location: 'WASHINGTON, DC 20212', description: 'Arrived at Post Office', stage: 'in_transit' },
      { time: '2025-03-12T09:30:00-04:00', location: 'LAUREL, MD 20707', description: 'Accepted at USPS Origin Facility', stage: 'accepted' },
    ]);
  });

  it('projects an in-transit parcel with its estimate', () => {
    const result = parseUSPSTrackingHtml(IN_TRANSIT_PAGE, IN_TRANSIT_NUMBER);
    expect(result).toMatchObject({
      status: 'in_transit',
      current_stage: 'in_transit',
      last_status_text: 'In Transit to Next Facility. Expected Delivery by Monday, March 17, 2025',
      last_update: '2025-03-15T23:20:00-05:00',
      expected_delivery: '2025-03-17',
    });
    expect(result.events).toHaveLength(3);
  });

  it('names the newest scan, not the origin post’s undated notice, as the status of incoming mail', () => {
    const step = (detail: string, date = '') => `<div class="tb-step"><p class="tb-status-detail">${detail}</p>`
      + `<p class="tb-location">NETHERLANDS</p><p class="tb-date">${date}</p></div>`;
    const page = (...steps: string[]) => '<html><head><title>USPS Tracking</title></head><body><div class="track-bar-container">'
      + '<span id="trackingNum">CW000000005NL</span><div class="latest-update-banner-wrapper"><div class="banner-header">Moving Through Network</div></div>'
      + '<div class="current-tracking-status-wrapper"><div class="tb-step current-step"><p class="tb-status">Moving Through Network</p>'
      + `<p class="tb-status-detail">Origin Post is Preparing Shipment</p></div>${steps.join('')}</div></div></body></html>`;
    const result = parseUSPSTrackingHtml(page(step('Processed Through Facility', 'October 21, 2026, 10:12 am'),
      step('Acceptance', 'October 19, 2026, 6:07 pm')), 'CW000000005NL');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Processed Through Facility' });
    expect(result.events?.map(({ description }) => description)).toEqual(['Processed Through Facility', 'Acceptance']);
    // Before USPS dates a scan, the notice is the item's data from the origin post.
    expect(parseUSPSTrackingHtml(page(), 'CW000000005NL')).toMatchObject({ last_status_text: 'Origin Post is Preparing Shipment', current_stage: 'registered' });
  });

  it('takes no scan’s date for the estimate when the current step has no detail', () => {
    const page = '<html><head><title>USPS Tracking</title></head><body><div class="track-bar-container">'
      + '<span id="trackingNum">CW000000005NL</span><div class="latest-update-banner-wrapper"><div class="banner-header">Moving Through Network</div></div>'
      + '<div class="current-tracking-status-wrapper"><div class="tb-step current-step"><p class="tb-location">NETHERLANDS</p></div>'
      + '<div class="tb-step"><p class="tb-status-detail">Expected Delivery Date Updated</p><p class="tb-location">NETHERLANDS</p>'
      + '<p class="tb-date">October 21, 2026, 10:12 am</p></div></div></div></body></html>';
    expect(parseUSPSTrackingHtml(page, 'CW000000005NL').expected_delivery).toBeNull();
  });

  it('reads a label its mailer wrote on UTC, which its facility’s zone would date after the read', () => {
    const step = (detail: string) => '<div class="tb-step current-step"><p class="tb-status">Label Created</p>'
      + `<p class="tb-status-detail">${detail}</p><p class="tb-location">EXAMPLE CITY, CA 00000</p><p class="tb-date">November 3, 2026, 4:40 am</p></div>`;
    const page = (detail: string) => '<html><head><title>USPS Tracking</title></head><body><div class="track-bar-container">'
      + `<span id="trackingNum">${IN_TRANSIT_NUMBER}</span><div class="latest-update-banner-wrapper"><div class="banner-header">Label Created, not yet in system</div></div>`
      + `<div class="current-tracking-status-wrapper">${step(detail)}</div></div></body></html>`;
    const read = (detail: string, at: string) => parseUSPSTrackingHtml(page(detail), IN_TRANSIT_NUMBER, Date.parse(at));
    expect(read('Shipping Label Created, USPS Awaiting Item', '2026-11-03T05:00:00Z'))
      .toMatchObject({ current_stage: 'registered', last_update: '2026-11-03T04:40:00Z' });
    // Once the facility's zone no longer dates it ahead, nothing tells the two apart: it keeps that zone.
    expect(read('Shipping Label Created, USPS Awaiting Item', '2026-11-03T13:00:00Z').last_update).toBe('2026-11-03T04:40:00-08:00');
    // A mailer's own label, worded alone with its place apart, is on UTC however late it is read.
    expect(read('Shipping Label Created', '2026-11-03T13:00:00Z').last_update).toBe('2026-11-03T04:40:00Z');
    // Another row the facility's zone dates ahead stays on it, a planned scan the due filter holds back.
    expect(read('Arrived at USPS Regional Facility', '2026-11-03T05:00:00Z').last_update).toBe('2026-11-03T04:40:00-08:00');
  });

  it('reads the estimate banner, whose date parts sit apart, and not its tooltips as the verdict', () => {
    const result = parseUSPSTrackingHtml(ESTIMATE_PAGE, IN_TRANSIT_NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In Transit, Arriving On Time',
      expected_delivery: '2025-03-17' });
    expect(result.events).toHaveLength(3);
    // A banner without an estimate gives none, and a delivered parcel keeps none.
    expect(parseUSPSTrackingHtml(ESTIMATE_PAGE.replace(/<div class="expected_delivery">[\s\S]*?<\/h2>\s*<\/div>/, ''), IN_TRANSIT_NUMBER).expected_delivery).toBeNull();
    const delivered = ESTIMATE_PAGE.replace('<p class="tb-status">On the Way</p>', '<p class="tb-status">Delivered</p>')
      .replace('In Transit, Arriving On Time', 'Delivered, In/At Mailbox');
    expect(parseUSPSTrackingHtml(delivered, IN_TRANSIT_NUMBER)).toMatchObject({ current_stage: 'delivered', expected_delivery: null });
    // An impossible date is no estimate.
    expect(parseUSPSTrackingHtml(ESTIMATE_PAGE.replace(/(<strong class="date"><span class="eta_snip">\s*)17/, '$131')
      .replace(/(<span>\s*)March(\s*<\/span>)/, '$1February$2'), IN_TRANSIT_NUMBER).expected_delivery).toBeNull();
  });

  it('reads a banner written without spaces between its date parts, and its window', () => {
    const banner = (parts: string) => ESTIMATE_PAGE.replace(/<div class="expected_delivery">[\s\S]*?<\/h2>\s*<\/div>/,
      `<div class="expected_delivery"><h3>Expected Delivery by</h3><h2><em class="day">Monday</em><strong class="date">17</strong>${parts}</h2></div>`);
    expect(parseUSPSTrackingHtml(banner('<span class="month_year"><span>March</span><br>2025</span>'), IN_TRANSIT_NUMBER).expected_delivery)
      .toBe('2025-03-17');
    expect(parseUSPSTrackingHtml(banner('<span class="month_year"><span>March</span><br>2025</span><span>between<br>10:15am and 2:15pm</span>'),
      IN_TRANSIT_NUMBER).expected_delivery).toBe('2025-03-17 10:15–14:15');
  });

  it('reads the delivery window the out-for-delivery scan gives, on that scan\'s day', () => {
    const out = (detail: string, page = ESTIMATE_PAGE) => page.replace('<p class="tb-status">On the Way</p>', '<p class="tb-status">Out for Delivery</p>')
      .replace('<p class="tb-status-detail">In Transit, Arriving On Time</p>', `<p class="tb-status-detail">${detail}</p>`)
      .replace('<p class="tb-location"></p>', '<p class="tb-location">EXAMPLE CITY, CA 00000</p>')
      .replace('March 15, 2025 4:31 PM', 'March 17, 2025 6:10 AM');
    const withoutBanner = ESTIMATE_PAGE.replace(/<div class="expected_delivery">[\s\S]*?<\/h2>\s*<\/div>/, '');
    const window = 'Out for Delivery, Expected Delivery Between 1:15pm and 4:15pm';
    expect(parseUSPSTrackingHtml(out(window, withoutBanner), IN_TRANSIT_NUMBER))
      .toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: '2025-03-17 13:15–16:15' });
    // The banner's day without a window takes the round's window; a banner naming another day stands.
    expect(parseUSPSTrackingHtml(out(window), IN_TRANSIT_NUMBER).expected_delivery).toBe('2025-03-17 13:15–16:15');
    expect(parseUSPSTrackingHtml(out(window).replace(/(<strong class="date"><span class="eta_snip">\s*)17/, '$118'), IN_TRANSIT_NUMBER)
      .expected_delivery).toBe('2025-03-18');
    expect(parseUSPSTrackingHtml(out('Out for Delivery, Expected Delivery by 9:00pm', withoutBanner), IN_TRANSIT_NUMBER).expected_delivery)
      .toBe('2025-03-17');
    // A round that announces nothing gives no estimate.
    expect(parseUSPSTrackingHtml(out('Out for Delivery', withoutBanner), IN_TRANSIT_NUMBER).expected_delivery).toBeNull();
  });

  it('keeps the signatory out of the result', () => {
    const serialized = JSON.stringify(parseUSPSTrackingHtml(DELIVERED_PAGE, DELIVERED_NUMBER));
    expect(serialized).not.toContain('PRIVATE RECIPIENT');
  });

  it('produces every capability carrier.json declares', () => {
    expect(CAPABILITIES).toEqual(['history', 'location', 'eta']);
    const result = parseUSPSTrackingHtml(DELIVERED_PAGE, DELIVERED_NUMBER);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(parseUSPSTrackingHtml(IN_TRANSIT_PAGE, IN_TRANSIT_NUMBER).expected_delivery).toBeTruthy();
  });

  it('reports an unavailable number as unlocated and verifies the requested number', () => {
    const unavailable = DELIVERED_PAGE.replace(
      '<div class="banner-header">Delivered</div>',
      '<div class="banner-header">Tracking Not Available</div>');
    expect(parseUSPSTrackingHtml(unavailable, DELIVERED_NUMBER)).toMatchObject({
      status: 'unknown',
      events: [],
      last_status_text: 'USPS could not locate the shipment',
    });
    expect(() => parseUSPSTrackingHtml(DELIVERED_PAGE, IN_TRANSIT_NUMBER))
      .toThrow('USPS did not return the requested parcel');
    expect(() => parseUSPSTrackingHtml('<html><body>challenge shell</body></html>', DELIVERED_NUMBER))
      .toThrow('USPS challenged the browser tracking session');
  });
});

describe('USPS lookup steps', () => {
  function trawlReply(html: string, number = DELIVERED_NUMBER, capturedResponses: unknown[] = []) {
    return Response.json({
      tier: 3,
      statusCode: 200,
      url: uspsTrackingUrl(number),
      html,
      cookies: [],
      userAgent: 'Mozilla/5.0 (test browser)',
      capturedResponses,
    });
  }

  it('reports the missing browser service without any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch'));
    await expect(new USPSTracker({ trawl: null }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({
        name: 'ChallengeError',
        message: 'USPS challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('leaves the browser 45 seconds by default, so a lookup ends within a minute', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(DELIVERED_NUMBER)).rejects.toThrow();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ maxTimeout: 45_000 });
  });

  it('reads the page the browser rendered', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(trawlReply(DELIVERED_PAGE));
    const { recorder, records } = stepRecorder();

    const result = await new USPSTracker({ timeoutMs: 2_000, trawl: new TrawlClient(TRAWL_URL), recorder }).fetch(DELIVERED_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      tracking_source: 'rendered-page',
      tracking_url: uspsTrackingUrl(DELIVERED_NUMBER),
    });
    expect(result.events?.length ?? 0).toBeGreaterThan(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: `https://tools.usps.com/tracking/${DELIVERED_NUMBER}`,
      skipHttp: true,
      maxTier: 3,
      contentWaitForSelector: '#trackingNum',
    });
    expect(records).toEqual(['trawl:ok', 'lookup:trawl:ok']);
  });

  it('recovers one incomplete header-only page and retains the failed attempt', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(trawlReply(HEADER_ONLY_PAGE))
      .mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
    const step = vi.fn();
    const lookup = vi.fn();
    const result = await new USPSTracker({ trawl: new TrawlClient(TRAWL_URL), recorder: { step, lookup } }).fetch(DELIVERED_NUMBER);
    expect(result.events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenNthCalledWith(1, expect.objectContaining({ step: 'trawl', attempt: 1,
      outcome: 'challenge', error: expect.objectContaining({ reason: 'incomplete_page' }) }));
    expect(step).toHaveBeenNthCalledWith(2, expect.objectContaining({ step: 'trawl', attempt: 2,
      outcome: 'ok', fallbackFrom: 'trawl', fallbackReason: 'challenge',
      fallbackError: expect.objectContaining({ reason: 'incomplete_page' }) }));
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2, outcome: 'ok' }));
  });

  it('stops after two incomplete pages without claiming the shipment is missing', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => trawlReply(HEADER_ONLY_PAGE));
    await expect(new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ kind: 'challenge', reason: 'incomplete_page' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads once more after the tracking page head arrives without its body', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(trawlReply(HEAD_ONLY_PAGE))
      .mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
    expect((await new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(DELIVERED_NUMBER)).events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(() => parseUSPSTrackingHtml(HEAD_ONLY_PAGE.replace('</head>', '</head><body><p>Access denied</p></body>'), DELIVERED_NUMBER))
      .toThrowError(expect.objectContaining({ kind: 'challenge', reason: undefined }));
  });

  it('reads up to twice more after the verification interstitial and stops after a third one', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE))
      .mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
    const step = vi.fn();
    const result = await new USPSTracker({ trawl: new TrawlClient(TRAWL_URL), recorder: { step, lookup: vi.fn() } }).fetch(DELIVERED_NUMBER);
    expect(result.events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenNthCalledWith(2, expect.objectContaining({ step: 'trawl', outcome: 'ok',
      fallbackError: expect.objectContaining({ reason: 'interstitial_page' }) }));
    fetcher.mockReset().mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE)).mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE))
      .mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
    expect((await new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(DELIVERED_NUMBER)).events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockReset().mockImplementation(async () => trawlReply(INTERSTITIAL_PAGE));
    await expect(new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ kind: 'challenge', reason: 'interstitial_page' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps a titled or worded page without the tracker an unrepeated challenge', () => {
    for (const page of [INTERSTITIAL_PAGE.replace('<title></title>', '<title>Access</title>'),
      INTERSTITIAL_PAGE.replace('</script>', '</script><p>Please wait</p>'), INTERSTITIAL_PAGE.replace(/<script>.*<\/script>/, '')]) {
      expect(() => parseUSPSTrackingHtml(page, DELIVERED_NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge', reason: undefined }));
    }
  });

  const outageReply = {
    url: uspsTrackingUrl(DELIVERED_NUMBER), status: 302, trackingNumberSubmitted: DELIVERED_NUMBER,
    headers: { location: 'https://www.usps.com/root/global/server_responses/anyapp_outage_apology.htm' },
    body: null, error: null, truncated: false, base64Encoded: false,
  };

  it('reads up to three times after bound outage redirects and ends as unavailability, not a missing parcel', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      trawlReply(INTERSTITIAL_PAGE, DELIVERED_NUMBER, [outageReply]));
    const { recorder, records } = stepRecorder();
    await expect(new USPSTracker({ trawl: ownTrawl(), recorder }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'maintenance_page' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(records).toEqual(['trawl:indeterminate', 'trawl:indeterminate', 'trawl:indeterminate', 'lookup:trawl:indeterminate']);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      captureResponses: [uspsTrackingUrl(DELIVERED_NUMBER)],
    });
  });

  it('reads on after an outage redirect until the history loads', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE, DELIVERED_NUMBER, [outageReply]))
      .mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE))
      .mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
    const step = vi.fn();
    const result = await new USPSTracker({ trawl: ownTrawl(), recorder: { step, lookup: vi.fn() } }).fetch(DELIVERED_NUMBER);
    expect(result.events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(step).toHaveBeenNthCalledWith(2, expect.objectContaining({ step: 'trawl', outcome: 'challenge',
      fallbackError: expect.objectContaining({ reason: 'maintenance_page' }) }));
  });

  it('pauses a browser service\'s reads after three redirects in a row, until a read after the pause loads', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      trawlReply(INTERSTITIAL_PAGE, DELIVERED_NUMBER, [outageReply]));
    const { recorder, records } = stepRecorder();
    const tracker = new USPSTracker({ trawl: ownTrawl(), recorder });
    const redirected = { kind: 'indeterminate', reason: 'maintenance_page', retryAfterMs: undefined };
    // Two redirects, then a third read that loads: the run starts again.
    fetcher.mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE, DELIVERED_NUMBER, [outageReply]))
      .mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE, DELIVERED_NUMBER, [outageReply]))
      .mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
    expect((await tracker.fetch(DELIVERED_NUMBER)).events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(3);
    // The third redirect in a row ends its lookup, and the next lookup reads nothing:
    // it ends as the adapter's own pacing with the wait, not as a failure of USPS.
    await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject(redirected);
    expect(fetcher).toHaveBeenCalledTimes(6);
    records.length = 0;
    await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', reason: 'self_paced',
      retryAfterMs: expect.any(Number) });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(records).toEqual(['trawl:rate_limited', 'lookup:trawl:rate_limited']);
    // Another browser service is not paused.
    await expect(new USPSTracker({ trawl: ownTrawl() }).fetch(DELIVERED_NUMBER)).rejects.toMatchObject(redirected);
    expect(fetcher).toHaveBeenCalledTimes(9);
    // After the pause one read is made, and a redirect pauses reads again at once.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000 + 1);
    await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject(redirected);
    expect(fetcher).toHaveBeenCalledTimes(10);
    await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 5 * 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  describe('fallback proxy', () => {
    const PROXY = 'http://relay.internal:3128';
    function routeRecorder(): { recorder: StepRecorder; records: string[] } {
      const records: string[] = [];
      return {
        records,
        recorder: {
          step: (record) => records.push(`${record.step}:${record.outcome}:${record.networkRoute ?? 'none'}`),
          lookup: (record) => records.push(`lookup:${record.outcome}`),
        },
      };
    }
    const proxies = (fetcher: { mock: { calls: unknown[][] } }) => fetcher.mock.calls
      .map(call => (JSON.parse(String((call[1] as RequestInit).body)) as { proxy?: string }).proxy ?? 'own');
    const redirected = () => trawlReply(INTERSTITIAL_PAGE, DELIVERED_NUMBER, [outageReply]);

    it('reads through the proxy only while the service\'s own route is paused, and records each read\'s route', async () => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => redirected());
      const { recorder, records } = routeRecorder();
      const step = vi.fn<StepRecorder['step']>(record => recorder.step(record));
      const tracker = new USPSTracker({ trawl: ownTrawl(), fallbackProxy: ` ${PROXY} `, recorder: { ...recorder, step } });
      // Redirects on the service's own route are read there until the third in a row pauses it.
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'maintenance_page' });
      expect(records).toEqual(['trawl:indeterminate:default', 'trawl:indeterminate:default',
        'trawl:indeterminate:default', 'lookup:indeterminate']);
      // While the pause lasts, lookups read through the proxy from the start.
      records.length = 0;
      fetcher.mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
      expect((await tracker.fetch(DELIVERED_NUMBER)).events).toHaveLength(5);
      expect(records).toEqual(['trawl:ok:residential', 'lookup:ok']);
      expect(proxies(fetcher)).toEqual(['own', 'own', 'own', PROXY]);
      // After the pause the own route is asked first, and a redirect that pauses it again sends the same lookup
      // through the proxy.
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
      records.length = 0;
      fetcher.mockImplementationOnce(async () => redirected()).mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
      expect((await tracker.fetch(DELIVERED_NUMBER)).events).toHaveLength(5);
      expect(records).toEqual(['trawl:indeterminate:default', 'trawl:ok:residential', 'lookup:ok']);
      expect(step.mock.calls.slice(-2).map(([record]) => [record.networkAttempt, record.historyAvailable]))
        .toEqual([['initial', false], ['retry', true]]);
      // Once the own route loads a page, the spell is over and the proxy is left alone.
      vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000 + 2);
      fetcher.mockResolvedValueOnce(trawlReply(TIMELINE_PAGE)).mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
      expect((await tracker.fetch(DELIVERED_NUMBER)).events).toHaveLength(5);
      expect((await tracker.fetch(DELIVERED_NUMBER)).events).toHaveLength(5);
      expect(proxies(fetcher).slice(4)).toEqual(['own', PROXY, 'own', 'own']);
    });

    it('reads once through the proxy when the own route\'s second redirect in a lookup pauses it', async () => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => redirected());
      const { recorder, records } = routeRecorder();
      const tracker = new USPSTracker({ trawl: ownTrawl(), fallbackProxy: PROXY, recorder });
      // A lookup that ends on the interstitial after a redirect leaves the run at one redirect.
      fetcher.mockImplementationOnce(async () => redirected())
        .mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE)).mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE));
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'challenge', reason: 'interstitial_page' });
      records.length = 0;
      fetcher.mockImplementationOnce(async () => redirected()).mockImplementationOnce(async () => redirected())
        .mockResolvedValueOnce(trawlReply(TIMELINE_PAGE));
      expect((await tracker.fetch(DELIVERED_NUMBER)).events).toHaveLength(5);
      expect(records).toEqual(['trawl:indeterminate:default', 'trawl:indeterminate:default', 'trawl:ok:residential',
        'lookup:ok']);
      expect(proxies(fetcher)).toEqual(['own', 'own', 'own', 'own', 'own', PROXY]);
    });

    it('reads a proxy redirect no further, and pauses the proxy after three in a row', async () => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => redirected());
      const { recorder, records } = routeRecorder();
      const tracker = new USPSTracker({ trawl: ownTrawl(), fallbackProxy: PROXY, recorder });
      // A lookup pauses the own route, and the next one's only read is the proxy's first redirect.
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ reason: 'maintenance_page' });
      records.length = 0;
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ reason: 'maintenance_page', retryAfterMs: undefined });
      expect(records).toEqual(['trawl:indeterminate:residential', 'lookup:indeterminate']);
      expect(proxies(fetcher)).toEqual(['own', 'own', 'own', PROXY]);
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ reason: 'maintenance_page' });
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ reason: 'maintenance_page' });
      expect(fetcher).toHaveBeenCalledTimes(6);
      // Both routes are paused: no read, and the wait is the shorter of the two.
      records.length = 0;
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', reason: 'self_paced',
        retryAfterMs: expect.any(Number) });
      expect(fetcher).toHaveBeenCalledTimes(6);
      expect(records).toEqual(['trawl:rate_limited:none', 'lookup:rate_limited']);
    });

    it('keeps the proxy\'s challenges to the existing retries', async () => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => redirected());
      const tracker = new USPSTracker({ trawl: ownTrawl(), fallbackProxy: PROXY });
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ reason: 'maintenance_page' });
      fetcher.mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE)).mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE))
        .mockResolvedValueOnce(trawlReply(INTERSTITIAL_PAGE));
      await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'challenge', reason: 'interstitial_page' });
      expect(proxies(fetcher)).toEqual(['own', 'own', 'own', PROXY, PROXY, PROXY]);
    });

    it('takes the proxy from USPS_FALLBACK_PROXY_URL and refuses one that is not an HTTP(S) origin', async () => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => redirected());
      const trawl = ownTrawl();
      const usps = adapter({ trawl, recorder: NOOP_RECORDER, browserExecutablePath: null,
        env: { USPS_FALLBACK_PROXY_URL: PROXY } });
      for (let lookup = 0; lookup < 2; lookup++) {
        await expect(usps.track({ number: DELIVERED_NUMBER }, {})).rejects.toMatchObject({ reason: 'maintenance_page' });
      }
      expect(proxies(fetcher)).toEqual(['own', 'own', 'own', PROXY]);
      expect(() => new USPSTracker({ fallbackProxy: 'relay.internal:3128' })).toThrow(TypeError);
      expect(() => new USPSTracker({ fallbackProxy: `${PROXY}/path` })).toThrow(TypeError);
      expect(() => new USPSTracker({ fallbackProxy: '  ' })).not.toThrow();
    });
  });

  it.each([
    { url: uspsTrackingUrl(IN_TRANSIT_NUMBER) }, { trackingNumberSubmitted: IN_TRANSIT_NUMBER },
    { trackingNumberSubmitted: undefined }, { status: 200 }, { headers: { location: 'https://example.com/outage' } },
    { truncated: true }, { error: 'capture failed' }, { base64Encoded: true },
  ])('does not infer an outage from unrelated or incomplete evidence: %j', async changed => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      trawlReply(INTERSTITIAL_PAGE, DELIVERED_NUMBER, [{ ...outageReply, ...changed }]));
    await expect(new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ kind: 'challenge', reason: 'interstitial_page' });
  });

  it('keeps matching full history despite an earlier outage and still rejects a wrong identity', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(trawlReply(TIMELINE_PAGE, DELIVERED_NUMBER, [outageReply]));
    const tracker = new USPSTracker({ trawl: ownTrawl() });
    expect((await tracker.fetch(DELIVERED_NUMBER)).events).toHaveLength(5);
    fetcher.mockResolvedValueOnce(trawlReply(TIMELINE_PAGE.replaceAll(DELIVERED_NUMBER, IN_TRANSIT_NUMBER),
      DELIVERED_NUMBER, [outageReply]));
    await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('does not repeat a challenge shell, wrong identity or rate limit', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(trawlReply('<html>Browser challenge</html>'));
    const tracker = new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) });
    await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear().mockResolvedValue(trawlReply(IN_TRANSIT_PAGE));
    await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear().mockImplementation(async () => new Response('Rate limited', { status: 429 }));
    await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops recovery when the caller cancels', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      controller.abort(reason);
      return trawlReply(HEADER_ONLY_PAGE);
    });
    await expect(new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(DELIVERED_NUMBER, { signal: controller.signal }))
      .rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retrieves incoming international mail under its original number and verifies the response identity', async () => {
    const number = 'LZ123456785CN';
    const html = DELIVERED_PAGE.replaceAll(DELIVERED_NUMBER, number);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(trawlReply(html, number));
    const result = await new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(number);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).url).toBe(uspsTrackingUrl(number));
    expect(result).toMatchObject({ status: 'delivered', tracking_url: uspsTrackingUrl(number) });
    expect(result.events).toHaveLength(4);

    // A response for another country's identifier is not a verified handoff.
    fetcher.mockResolvedValueOnce(trawlReply(html.replaceAll(number, 'LZ123456785US'), number));
    await expect(new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch(number))
      .rejects.toThrow('USPS did not return the requested parcel');
  });

  it('reports the package identifier of a typed routing barcode as the canonical number', async () => {
    // An invented package identifier behind the routing prefix and a made-up ZIP code.
    const pic = '9210090000000012345679';
    const html = DELIVERED_PAGE.replaceAll(DELIVERED_NUMBER, pic);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => trawlReply(html, pic));
    const tracker = new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) });
    const result = await tracker.fetch(`420 00000 ${pic}`);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).url).toBe(uspsTrackingUrl(pic));
    expect(result).toMatchObject({ status: 'delivered', canonical_tracking_number: pic, tracking_url: uspsTrackingUrl(pic) });
    expect(JSON.stringify(result)).not.toContain('42000000');
    // The package identifier typed on its own, spaced as printed, is already the canonical number.
    expect(await tracker.fetch('9210 0900 0000 0012 3456 79')).not.toHaveProperty('canonical_tracking_number');
  });

  it('rejects a number that is not a USPS number before any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch'));
    const lookup = new USPSTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch('1Z999AA10123456784');
    await expect(lookup).rejects.toThrow('USPS tracking numbers must contain 20 or 22 digits');
    await expect(lookup).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('builds the canonical tracking URL', () => {
    expect(uspsTrackingUrl(DELIVERED_NUMBER)).toBe(`https://tools.usps.com/tracking/${DELIVERED_NUMBER}`);
  });

  it.each([DELIVERED_NUMBER, '92000000000123456789012344', 'LZ123456785CN'])(
    'recognizes current and legacy links for the whole identifier %s', (number) => {
      for (const url of [uspsTrackingUrl(number), `${uspsTrackingUrl(number)}/`,
        `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`]) {
        expect(parseTrackingInput(url)).toMatchObject({ trackingNumber: number, carrier: 'usps', confidence: 'high', source: 'link' });
      }
    },
  );

  it('does not claim a partial identifier in the tracking path', () => {
    expect(parseTrackingInput(`https://tools.usps.com/tracking/${DELIVERED_NUMBER}EXTRA`).carrier).not.toBe('usps');
  });
});
