import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrawlClient } from '../../core/transport/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import {
  parseRoyalMailTrackingHtml,
  parseRoyalMailTrackingResponse,
  RoyalMailTracker,
  adapter,
  royalMailEventsApiUrl,
  royalMailSummaryApiUrl,
  royalMailTrackingUrl,
} from './adapter.js';
import { fetchRoyalMailInBrowser } from './browser.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { royalMailScanStage, royalMailStage, royalMailStatus, statusMap } from './status.js';

vi.mock(import('./browser.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchRoyalMailInBrowser: vi.fn(actual.fetchRoyalMailInBrowser) };
});

// SG999999999GB and SG999999998GB are made-up numbers in Royal Mail's
// published S10 format. No real shipment, recipient or signatory appears in
// this file.
const DELIVERED_NUMBER = 'SG999999999GB';
const IN_TRANSIT_NUMBER = 'SG999999998GB';
const TRAWL_URL = 'http://trawl.internal:8191';
const DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const IN_TRANSIT = JSON.parse(
  readFileSync(new URL('./fixtures/in-transit.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
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

describe('Royal Mail status vocabulary', () => {
  it('maps the wording, and nothing else', () => {
    expect(royalMailStage('Delivered')).toBe('delivered');
    expect(royalMailStage('Out for delivery')).toBe('out_for_delivery');
    expect(royalMailStage('Delivery attempted')).toBe('failed_attempt');
    expect(royalMailStage('Sender preparing item')).toBe('registered');
    expect(royalMailStage('Your item will be delivered tomorrow')).toBeNull();
    expect(royalMailStage('Arrived at delivery office')).toBe('in_transit');
    expect(royalMailStage('Item has cleared customs')).toBe('in_transit');
    expect(royalMailStage('Item held by customs')).toBe('customs');
    expect(royalMailStage('Redirected')).toBe('in_transit');
    expect(royalMailStage('Ready for collection')).toBe('ready_for_pickup');
    expect(royalMailStatus('Delivered')).toBe('delivered');
    // Unknown wording does not establish movement.
    expect(royalMailStatus('Wording Royal Mail has not used before')).toBe('unknown');
    expect(royalMailStage('Wording Royal Mail has not used before')).toBeNull();
  });
});

describe('Royal Mail structured response', () => {
  it.each([
    ["We're expecting it", 'New provider description', 'pending', 'registered'],
    ["We've got it", 'New provider description', 'in_transit', 'accepted'],
    ['Released from Customs', 'Released from Customs', 'in_transit', 'in_transit'],
    ['Ready for Delivery', '', 'in_transit', 'in_transit'],
    ['Duplicate Identified', 'New provider description', 'exception', 'exception'],
    ['No Status', 'New provider description', 'unknown', undefined],
  ])('uses summary category %s independently of scan wording', (category, description, status, stage) => {
    const result = parseRoyalMailTrackingResponse({mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: {statusCategory: category, statusDescription: description},
    }}, DELIVERED_NUMBER);
    expect(result.status).toBe(status);
    expect(result.current_stage).toBe(stage);
  });

  it('distinguishes completed collection from an earlier carrier collection scan', () => {
    const result = parseRoyalMailTrackingResponse({mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: {statusCategory: 'Collected', statusDescription: 'Collected by PRIVATE RECIPIENT'},
      estimatedDelivery: {date: '2026-03-20'},
      events: [{eventName: 'Collected', eventDateTime: '2026-03-12T09:30:00Z'}],
    }}, DELIVERED_NUMBER);
    expect(result).toMatchObject({status: 'delivered', current_stage: 'delivered', last_status_text: 'Collected by PRIVATE RECIPIENT', expected_delivery: null});
    expect(result.events?.[0]?.stage).toBe('accepted');
    expect(result).not.toHaveProperty('signed_by');
  });

  it('projects the delivered summary with per-scan codes', () => {
    const result = parseRoyalMailTrackingResponse(structuredClone(DELIVERED), DELIVERED_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-03-14T08:00:00Z',
      expected_delivery: null,
      signed_by: 'PRIVATE RECIPIENT',
    });
    expect(result.events).toEqual([
      { time: '2026-03-14T08:00:00Z', location: 'LONDON', description: 'Delivered. Signed for by PRIVATE RECIPIENT', stage: 'delivered', provider_code: 'DL' },
      { time: '2026-03-14T07:00:00Z', location: 'LONDON', description: 'Out for delivery', stage: 'out_for_delivery', provider_code: 'OD' },
      { time: '2026-03-13T18:15:00Z', location: 'LONDON', description: 'Arrived at delivery office', stage: 'in_transit', provider_code: 'AR' },
      { time: '2026-03-12T09:30:00Z', location: 'SWINDON', description: 'Item received', stage: 'accepted', provider_code: 'AC' },
    ]);
  });

  it('projects an in-transit mailpiece with its estimate', () => {
    const result = parseRoyalMailTrackingResponse(structuredClone(IN_TRANSIT), IN_TRANSIT_NUMBER);
    expect(result).toMatchObject({
      status: 'in_transit',
      current_stage: 'in_transit',
      last_status_text: 'In transit',
      last_update: '2026-03-15T22:41:00Z',
      expected_delivery: '2026-03-20',
    });
    expect(result.events).toHaveLength(2);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps the window of an estimate on its day, and its day otherwise', () => {
    const estimate = (estimatedDelivery: unknown, statusCategory = 'In transit') => {
      const { expected_delivery, expected_delivery_from } = parseRoyalMailTrackingResponse({ mailPieces: {
        mailPieceId: IN_TRANSIT_NUMBER, summary: { statusCategory }, estimatedDelivery,
      } }, IN_TRANSIT_NUMBER);
      return { expected_delivery, expected_delivery_from };
    };
    expect(estimate({ date: '2026-06-20', startOfEstimatedWindow: '08:00:00+01:00', endOfEstimatedWindow: '11:00:00+01:00' }))
      .toEqual({ expected_delivery_from: '2026-06-20T08:00:00+01:00', expected_delivery: '2026-06-20T11:00:00+01:00' });
    expect(estimate({ date: '2026-06-20', startOfEstimatedWindow: '2026-06-20T08:00:00+01:00', endOfEstimatedWindow: '2026-06-20T11:00:00+01:00' }))
      .toEqual({ expected_delivery_from: '2026-06-20T08:00:00+01:00', expected_delivery: '2026-06-20T11:00:00+01:00' });
    for (const window of [
      { startOfEstimatedWindow: '11:00:00+01:00', endOfEstimatedWindow: '08:00:00+01:00' },
      { startOfEstimatedWindow: '08:00:00', endOfEstimatedWindow: '11:00:00' },
      { startOfEstimatedWindow: '2026-06-21T08:00:00+01:00', endOfEstimatedWindow: '2026-06-21T11:00:00+01:00' },
      { endOfEstimatedWindow: '11:00:00+01:00' },
    ]) expect(estimate({ date: '2026-06-20', ...window })).toEqual({ expected_delivery: '2026-06-20', expected_delivery_from: undefined });
    expect(estimate({ startOfEstimatedWindow: '08:00:00+01:00', endOfEstimatedWindow: '11:00:00+01:00' }))
      .toEqual({ expected_delivery: null, expected_delivery_from: undefined });
    expect(estimate({ date: '2026-06-20', startOfEstimatedWindow: '08:00:00+01:00', endOfEstimatedWindow: '11:00:00+01:00' }, 'Delivered'))
      .toEqual({ expected_delivery: null, expected_delivery_from: undefined });
  });

  it('reads who signed for a delivered item from the delivered line, or else from the summary', () => {
    expect(parseRoyalMailTrackingResponse(structuredClone(DELIVERED), DELIVERED_NUMBER).signed_by).toBe('PRIVATE RECIPIENT');
    const summary = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: { statusCategory: 'Delivered', statusDescription: 'Delivered. Signed for by SAMPLE SIGNER' },
      events: [{ eventCode: 'DL', eventName: 'Delivered', eventDateTime: '2026-03-14T08:00:00+00:00' }],
    } }, DELIVERED_NUMBER);
    expect(summary).toMatchObject({ last_status_text: 'Delivered. Signed for by SAMPLE SIGNER', signed_by: 'SAMPLE SIGNER' });
    // A line that names who signed before the item is delivered names no signer.
    const pending = structuredClone(DELIVERED) as { mailPieces: { summary: unknown; events: Array<Record<string, unknown>> } };
    pending.mailPieces.summary = { statusCategory: 'In transit', statusDescription: 'In transit' };
    pending.mailPieces.events = pending.mailPieces.events.slice(1);
    pending.mailPieces.events[0]!.eventName = 'Out for delivery. Signed for by SAMPLE SIGNER';
    expect(parseRoyalMailTrackingResponse(pending, DELIVERED_NUMBER)).not.toHaveProperty('signed_by');
  });

  it('uses full-history codes before repeated wording and removes Markdown from delivery prose', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: { statusCategory: 'Delivered', statusDescription: 'Delivered' },
      deliveryInfo: { recipientName: 'PRIVATE RECIPIENT', proofImage: 'PRIVATE PROOF' },
      events: [
        { eventCode: 'EVKOP', eventName: '**Delivered by** PRIVATE SIGNATORY', eventDateTime: '2026-01-03T09:56:31+00:00', locationName: 'Example office' },
        { eventCode: 'EVGPD', eventName: '**Due to be delivered today by**', eventDateTime: '2026-01-03T07:02:16+00:00' },
        { eventCode: 'EVIMC', eventName: '**Item Received**', eventDateTime: '2026-01-03T04:14:41+00:00' },
        { eventCode: 'EVIAV', eventName: '**Item Received**', eventDateTime: '2026-01-03T04:09:29+00:00' },
        { eventCode: 'EVDAC', eventName: '**Item Received**', eventDateTime: '2026-01-02T10:24:45+00:00' },
        { eventCode: 'EVDAV', eventName: '**Item Received**', eventDateTime: '2026-01-02T10:23:03+00:00' },
        { eventCode: 'EVAIP', eventName: 'Sender has despatched item', eventDateTime: '2026-01-01T18:37:05+00:00' },
      ],
    } }, DELIVERED_NUMBER);
    expect(result.events?.map(event => event.stage)).toEqual([
      'delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered',
    ]);
    expect(result.delivered_at).toBe('2026-01-03T09:56:31Z');
    expect(result.events?.every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events?.[0]?.description).toBe('Delivered by PRIVATE SIGNATORY');
    // "Delivered by" can name the office that delivered, so it names no signer; the reply's delivery info is not read.
    expect(result).not.toHaveProperty('signed_by');
    expect(JSON.stringify(result)).not.toContain('PRIVATE RECIPIENT');
    expect(JSON.stringify(result)).not.toContain('PRIVATE PROOF');
    expect(JSON.stringify(result)).not.toContain('**');
  });

  it("reads the delivery office's hand-over to a collection point as transit until the branch has the item", () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: { statusCategory: 'Ready for collection', statusDescription: 'Available for collection' },
      events: [
        { eventCode: 'EVPLA', eventName: 'Available for collection', eventDateTime: '2026-01-03T11:01:05+00:00', locationName: 'Example Post Office' },
        { eventCode: 'EVKLC', eventName: 'Delivered to your collection point', eventDateTime: '2026-01-03T10:56:35+00:00', locationName: 'Example DO' },
        { eventCode: 'EVKOP', eventName: '**Delivered by**', eventDateTime: '2026-01-03T10:04:24+00:00', locationName: 'Example DO' },
        { eventCode: 'EVGPD', eventName: '**Due to be delivered today by**', eventDateTime: '2026-01-03T10:02:56+00:00', locationName: 'Example DO' },
      ],
    } }, DELIVERED_NUMBER);
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['EVPLA', 'ready_for_pickup'], ['EVKLC', 'in_transit'], ['EVKOP', 'in_transit'], ['EVGPD', 'out_for_delivery'],
    ]);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads a missed delivery as kept for collection when the summary repeats the scan that says so', () => {
    const attempted = (lastEventCode: string) => parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'Delivery attempted', statusDescription: 'We tried to deliver your item', lastEventCode },
      events: [
        { eventCode: 'EVNAE', eventName: '**Available for Redelivery or Collection**', eventDateTime: '2026-01-14T09:21:00+00:00', locationName: 'Example DO' },
        { eventCode: 'EVKPD', eventName: '**Due to be delivered today**', eventDateTime: '2026-01-14T07:25:00+00:00', locationName: 'Example DO' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(attempted('EVNAE')).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    // A summary written for an older scan keeps its own stage.
    expect(attempted('EVKPD')).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
  });

  it('places a customs release and the redelivery after a missed delivery by their codes', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit' },
      events: [
        { eventCode: 'EVNCE', eventName: '**Collected From Your Customer Service Point**', eventDateTime: '2026-01-20T08:20:30+00:00', locationName: 'Example CSP' },
        { eventCode: 'EVNSC', eventName: '**Collected and Signed at Your Customer Service Point**', eventDateTime: '2026-01-20T08:20:00+00:00', locationName: 'Example CSP' },
        { eventCode: 'EVNDA', eventName: '**Available for Redelivery or Collection**', eventDateTime: '2026-01-14T05:10:00+00:00', locationName: 'Example CSP' },
        { eventCode: 'EVNAR', eventName: '**Due for Redelivery the Next Working Day**', eventDateTime: '2026-01-13T05:40:00+00:00', locationName: 'Example DO' },
        { eventCode: 'EVJIA', eventName: '**Released from Customs**', eventDateTime: '2026-01-10T20:15:00+00:00' },
      ],
    } }, IN_TRANSIT_NUMBER);
    // Leaving the Customer Service Point is neither an acceptance nor, by itself, the recipient's collection.
    expect(result.events?.map(event => [event.stage, event.stage_source])).toEqual([
      [undefined, undefined], [undefined, undefined],
      ['ready_for_pickup', 'carrier_map'], ['failed_attempt', 'carrier_map'], ['in_transit', 'carrier_map'],
    ]);
    expect(statusMap.gaps.map(gap => gap.code)).toEqual(['EVNSC', 'EVNCE', 'EVNRT', 'EVNLC', 'EVFNA', 'EVCNA']);
    expect(royalMailScanStage('EVCNA', "The parcel wasn't available when we called.")).toBeUndefined();
    // An item handed in at a Customer Service Point after a booked collection is not delivered.
    expect(royalMailScanStage('EVNLC', 'Delivered to Your Customer Service Point by Example')).toBeUndefined();
    expect(statusMap.stage('EVNCE', 'collected from your customer service point')).toBeUndefined();
    // The same words under EVNAE, minutes after the round, without a scan of the attempt.
    expect(royalMailScanStage('EVNAE', 'Available for Redelivery or Collection')).toBe('ready_for_pickup');
    expect(statusMap.stage('EVNAE', 'available for redelivery or collection')).toBe('ready_for_pickup');
    // A round that could not deliver to the address it was given, before the item waits for collection.
    expect(statusMap.stage('EVKAI', 'couldn\'t deliver your parcel due to incorrect address')).toBe('failed_attempt');
    // A post abroad returning the item under that code.
    expect(statusMap.stage('EVKAI', 'incorrectly addressed. returned to sender.')).toBe('returned');
  });

  it('reads a Customer Service Point’s collection as the delivery when the summary calls the item collected on it', () => {
    const events = [
      { eventCode: 'EVNSC', eventName: '**Collected and Signed at Your Customer Service Point**', eventDateTime: '2026-01-20T16:44:56+00:00', locationName: 'Example CSP' },
      { eventCode: 'EVKNA', eventName: '**Delivery Attempted - No Answer**', eventDateTime: '2026-01-20T10:37:34+00:00', locationName: 'Example DO' },
    ];
    const result = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER, events,
      summary: { statusCategory: 'Collected', statusDescription: 'Collected', lastEventCode: 'EVNSC', lastEventDateTime: '2026-01-20T16:44:56+00:00' } } }, IN_TRANSIT_NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-01-20T16:44:56Z' });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'failed_attempt']);
    expect(result.events?.[0]?.stage_source).toBe('carrier_map');
    // In transit, the same collection stays without a stage.
    const moving = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER, events,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', lastEventCode: 'EVNSC', lastEventDateTime: '2026-01-20T16:44:56+00:00' } } }, IN_TRANSIT_NUMBER);
    expect(moving.events?.[0]?.stage).toBeUndefined();
  });

  it('leaves the delivery office’s retention after a hold for a fee without a stage of its own', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit' },
      events: [
        { eventCode: 'EVNRT', eventName: '**Item Retention**', eventDateTime: '2026-01-20T07:12:40+00:00', locationName: 'Example DO' },
        { eventCode: 'EVNCF', eventName: '**Held as Customs fee to pay**', eventDateTime: '2026-01-20T07:12:00+00:00', locationName: 'Example DO' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => event.stage)).toEqual([undefined, 'customs']);
    expect(royalMailScanStage('EVNRT', 'Item Retention')).toBeUndefined();
  });

  it('reads a postbox posting and its proof as the acceptance', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit' },
      events: [
        { eventCode: 'EVHAC', eventName: '**Item Received by Royal Mail**', eventDateTime: '2026-01-20T18:10:00+00:00', locationName: 'Example MC' },
        { eventCode: 'EVTPC', eventName: '**Proof of posting validated**', eventDateTime: '2026-01-20T12:05:00+00:00' },
        { eventCode: 'PBIDO', eventName: '**Dropped off at Postbox**', eventDateTime: '2026-01-20T11:40:00+00:00' },
        { eventCode: 'EVAIP', eventName: '**Sender preparing item**', eventDateTime: '2026-01-19T09:00:00+00:00' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => [event.stage, event.stage_source])).toEqual([
      ['in_transit', 'carrier_map'], ['accepted', 'carrier_map'], ['accepted', 'carrier_map'], ['registered', 'carrier_map'],
    ]);
  });

  it('dates a delivery the delivery office records at its Customer Service Point', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: { statusCategory: 'Delivered', statusDescription: 'Delivered', lastEventCode: 'EVNFS', lastEventDateTime: '2026-01-20T06:43:15+00:00' },
      events: [
        { eventCode: 'EVNFS', eventName: '**Delivery Scan Recorded at Customer Service Point**', eventDateTime: '2026-01-20T06:43:15+00:00', locationName: 'Example DO' },
        { eventCode: 'EVIMC', eventName: '**Item Received**', eventDateTime: '2026-01-19T22:32:00+00:00', locationName: 'Example MC' },
      ],
    } }, DELIVERED_NUMBER);
    expect(result.events?.map(event => [event.stage, event.stage_source])).toEqual([
      ['delivered', 'carrier_map'], ['in_transit', 'carrier_map'],
    ]);
    expect(result.delivered_at).toBe('2026-01-20T06:43:15Z');
  });

  it('lists the summary’s newest scan when the history does not list it yet, in the history’s form', () => {
    const history = [
      { eventCode: 'EVGPD', eventName: '**Due to be delivered today**', eventDateTime: '2026-01-20T08:07:25+00:00', locationName: 'Example Depot' },
      { eventCode: 'EVIAV', eventName: '**Item Received**', eventDateTime: '2026-01-20T03:07:09+00:00', locationName: 'Example Hub' },
    ];
    const summary = { statusCategory: 'Delivered', statusDescription: 'Delivered', lastEventCode: 'EVKOP', lastEventName: '**Delivered**',
      lastEventDateTime: '2026-01-20T09:38:19+00:00', lastEventLocationName: 'Example Depot' };
    const parse = (events: unknown[]) => parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: DELIVERED_NUMBER, summary, events } }, DELIVERED_NUMBER);
    const lagging = parse(history);
    expect(lagging).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-01-20T09:38:19Z' });
    expect(lagging.events?.map(event => [event.provider_code, event.time, event.stage])).toEqual([
      ['EVKOP', '2026-01-20T09:38:19Z', 'delivered'], ['EVGPD', '2026-01-20T08:07:25Z', 'out_for_delivery'], ['EVIAV', '2026-01-20T03:07:09Z', 'in_transit'],
    ]);
    // Once the history lists it, the reply reads the same.
    const listed = parse([{ eventCode: 'EVKOP', eventName: '**Delivered**', eventDateTime: '2026-01-20T09:38:19+00:00', locationName: 'Example Depot' }, ...history]);
    expect(listed.events).toEqual(lagging.events);
    // A summary scan the history already passed adds nothing.
    expect(parse(history.slice(0, 1).map(event => ({ ...event, eventDateTime: '2026-01-20T09:40:00+00:00' }))).events).toHaveLength(1);
  });

  it('dates the recipient\'s collection from the Customer Service Point as the delivery', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: { statusCategory: 'Delivered', statusDescription: 'Delivered', lastEventCode: 'EVNOC', lastEventDateTime: '2026-01-20T09:21:57+00:00' },
      events: [
        { eventCode: 'EVNOC', eventName: '**Collected From Your Customer Service Point**', eventDateTime: '2026-01-20T09:21:57+00:00', locationName: 'Example CSP' },
        { eventCode: 'EVIAV', eventName: '**Item Received**', eventDateTime: '2026-01-17T20:14:46+00:00', locationName: 'Example MC' },
      ],
    } }, DELIVERED_NUMBER);
    expect(result.events?.map(event => [event.stage, event.stage_source])).toEqual([
      ['delivered', 'carrier_map'], ['in_transit', 'carrier_map'],
    ]);
    expect(result.delivered_at).toBe('2026-01-20T09:21:57Z');
  });

  it('reads the recipient\'s collection from the branch that kept the item as the delivery', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: { statusCategory: 'Delivered', statusDescription: 'Delivered', lastEventCode: 'EVPLC', lastEventDateTime: '2026-01-21T13:35:03+00:00' },
      events: [
        { eventCode: 'EVPLC', eventName: '**Collected**', eventDateTime: '2026-01-21T13:35:03+00:00', locationName: 'Example Post Office' },
        { eventCode: 'EVPLA', eventName: '**Available for collection**', eventDateTime: '2026-01-21T11:01:05+00:00', locationName: 'Example Post Office' },
        { eventCode: 'EVIAV', eventName: '**Item Received**', eventDateTime: '2026-01-20T04:43:12+00:00', locationName: 'Example MC' },
      ],
    } }, DELIVERED_NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-01-21T13:35:03Z' });
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['EVPLC', 'delivered'], ['EVPLA', 'ready_for_pickup'], ['EVIAV', 'in_transit'],
    ]);
  });

  it('places an international journey by its codes and names the destination', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: { statusCategory: 'Delivered', statusDescription: '**Delivered**', destinationCountryCode: 'US', destinationCountryName: 'Example' },
      events: [
        { eventCode: 'EVKOP', eventName: '**Delivered**', eventDateTime: '2026-01-09T15:24:00+01:00', locationName: 'Exampleville, United States of America' },
        { eventCode: 'EVKPD', eventName: '**Due to be delivered today**', eventDateTime: '2026-01-09T13:10:00+01:00', locationName: '99999' },
        { eventCode: 'EVGID', eventName: '**Arrived at Delivery Office**', eventDateTime: '2026-01-09T12:59:00+01:00', locationName: '99999-1234' },
        { eventCode: 'EVIIS', eventName: '**Item received at Sorting Office**', eventDateTime: '2026-01-08T16:28:00+01:00' },
        { eventCode: 'EVBAH', eventName: '**Item Received**', eventDateTime: '2026-01-06T10:00:00+01:00' },
        { eventCode: 'EVHOE', eventName: '**Item Leaving the UK**', eventDateTime: '2026-01-05T23:38:26+01:00' },
        { eventCode: 'EVHAC', eventName: '**Item Received by Royal Mail**', eventDateTime: '2026-01-05T22:54:18+01:00' },
        { eventCode: 'EVIPP', eventName: 'Received at Delivery Depot', eventDateTime: '2026-01-05T20:00:00+01:00' },
        { eventCode: 'EVPPA', eventName: '**Accepted at Parcelshop**', eventDateTime: '2026-01-04T16:48:51+01:00', locationName: 'Example Post Office [ZZ9 9ZZ]' },
        { eventCode: 'EVCAD', eventName: 'Item Collected', eventDateTime: '2026-01-04T11:36:41+01:00', locationName: 'Example DO [Main]' },
        { eventCode: 'ECCSB', eventName: 'Collection Request Succesfully booked for item', eventDateTime: '2026-01-03T14:35:45+01:00' },
      ],
    } }, DELIVERED_NUMBER);
    expect(result.events?.map(event => event.stage)).toEqual([
      'delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'accepted', 'registered',
    ]);
    // A delivery placed in the United States keeps its wall clock under Royal Mail's Eastern standard label.
    expect(result).toMatchObject({ status: 'delivered', destination_country: 'US' });
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-01-09T09:24:00' });
    expect(result.events?.[1]).toMatchObject({ time: '2026-01-09T13:10:00+01:00' });
    expect(result.events?.map(event => event.location)).toEqual([
      'Exampleville, United States of America', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'Example Post Office', 'Example DO [Main]', undefined,
    ]);
  });

  it('keeps scans of one instant in the carrier\'s order when it lists them oldest first', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER, summary: { statusDescription: 'In transit' },
      events: [
        { eventCode: 'AC', eventName: 'Item received', eventDateTime: '2026-03-12T09:30:00Z' },
        { eventCode: 'AR', eventName: 'Arrived at delivery office', eventDateTime: '2026-03-13T18:15:00Z' },
        { eventCode: 'OD', eventName: 'Out for delivery', eventDateTime: '2026-03-13T18:15:00Z' },
      ] } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => event.provider_code)).toEqual(['OD', 'AR', 'AC']);
  });

  it('reads a parcel hub receipt without an earlier acceptance as the acceptance', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'We\'ve got it', statusDescription: '**We\'ve got it**', lastEventCode: 'EVBAH',
        lastEventDateTime: '2026-01-06T03:04:21+01:00' },
      events: [
        { eventCode: 'EVBAH', eventName: '**Item Received**', eventDateTime: '2026-01-06T03:04:21+01:00' },
        { eventCode: 'EVBAH', eventName: '**Item Received**', eventDateTime: '2026-01-06T03:03:37+01:00' },
        { eventCode: 'EVAIP', eventName: 'Sender has despatched item', eventDateTime: '2026-01-05T16:20:10+01:00' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.current_stage).toBe('accepted');
    expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'accepted', 'registered']);
  });

  it('joins the place to a scan that ends where the page shows it', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit' },
      events: [
        { eventCode: 'EVGPD', eventName: '**Due to be delivered today by**', eventDateTime: '2026-01-07T07:44:13+00:00', locationName: 'Example DO' },
        { eventCode: 'EVORC', eventName: 'Arrived at', eventDateTime: '2026-01-07T02:29:00+00:00', locationName: 'Example MC' },
        { eventCode: 'EVOAC', eventName: 'Item received at', eventDateTime: '2026-01-06T15:28:00+00:00', locationName: 'Sample MC' },
        { eventCode: 'EVORC', eventName: 'Arrived at', eventDateTime: '2026-01-06T09:00:00+00:00' },
        { eventCode: 'EVGPD', eventName: '**Due to be delivered today by**', eventDateTime: '2026-01-05T07:00:00+00:00', locationName: '99999' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => [event.description, event.location ?? null])).toEqual([
      ['Due to be delivered today by Example DO', 'Example DO'],
      ['Arrived at Example MC', 'Example MC'],
      ['Item received at Sample MC', 'Sample MC'],
      ['Arrived at a Royal Mail office', null],
      // A place given by its postcode alone is left out, and the sentence ends without it.
      ['Due to be delivered today', null],
    ]);
  });

  it("takes the stage of the day's round over the summary category that repeats it", () => {
    const piece = (code: string, lastEventCode = code) => parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'Ready for Delivery', statusDescription: '**Ready for Delivery**', lastEventCode,
        lastEventDateTime: '2026-01-07T07:44:13+00:00' },
      events: [
        { eventCode: code, eventName: '**Due to be delivered today by**', eventDateTime: '2026-01-07T07:44:13+00:00', locationName: 'Example DO' },
        { eventCode: 'EVDAV', eventName: '**Item Received**', eventDateTime: '2026-01-06T09:54:07+00:00', locationName: 'Example MC' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(piece('EVGPD')).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Ready for Delivery' });
    // The summary's own time names the scan it repeats when its code is another.
    expect(piece('EVGPD', 'EVOTHER').current_stage).toBe('out_for_delivery');
    // A scan the map does not stage by its code leaves the summary's stage.
    expect(piece('EVUNMAPPED').current_stage).toBe('in_transit');
  });

  it('reads a mail centre receipt without an earlier acceptance as the acceptance', () => {
    const piece = (code: string, category: string) => parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: category, statusDescription: `**${category}**`, lastEventCode: code, lastEventDateTime: '2026-01-06T17:16:17+01:00' },
      events: [
        { eventCode: code, eventName: '**Item Received**', eventDateTime: '2026-01-06T17:16:17+01:00', locationName: 'Example MC' },
        { eventCode: 'EVAIP', eventName: 'Sender preparing item', eventDateTime: '2026-01-05T01:02:01+01:00' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(piece('EVDAC', 'We\'ve got it').events?.map(event => event.stage)).toEqual(['accepted', 'registered']);
    expect(piece('EVDAV', 'We\'ve got it').events?.map(event => event.stage)).toEqual(['accepted', 'registered']);
    expect(piece('EVIAV', 'In transit').events?.map(event => event.stage)).toEqual(['in_transit', 'registered']);
    expect(piece('EVDAV', 'We\'ve got it').current_stage).toBe('accepted');
  });

  it('stages a mail centre receipt after a drop-off in transit under "We\'ve got it"', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'We\'ve got it', statusDescription: '**We\'ve got it**', lastEventCode: 'EVDAV', lastEventDateTime: '2026-01-06T07:14:46+00:00' },
      events: [
        { eventCode: 'EVDAV', eventName: '**Item Received**', eventDateTime: '2026-01-06T07:14:46+00:00', locationName: 'Example MC' },
        { eventCode: 'LOPPA', eventName: '**Sender advised item dropped off at parcel locker**', eventDateTime: '2026-01-04T20:18:37+00:00' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'accepted']);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'We\'ve got it' });
  });

  it('reads scans abroad on their country\'s clock instead of the UK label', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: '**In Transit**', lastEventCode: 'EVJDU',
        lastEventDateTime: '2026-10-10T21:51:00+01:00', destinationCountryCode: 'FR' },
      events: [
        { eventCode: 'EVJDU', eventName: '**Item has left the overseas International Processing Centre**', eventDateTime: '2026-10-10T21:51:00+01:00', locationName: 'Example IPC, France' },
        { eventCode: 'EVJOE', eventName: '**Item Received**', eventDateTime: '2026-10-10T19:08:00+01:00', locationName: 'Example IPC, France' },
        { eventCode: 'EVHOE', eventName: '**Item Leaving the UK**', eventDateTime: '2026-10-10T03:31:09+01:00', locationName: 'Example HWDC' },
        { eventCode: 'EVDAC', eventName: '**Item Received**', eventDateTime: '2026-10-09T19:28:24+01:00', locationName: 'Example MC, United Kingdom' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => [event.time, event.stage])).toEqual([
      ['2026-10-10T21:51:00+02:00', 'in_transit'],
      ['2026-10-10T19:08:00+02:00', 'in_transit'],
      ['2026-10-10T03:31:09+01:00', 'in_transit'],
      ['2026-10-09T19:28:24+01:00', 'accepted'],
    ]);
    expect(result).toMatchObject({ last_status_text: 'In Transit', last_update: '2026-10-10T21:51:00+02:00', destination_country: 'FR' });
  });

  it('reads a European partner\'s scans, placed or in the destination country, on Central European time in summer', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: '**With Customs**', lastEventCode: 'EVJDC',
        lastEventDateTime: '2026-10-20T11:40:00+01:00', destinationCountryCode: 'PT' },
      events: [
        { eventCode: 'EVJDC', eventName: '**Your item is currently with Customs in the destination country**', eventDateTime: '2026-10-20T11:40:00+01:00' },
        { eventCode: 'EVJOE', eventName: '**Item Received**', eventDateTime: '2026-10-20T10:05:00+01:00', locationName: 'Portugal' },
        { eventCode: 'EVJOE', eventName: '**Item Received**', eventDateTime: '2026-10-19T21:15:00+01:00', locationName: 'Example IPC, Ireland' },
        { eventCode: 'EVHOE', eventName: '**Item Leaving the UK**', eventDateTime: '2026-10-15T03:31:09+01:00', locationName: 'Example HWDC' },
        { eventCode: 'EVDAC', eventName: '**Item Received**', eventDateTime: '2026-10-14T19:28:24+01:00', locationName: 'Example MC' },
      ],
    } }, IN_TRANSIT_NUMBER);
    // Lisbon and Dublin keep the UK's offset; their scans still come on the Continent's clock, an hour ahead.
    expect(result.events?.map(event => event.time)).toEqual([
      '2026-10-20T11:40:00+02:00', '2026-10-20T10:05:00+02:00', '2026-10-19T21:15:00+02:00',
      '2026-10-15T03:31:09+01:00', '2026-10-14T19:28:24+01:00',
    ]);
    expect(result.last_update).toBe('2026-10-20T11:40:00+02:00');
    // Without the details reply's destination, the scans abroad name the country.
    const unnamed = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit' },
      events: [
        { eventCode: 'EVJDC', eventName: 'Your item is currently with Customs in the destination country', eventDateTime: '2026-10-20T11:40:00+01:00' },
        { eventCode: 'EVJOE', eventName: 'Item Received', eventDateTime: '2026-10-20T10:05:00+01:00', locationName: 'Portugal' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(unnamed.events?.map(event => event.time)).toEqual(['2026-10-20T11:40:00+02:00', '2026-10-20T10:05:00+02:00']);
    // Without a European destination, an unplaced scan keeps Royal Mail's label.
    const elsewhere = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', destinationCountryCode: 'AU' },
      events: [{ eventCode: 'EVJDC', eventName: 'Your item is currently with Customs in the destination country', eventDateTime: '2026-10-20T11:40:00+01:00' }],
    } }, IN_TRANSIT_NUMBER);
    expect(elsewhere.events?.[0]!.time).toBe('2026-10-20T11:40:00+01:00');
  });

  it('reads a European partner\'s scans on UTC in winter, when the UK keeps Greenwich Mean Time', () => {
    // La Poste's own scans of the same items come an hour after Royal Mail's digits, on Paris time, as Poste Italiane's and Poczta Polska's do.
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', lastEventCode: 'EVJOE',
        lastEventDateTime: '2026-11-05T17:54:00+00:00', destinationCountryCode: 'FR' },
      events: [
        { eventCode: 'EVJOE', eventName: 'Item Received', eventDateTime: '2026-11-05T17:54:00+00:00', locationName: 'Example IPC, France' },
        { eventCode: 'EVJDC', eventName: 'Your item is currently with Customs in the destination country', eventDateTime: '2026-10-26T11:40:00+00:00' },
        { eventCode: 'EVHOE', eventName: 'Item Leaving the UK', eventDateTime: '2026-10-24T03:31:09+01:00', locationName: 'Example HWDC' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => event.time)).toEqual(['2026-11-05T17:54:00+00:00', '2026-10-26T11:40:00+00:00', '2026-10-24T03:31:09+01:00']);
    expect(result.last_update).toBe('2026-11-05T17:54:00+00:00');
  });

  it('reads a European partner\'s facility named without its country on the partner\'s clock', () => {
    // Mail from abroad: the origin's facility comes before the scan that leaves its country, Royal Mail's own after it.
    const inbound = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', destinationCountryCode: 'GB' },
      events: [
        { eventCode: 'EVDAV', eventName: 'Item Received', eventDateTime: '2026-10-23T09:00:00+01:00', locationName: 'Example International LC' },
        { eventCode: 'EVHOE', eventName: 'Item Leaving overseas', eventDateTime: '2026-10-22T07:27:00+01:00', locationName: 'Lithuania' },
        { eventCode: 'EVOAC', eventName: 'Item received at', eventDateTime: '2026-10-22T02:05:00+01:00', locationName: 'EXAMPLE SORTING DEPARTMENT' },
        { eventCode: 'EVOAC', eventName: 'Item received at', eventDateTime: '2026-10-22T01:00:00+01:00', locationName: 'Example MC' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(inbound.events?.map(event => event.time)).toEqual([
      '2026-10-23T09:00:00+01:00', '2026-10-22T07:27:00+02:00', '2026-10-22T02:05:00+02:00', '2026-10-22T01:00:00+01:00',
    ]);
    // Mail to Europe: a facility named alone is in the destination when the wording says so.
    const outbound = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', destinationCountryCode: 'IT' },
      events: [
        { eventCode: 'EVJAP', eventName: 'Your item is currently with Customs in the destination country', eventDateTime: '2026-10-20T11:40:00+01:00', locationName: 'EXAMPLE CSI' },
        { eventCode: 'EVHOE', eventName: 'Item Leaving the UK', eventDateTime: '2026-10-15T03:31:09+01:00', locationName: 'Example HWDC' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(outbound.events?.map(event => event.time)).toEqual(['2026-10-20T11:40:00+02:00', '2026-10-15T03:31:09+01:00']);
    // Mail to Europe: a partner's facility named alone after the item leaves the UK is in the destination;
    // the arrival at its delivery office came a minute after the scans placed there, on their clock.
    const delivery = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', destinationCountryCode: 'NL' },
      events: [
        { eventCode: 'EVIDD', eventName: 'Arrived at Delivery Office', eventDateTime: '2026-11-12T17:23:00+00:00', locationName: 'EXAMPLETOWN' },
        { eventCode: 'EVIBR', eventName: 'Item received at Sorting Office', eventDateTime: '2026-11-12T17:21:00+00:00', locationName: 'Example Sorting Office, Netherlands' },
        { eventCode: 'EVHOE', eventName: 'Item Leaving the UK', eventDateTime: '2026-11-10T20:13:35+00:00', locationName: 'Example HWDC' },
        { eventCode: 'EVDAC', eventName: 'Item Received', eventDateTime: '2026-11-10T01:16:31+00:00', locationName: 'Example Facility' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(delivery.events?.map(event => event.time)).toEqual([
      '2026-11-12T17:23:00+00:00', '2026-11-12T17:21:00+00:00', '2026-11-10T20:13:35Z', '2026-11-10T01:16:31Z',
    ]);
    // Beyond Europe, it keeps Royal Mail's label.
    const far = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', destinationCountryCode: 'CA' },
      events: [
        { eventCode: 'EVIDD', eventName: 'Arrived at Delivery Office', eventDateTime: '2026-11-12T17:23:00+00:00', locationName: 'EXAMPLETOWN' },
        { eventCode: 'EVHOE', eventName: 'Item Leaving the UK', eventDateTime: '2026-11-10T20:13:35+00:00', locationName: 'Example HWDC' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(far.events?.[0]!.time).toBe('2026-11-12T17:23:00Z');
  });

  it('keeps Royal Mail\'s label as the instant of a scan beyond Europe', () => {
    // Shape of a parcel to South Africa, whose post's own tracker dates these scans an hour later on its clock.
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', lastEventCode: 'EVJIA',
        lastEventDateTime: '2026-10-20T23:07:00+01:00', destinationCountryCode: 'ZA' },
      events: [
        { eventCode: 'EVJIA', eventName: 'Released from Customs', eventDateTime: '2026-10-20T23:07:00+01:00', locationName: 'South Africa' },
        { eventCode: 'EVJBA', eventName: 'Your item is currently with Customs in the destination country', eventDateTime: '2026-10-20T22:55:00+01:00', locationName: 'EXAMPLE EMS' },
        { eventCode: 'EVJOE', eventName: 'Item Received', eventDateTime: '2026-10-20T22:54:00+01:00', locationName: 'EXAMPLE EMS, South Africa' },
        { eventCode: 'EVHOE', eventName: 'Item Leaving the UK', eventDateTime: '2026-10-10T03:31:09+01:00' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => event.time)).toEqual([
      '2026-10-20T23:07:00+01:00', '2026-10-20T22:55:00+01:00', '2026-10-20T22:54:00+01:00', '2026-10-10T03:31:09+01:00',
    ]);
    expect(result.last_update).toBe('2026-10-20T23:07:00+01:00');
  });

  it('keeps the wall clock of a scan placed in Australia, which Royal Mail labels with central Australia\'s offset', () => {
    // Shape of a parcel from Australia, whose post dates these scans at 14:01 and 00:22 in Sydney's summer (+11:00).
    const result = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', lastEventCode: 'EVHOE',
        lastEventDateTime: '2026-11-17T14:52:00+00:00' },
      events: [
        { eventCode: 'EVHOE', eventName: 'Item Leaving overseas', eventDateTime: '2026-11-17T14:52:00+00:00', locationName: 'Australia' },
        { eventCode: 'EVOAC', eventName: 'Item received at', eventDateTime: '2026-11-17T04:31:00+00:00', locationName: 'Australia' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => [event.time, event.local_time])).toEqual([
      [undefined, '2026-11-18T00:22:00'], [undefined, '2026-11-17T14:01:00'],
    ]);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-11-18T00:22:00' });
    // The country names none of its zones; the scans take the one most Australians live on.
    expect(dateLocalClocks('parcelforce', result).events?.map(event => [event.time, event.time_zone])).toEqual([
      ['2026-11-18T00:22:00+11:00', 'Australia/Sydney'], ['2026-11-17T14:01:00+11:00', 'Australia/Sydney'],
    ]);
  });

  it('keeps the wall clock of a scan placed in the United States, which Royal Mail labels with Eastern standard time', () => {
    // Shape of a parcel to the US, whose post dates the receipt at its international service centre at 07:39 and the
    // release from customs at 19:04, Los Angeles time.
    const result = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', destinationCountryCode: 'US' },
      events: [
        { eventCode: 'EVJIA', eventName: 'Released from Customs', eventDateTime: '2026-11-20T00:04:00+00:00', locationName: 'United States of America' },
        { eventCode: 'EVIIS', eventName: 'Item received at Sorting Office', eventDateTime: '2026-11-19T22:01:00+00:00',
          locationName: 'Los Angeles, United States of America' },
        { eventCode: 'EVJOE', eventName: 'Item Received', eventDateTime: '2026-11-18T12:39:00+00:00', locationName: 'ISC EXAMPLE CITY CA (USPS)' },
        { eventCode: 'EVHOE', eventName: 'Item Leaving the UK', eventDateTime: '2026-11-17T03:34:00+00:00' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => [event.time, event.local_time])).toEqual([
      [undefined, '2026-11-19T19:04:00'], [undefined, '2026-11-19T17:01:00'], [undefined, '2026-11-18T07:39:00'], ['2026-11-17T03:34:00Z', undefined],
    ]);
    // A USPS facility's state or a town places them; the country alone takes its neighbours' clock.
    expect(dateLocalClocks('royal-mail', result).events?.map(event => [event.time, event.time_zone_basis])).toEqual([
      ['2026-11-19T19:04:00-08:00', 'neighbour'], ['2026-11-19T17:01:00-08:00', 'place'], ['2026-11-18T07:39:00-08:00', 'place'],
      ['2026-11-17T03:34:00Z', undefined],
    ]);
    // In the US's summer the label is the same: USPS dates an acceptance in Kentucky at 14:41, Eastern daylight time.
    const summer = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', destinationCountryCode: 'GB' },
      events: [{ eventCode: 'EVOAC', eventName: 'Item received at', eventDateTime: '2026-10-07T19:41:00+00:00', locationName: 'United States of America' }],
    } }, IN_TRANSIT_NUMBER);
    expect(summer.events?.[0]?.local_time).toBe('2026-10-07T14:41:00');
  });

  it('reads a receipt worded as an acceptance after the item moved as transit', () => {
    // Shape of a parcel from Australia whose post tells its lodging again the day after the item left.
    const result = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
      summary: { statusCategory: 'In transit', statusDescription: 'In transit', destinationCountryCode: 'GB' },
      events: [
        { eventCode: 'EVJOE', eventName: 'Item Received', eventDateTime: '2026-11-16T13:55:39+00:00', locationName: 'Example INT Hub' },
        { eventCode: 'EVOAC', eventName: 'Item received at', eventDateTime: '2026-11-12T04:46:00+00:00', locationName: 'Australia' },
        { eventCode: 'EVHOE', eventName: 'Item Leaving overseas', eventDateTime: '2026-11-11T11:01:00+00:00', locationName: 'Australia' },
        { eventCode: 'EVOAC', eventName: 'Item received at', eventDateTime: '2026-11-11T09:03:00+00:00', locationName: 'EXAMPLE EMS' },
      ],
    } }, IN_TRANSIT_NUMBER);
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['EVJOE', 'in_transit'], ['EVOAC', 'in_transit'], ['EVHOE', 'in_transit'], ['EVOAC', 'accepted'],
    ]);
  });

  it('dates a summary-only delivery from its last event and ignores an unusable destination', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: DELIVERED_NUMBER, summary: {
      statusCategory: 'Delivered', statusDescription: 'Delivered', lastEventCode: 'EVKOP', lastEventDateTime: '2026-01-03T09:56:31+00:00',
      destinationCountryCode: 'United Kingdom',
    } } }, DELIVERED_NUMBER);
    expect(result).toMatchObject({ summary_only: true, delivered_at: '2026-01-03T09:56:31Z' });
    expect(result).not.toHaveProperty('destination_country');
    const pending = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: DELIVERED_NUMBER, summary: {
      statusCategory: 'In transit', statusDescription: 'In transit', lastEventCode: 'EVKOP', lastEventDateTime: '2026-01-03T09:56:31+00:00',
    } } }, DELIVERED_NUMBER);
    expect(pending).not.toHaveProperty('delivered_at');
  });

  it('leaves an unknown full-history code and future wording unstaged', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER, summary: { statusCategory: 'No Status', statusDescription: 'New status' },
      events: [{ eventCode: 'UNKNOWN', eventName: '**Your item will be delivered tomorrow**', eventDateTime: '2026-01-03T09:00:00Z' }],
    } }, DELIVERED_NUMBER);
    expect(result.events?.[0]).toMatchObject({ description: 'Your item will be delivered tomorrow', provider_code: 'UNKNOWN' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
  });

  it('produces every capability carrier.json declares', () => {
    expect(CAPABILITIES).toEqual(['history', 'location', 'eta', 'delivered_at', 'provider_code']);
    const result = parseRoyalMailTrackingResponse(structuredClone(DELIVERED), DELIVERED_NUMBER);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.delivered_at).toBeTruthy();
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
    expect(parseRoyalMailTrackingResponse(structuredClone(IN_TRANSIT), IN_TRANSIT_NUMBER).expected_delivery).toBeTruthy();
  });

  it('rejects wrong identities, arrays, empty replies and gateway 404s', () => {
    const other = structuredClone(DELIVERED);
    (other.mailPieces as Record<string, unknown>).mailPieceId = 'SG999999997GB';
    expect(() => parseRoyalMailTrackingResponse(other, DELIVERED_NUMBER)).toThrow('requested parcel');
    for (const payload of [{}, { unexpected: true }, { mailPieces: [DELIVERED, DELIVERED] },
      { httpCode: '404', httpMessage: 'Not Found', moreInformation: 'No resources match requested URI' }, 'text']) {
      expect(() => parseRoyalMailTrackingResponse(payload, DELIVERED_NUMBER)).toThrow('invalid tracking response');
    }
  });

  it('keeps denials, throttles and inconclusive errors distinct', () => {
    expect(() => parseRoyalMailTrackingResponse({ errors: [{ code: 'E0015' }] }, DELIVERED_NUMBER))
      .toThrow('denied the tracking session');
    expect(() => parseRoyalMailTrackingResponse({ httpCode: '429' }, DELIVERED_NUMBER))
      .toThrow('rate limiting');
    expect(() => parseRoyalMailTrackingResponse({ errors: [{ errorCode: 'E1142' }] }, DELIVERED_NUMBER))
      .toThrow(expect.objectContaining({ message: expect.stringContaining('could not confirm'), reason: 'portal_not_found' }));
    expect(() => parseRoyalMailTrackingResponse({ errors: [{ errorCode: 'E1477' }] }, DELIVERED_NUMBER))
      .toThrow(expect.not.objectContaining({ reason: expect.anything() }));
  });

  it('supports summaries without history, sorts scans and does not guess unknown status', () => {
    const payload = structuredClone(DELIVERED);
    const piece = payload.mailPieces as Record<string, unknown>;
    (piece.events as unknown[]).reverse();
    expect(parseRoyalMailTrackingResponse(payload, DELIVERED_NUMBER).events?.[0]?.stage).toBe('delivered');
    delete piece.events;
    expect(parseRoyalMailTrackingResponse(payload, DELIVERED_NUMBER)).toMatchObject({status: 'delivered', events: [], summary_only: true});
    (piece.summary as Record<string, unknown>).statusDescription = 'New provider status';
    expect(parseRoyalMailTrackingResponse(payload, DELIVERED_NUMBER).status).toBe('unknown');
  });

  it.each(['2026-03-12T09:30:00', '2026-02-30T09:30:00Z', '2026-03-12T09:30:00+01:99',
    '2026-03-12T09:30:00+14:01', '2026-03-12T09:30:00+23:00',
    '2026-03-12', 'not a clock'])('preserves an unresolved clock without assigning an instant: %s', (clock) => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER,
      summary: { statusDescription: 'In transit', lastEventDateTime: clock },
      events: [{ eventName: 'Item received', eventDateTime: clock }],
    } }, DELIVERED_NUMBER);
    expect(result.last_update).toBeNull();
    expect(result.events?.[0]).toMatchObject({ provider_time_text: clock });
    expect(result.events?.[0]).not.toHaveProperty('time');
  });

  it('preserves provider order when only some event instants resolve', () => {
    const result = parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER, summary: { statusDescription: 'In transit' },
      events: [
        { eventName: 'First provider row', eventDateTime: '2026-01-01T09:00:00Z' },
        { eventName: 'Unresolved overseas row', eventDateTime: '2026-01-02T09:00:00' },
        { eventName: 'Last provider row', eventDateTime: '2026-01-03T09:00:00Z' },
      ],
    } }, DELIVERED_NUMBER);
    expect(result.events?.map(event => event.description)).toEqual([
      'First provider row', 'Unresolved overseas row', 'Last provider row',
    ]);
    expect(result.events?.[1]).toMatchObject({ provider_time_text: '2026-01-02T09:00:00' });
  });

  it.each([{}, [null], [{ eventDateTime: '2026-01-03T09:00:00Z' }]])('rejects malformed history instead of claiming an empty summary: %j', (events) => {
    expect(() => parseRoyalMailTrackingResponse({ mailPieces: {
      mailPieceId: DELIVERED_NUMBER, summary: { statusDescription: 'Delivered' }, events,
    } }, DELIVERED_NUMBER)).toThrow('invalid tracking events');
  });

});

describe('Royal Mail lookup steps', () => {
  it('merges the exact summary with the requested history and discards response extras', async () => {
    const summaryPiece = { mailPieceId: DELIVERED_NUMBER,
      summary: { statusCategory: 'Delivered', statusDescription: 'Delivered by PRIVATE SIGNATORY' } };
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      tier: 3, statusCode: 200, html: '<html>tracking app</html>', capturedResponses: [
        { url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status: 200, headers: {}, body: JSON.stringify({ mailPieces: summaryPiece }) },
        { url: royalMailEventsApiUrl(DELIVERED_NUMBER), status: 200, headers: {}, body: JSON.stringify({ mailPieces: {
          mailPieceId: DELIVERED_NUMBER, deliveryInfo: { recipient: 'PRIVATE RECIPIENT' },
          events: [{ eventCode: 'EVKOP', eventName: '**Delivered by** PRIVATE SIGNATORY', eventDateTime: '2026-01-03T09:00:00Z' }],
        } }) },
      ],
    }));
    const result = await new RoyalMailTracker({ trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher, fullHistory: true }).fetch(DELIVERED_NUMBER);
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', stage_source: 'carrier_map' });
    expect(result).not.toHaveProperty('summary_only');
    expect(result.last_status_text).toBe('Delivered by PRIVATE SIGNATORY');
    expect(JSON.stringify(result)).not.toContain('PRIVATE RECIPIENT');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      captureResponses: [royalMailSummaryApiUrl(DELIVERED_NUMBER), royalMailEventsApiUrl(DELIVERED_NUMBER)],
    });
  });

  it('keeps the summary estimate when the history reply has none', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      tier: 3, statusCode: 200, html: '<html>tracking app</html>', capturedResponses: [
        { url: royalMailSummaryApiUrl(IN_TRANSIT_NUMBER), status: 200, headers: {}, body: JSON.stringify({ mailPieces: {
          mailPieceId: IN_TRANSIT_NUMBER, summary: { statusCategory: 'In transit' }, estimatedDelivery: { date: '2026-03-20' } } }) },
        { url: royalMailEventsApiUrl(IN_TRANSIT_NUMBER), status: 200, headers: {}, body: JSON.stringify({ mailPieces: {
          mailPieceId: IN_TRANSIT_NUMBER, estimatedDelivery: { startOfEstimatedWindow: '08:00:00+00:00' },
          events: [{ eventCode: 'EVNMI', eventName: 'In transit', eventDateTime: '2026-03-15T22:41:00Z' }],
        } }) },
      ],
    }));
    await expect(new RoyalMailTracker({ trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher, fullHistory: true }).fetch(IN_TRANSIT_NUMBER))
      .resolves.toMatchObject({ expected_delivery: '2026-03-20' });
  });

  it.each([
    [undefined, 200, 'TransportError'],
    [{ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER, events: [] } }, 200, 'SchemaError'],
    [{ mailPieces: { mailPieceId: DELIVERED_NUMBER } }, 200, 'SchemaError'],
    [{ errors: [{ errorCode: 'E0015' }] }, 401, 'ChallengeError'],
    [{ errors: [{ errorCode: 'E1142' }] }, 404, 'IndeterminateError'],
  ])('does not claim full history when the details flow is missing or invalid: %j', async (payload, status, name) => {
    const summaryOnly = structuredClone(DELIVERED);
    delete (summaryOnly.mailPieces as Record<string, unknown>).events;
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      tier: 3, statusCode: 200, html: '<html>tracking app</html>', capturedResponses: [
        { url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status: 200, headers: {}, body: JSON.stringify(summaryOnly) },
        ...(payload === undefined ? [] : [{ url: royalMailEventsApiUrl(DELIVERED_NUMBER), status, headers: {}, body: JSON.stringify(payload) }]),
      ],
    }));
    await expect(new RoyalMailTracker({ trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher, fullHistory: true }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ name });
  });

  it('marks a valid empty events response as summary only', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      tier: 3, statusCode: 200, html: '<html>tracking app</html>', capturedResponses: [
        { url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status: 200, headers: {}, body: JSON.stringify(DELIVERED) },
        { url: royalMailEventsApiUrl(DELIVERED_NUMBER), status: 200, headers: {}, body: JSON.stringify({
          mailPieces: { mailPieceId: DELIVERED_NUMBER, events: [] },
        }) },
      ],
    }));
    await expect(new RoyalMailTracker({ trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher, fullHistory: true }).fetch(DELIVERED_NUMBER))
      .resolves.toMatchObject({ events: [], summary_only: true });
  });

  it('requires local Chromium for normal routing even when a browser service exists', () => {
    const fetcher = vi.fn();
    const instance = adapter({ trawl: new TrawlClient(TRAWL_URL, fetcher), browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher });
    expect(instance.steps).toEqual(['browser', 'retry']);
    expect(() => instance.track({ number: DELIVERED_NUMBER })).toThrow('TRACKING_CHROMIUM_PATH');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('hands the configured proxy to the local browser', async () => {
    vi.mocked(fetchRoyalMailInBrowser).mockResolvedValueOnce({ events: [] });
    const instance = adapter({ trawl: null, browserExecutablePath: '/test/chromium', recorder: NOOP_RECORDER,
      env: { ROYAL_MAIL_BROWSER_PROXY: 'socks5://10.0.0.1:1080' } });
    await instance.track({ number: DELIVERED_NUMBER });
    expect(fetchRoyalMailInBrowser).toHaveBeenCalledWith(DELIVERED_NUMBER, '/test/chromium', expect.any(AbortSignal),
      expect.any(Number), true, 'socks5://10.0.0.1:1080', null);
  });

  it('gives the browser lookup at most 30 seconds of a longer budget', async () => {
    vi.mocked(fetchRoyalMailInBrowser).mockResolvedValueOnce({ events: [] });
    const instance = adapter({ trawl: null, browserExecutablePath: '/test/chromium', recorder: NOOP_RECORDER, env: {} });
    await instance.track({ number: DELIVERED_NUMBER }, { budgetMs: 60_000 });
    const timeoutMs = vi.mocked(fetchRoyalMailInBrowser).mock.lastCall![3];
    expect(timeoutMs).toBeLessThanOrEqual(30_000);
    expect(timeoutMs).toBeGreaterThan(29_000);
  });

  it('enables vision only with explicit carrier configuration and shares its attempt across retries', async () => {
    vi.mocked(fetchRoyalMailInBrowser).mockRejectedValueOnce(new ChallengeError('Royal Mail'))
      .mockResolvedValueOnce({ events: [] });
    const instance = adapter({ trawl: null, browserExecutablePath: '/test/chromium', recorder: NOOP_RECORDER,
      env: { ROYAL_MAIL_GEMINI_API_KEY: 'synthetic-key' } });
    await instance.track({ number: DELIVERED_NUMBER });
    const calls = vi.mocked(fetchRoyalMailInBrowser).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[7]?.options.apiKey).toBe('synthetic-key');
    // The one model request is shared: a first context that spent it leaves none for the retry.
    expect(calls[0]?.[7]).toBe(calls[1]?.[7]);
    expect(calls[0]?.[7]).not.toHaveProperty('retryReserveMs');
  });

  it.each(['captcha_refused', 'captcha_blocked'])('does not retry after a real visual refusal: %s', async reason => {
    const error = new ChallengeError('Royal Mail', 'Verification refused', { reason });
    vi.mocked(fetchRoyalMailInBrowser).mockRejectedValueOnce(error);
    const tracker = new RoyalMailTracker({ executablePath: '/test/chromium', captchaVision: { apiKey: 'synthetic-key' } });
    await expect(tracker.fetch(DELIVERED_NUMBER)).rejects.toBe(error);
    expect(fetchRoyalMailInBrowser).toHaveBeenCalledOnce();
  });

  it('logs only fixed verification fields when explicitly enabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetchRoyalMailInBrowser).mockImplementationOnce(async (...args) => {
      args[7]?.options.onVerification?.({ outcome: 'accepted', phase: 'proof', modelCalls: 1, rounds: 1, refreshes: 0,
        actions: 1, submissions: 1, checks: 1, accepted: true, history: true, modelMs: 100 });
      return { events: [] };
    });
    const instance = adapter({ trawl: null, browserExecutablePath: '/test/chromium', recorder: NOOP_RECORDER,
      env: { ROYAL_MAIL_GEMINI_API_KEY: 'synthetic-key', ROYAL_MAIL_GEMINI_LOG_VERIFICATION: '1' } });
    await instance.track({ number: DELIVERED_NUMBER });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ event: 'royal_mail.verification', accepted: true, history: true });
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('synthetic-key');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(DELIVERED_NUMBER);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({ event: 'royal_mail.verification', outcome: 'accepted', phase: 'proof', modelCalls: 1, rounds: 1, refreshes: 0,
      actions: 1, submissions: 1, checks: 1, accepted: true, history: true, modelMs: 100 });
  });

  it('uses the dedicated remote browser for tracking and browser recognition without requiring local Chromium', async () => {
    const endpoint = 'ws://browser.invalid/synthetic-capability';
    vi.mocked(fetchRoyalMailInBrowser).mockResolvedValue({ ...parseRoyalMailTrackingResponse(DELIVERED, DELIVERED_NUMBER) });
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER,
      env: { ROYAL_MAIL_BROWSER_WS_ENDPOINT: endpoint } });
    await instance.track({ number: DELIVERED_NUMBER });
    await instance.recognizeWithBrowser!(DELIVERED_NUMBER);
    expect(instance.steps).toEqual(['browser', 'retry']);
    expect(fetchRoyalMailInBrowser).toHaveBeenCalledTimes(2);
    expect(fetchRoyalMailInBrowser).toHaveBeenCalledWith(DELIVERED_NUMBER, '', expect.any(AbortSignal), expect.any(Number), true, null, endpoint);
  });

  it('recovers a challenge with fresh full-history retrieval inside the original deadline', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const challenge = new ChallengeError('Royal Mail');
    const result = parseRoyalMailTrackingResponse(DELIVERED, DELIVERED_NUMBER);
    const step = vi.fn();
    const lookup = vi.fn();
    vi.mocked(fetchRoyalMailInBrowser).mockImplementationOnce(async () => {
      now = 11_000;
      throw challenge;
    }).mockResolvedValueOnce(result);
    const tracker = new RoyalMailTracker({ browserWsEndpoint: 'ws://browser.invalid/synthetic-capability',
      fullHistory: true, recorder: { step, lookup } });
    await expect(tracker.fetch(DELIVERED_NUMBER, { budgetMs: 60_000 })).resolves.toBe(result);
    const calls = vi.mocked(fetchRoyalMailInBrowser).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[3]).toBe(30_000);
    expect(calls[1]?.[3]).toBe(19_000);
    expect(calls[1]?.[4]).toBe(true);
    expect(calls[1]?.[6]).toBe(calls[0]?.[6]);
    expect(step).toHaveBeenNthCalledWith(1, expect.objectContaining({ step: 'browser', outcome: 'challenge' }));
    expect(step).toHaveBeenNthCalledWith(2, expect.objectContaining({ step: 'retry', outcome: 'ok',
      fallbackFrom: 'browser', fallbackReason: 'challenge', fallbackError: challenge }));
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ finalStep: 'retry', outcome: 'ok', attempts: 2 }));
  });

  it('holds a lookup past its 30-second cap only while the solver works on a task it can read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const tracker = new RoyalMailTracker({ browserWsEndpoint: 'ws://browser.invalid/synthetic-capability',
        captchaVision: { apiKey: 'synthetic-key' } });
      vi.mocked(fetchRoyalMailInBrowser).mockImplementationOnce((_number, _path, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
      const plain = tracker.fetch(DELIVERED_NUMBER, { budgetMs: 60_000 });
      const ended = expect(plain).rejects.toBeInstanceOf(BudgetExceededError);
      await vi.advanceTimersByTimeAsync(30_000);
      await ended;
      expect(fetchRoyalMailInBrowser).toHaveBeenCalledOnce();
      expect(vi.mocked(fetchRoyalMailInBrowser).mock.calls[0]?.[3]).toBeGreaterThan(49_000);
      const result = parseRoyalMailTrackingResponse(DELIVERED, DELIVERED_NUMBER);
      vi.mocked(fetchRoyalMailInBrowser).mockImplementationOnce(async (_number, _path, signal, _ms, _history, _proxy, _endpoint, vision) => {
        vision!.attempt.solving = true;
        await new Promise(resolve => setTimeout(resolve, 40_000));
        signal.throwIfAborted();
        return result;
      });
      const solved = tracker.fetch(DELIVERED_NUMBER, { budgetMs: 60_000 });
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(solved).resolves.toBe(result);
    } finally { vi.useRealTimers(); }
  });

  it('keeps a second challenge as a failure without a third session', async () => {
    const challenge = new ChallengeError('Royal Mail');
    vi.mocked(fetchRoyalMailInBrowser).mockRejectedValue(challenge);
    const { recorder, records } = stepRecorder();
    await expect(new RoyalMailTracker({ executablePath: '/test/chromium', recorder }).fetch(DELIVERED_NUMBER))
      .rejects.toBe(challenge);
    expect(fetchRoyalMailInBrowser).toHaveBeenCalledTimes(2);
    expect(records).toEqual(['browser:challenge', 'retry:challenge', 'lookup:retry:challenge']);
  });

  it.each([new RateLimitedError('Royal Mail'), new SchemaError('Royal Mail'), new NotFoundError('Royal Mail'),
    new IndeterminateError('Royal Mail'), new TransportError('Royal Mail')])('does not retry $name', async error => {
    vi.mocked(fetchRoyalMailInBrowser).mockRejectedValueOnce(error);
    await expect(new RoyalMailTracker({ executablePath: '/test/chromium' }).fetch(DELIVERED_NUMBER)).rejects.toBe(error);
    expect(fetchRoyalMailInBrowser).toHaveBeenCalledTimes(1);
  });

  it.each([[30_000, 16_000], [20_000, 6_000], [10_000, 0]])(
    'keeps the challenge when budget %i has spent %i and cannot finish a fresh flow', async (budgetMs, spentMs) => {
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const challenge = new ChallengeError('Royal Mail');
      vi.mocked(fetchRoyalMailInBrowser).mockImplementationOnce(async () => { now = spentMs; throw challenge; });
      const { recorder, records } = stepRecorder();
      await expect(new RoyalMailTracker({ executablePath: '/test/chromium', recorder }).fetch(DELIVERED_NUMBER, { budgetMs }))
        .rejects.toBe(challenge);
      expect(fetchRoyalMailInBrowser).toHaveBeenCalledTimes(1);
      expect(records).toEqual(['browser:challenge', 'lookup:browser:challenge']);
    },
  );

  it('does not open a recovery session after caller cancellation', async () => {
    const controller = new AbortController();
    const challenge = new ChallengeError('Royal Mail');
    vi.mocked(fetchRoyalMailInBrowser).mockImplementationOnce(async () => { controller.abort(); throw challenge; });
    await expect(new RoyalMailTracker({ executablePath: '/test/chromium' })
      .fetch(DELIVERED_NUMBER, { signal: controller.signal })).rejects.toBe(challenge);
    expect(fetchRoyalMailInBrowser).toHaveBeenCalledTimes(1);
  });

  it.each([404, 410])('keeps an unrecognized HTTP %s outside parcel absence', async status => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ tier: 3, statusCode: 200, html: '', capturedResponses: [
      { url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status, headers: {}, body: '{}' },
    ] }));
    await expect(new RoyalMailTracker({ trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('reports the missing browser service without any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch'));
    await expect(new RoyalMailTracker({ trawl: null }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({
        name: 'ChallengeError',
        message: 'Royal Mail challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
      });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads only the summary reply for the exact requested number', async () => {
    const summaryUrl = royalMailSummaryApiUrl(DELIVERED_NUMBER);
    const other = structuredClone(DELIVERED);
    (other.mailPieces as Record<string, unknown>).mailPieceId = 'SG999999997GB';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tier: 3,
      statusCode: 200,
      url: royalMailTrackingUrl(DELIVERED_NUMBER),
      html: '<html><body>tracking app</body></html>',
      cookies: [],
      userAgent: 'Mozilla/5.0 (test browser)',
      capturedResponses: [
        { url: summaryUrl, status: 200, headers: {}, body: JSON.stringify(structuredClone(DELIVERED)), truncated: false, base64Encoded: false, error: null },
        { url: 'https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/SG999999997GB', status: 200, headers: {}, body: JSON.stringify(other), truncated: false, base64Encoded: false, error: null },
      ],
    }));
    const { recorder, records } = stepRecorder();

    const result = await new RoyalMailTracker({ timeoutMs: 2_000, trawl: new TrawlClient(TRAWL_URL), recorder }).fetch(DELIVERED_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      tracking_source: 'structured-web-response',
      tracking_url: royalMailTrackingUrl(DELIVERED_NUMBER),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: royalMailTrackingUrl(DELIVERED_NUMBER),
      skipHttp: true,
      maxTier: 3,
      captureResponses: [summaryUrl],
    });
    expect(records).toEqual(['trawl:ok', 'lookup:trawl:ok']);
  });

  it.each([200, 304])('accepts browser document HTTP %s only with a valid tracking capture', async (statusCode) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      tier: 3, statusCode, html: '<html>tracking app</html>',
      capturedResponses: [{url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status: 200,
        body: JSON.stringify(DELIVERED), headers: {}}],
    }));
    await expect(new RoyalMailTracker({trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher}).fetch(DELIVERED_NUMBER))
      .resolves.toMatchObject({status: 'delivered'});
  });

  it.each([true, false])('uses the final reply when session refresh succeeds: %s', async (recovered) => {
    const rows = [
      {url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status: 401,
        body: JSON.stringify({errors: [{errorCode: 'E0015'}]}), headers: {}},
      {url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status: 200,
        body: JSON.stringify(DELIVERED), headers: {}},
    ];
    if (!recovered) rows.reverse();
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      tier: 3, statusCode: 200, html: '<html>tracking app</html>', capturedResponses: rows,
    }));
    const result = new RoyalMailTracker({trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher}).fetch(DELIVERED_NUMBER);
    if (recovered) await expect(result).resolves.toMatchObject({status: 'delivered'});
    else await expect(result).rejects.toMatchObject({name: 'ChallengeError'});
  });

  it.each([[1, 200], [3, 302], [3, 0]])('rejects unsolved browser tier %s / document %s', async (tier, statusCode) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({tier, statusCode, html: '<html>app</html>'}));
    await expect(new RoyalMailTracker({trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher}).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({name: 'TransportError'});
  });

  it.each([
    [404, {errors: [{errorCode: 'E1142'}]}, 'IndeterminateError', 'portal_not_found'],
    [404, {errors: [{errorCode: 'E1283'}]}, 'IndeterminateError'],
    [403, {}, 'ChallengeError'],
    [429, {}, 'RateLimitedError'],
    [200, {errors: [{errorCode: 'E0015'}]}, 'ChallengeError'],
    [200, {mailPieces: {mailPieceId: 'SG999999997GB', summary: {statusDescription: 'Delivered'}}}, 'SchemaError'],
  ])('preserves failure classification for HTTP %s', async (status, payload, name, reason?: string) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      tier: 3, statusCode: 200, html: '<html>tracking app</html>',
      capturedResponses: [{url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status,
        body: JSON.stringify(payload), headers: {'retry-after': '60'}}],
    }));
    await expect(new RoyalMailTracker({trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher}).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({name, ...(status === 429 ? {retryAfterMs: 60_000} : {}),
        ...(reason ? {reason} : {})});
  });

  it('names a challenged browser page instead of reporting it as not-found', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        url: royalMailTrackingUrl(DELIVERED_NUMBER),
        html: '<html><body><h1>Access Denied</h1></body></html>',
        cookies: [],
        userAgent: 'Mozilla/5.0 (test browser)',
        capturedResponses: [],
      }), { headers: { 'Content-Type': 'application/json' } }));

    await expect(new RoyalMailTracker({ timeoutMs: 2_000, trawl: new TrawlClient(TRAWL_URL) }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ name: 'ChallengeError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a number that is not a Royal Mail number before any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch'));
    const lookup = new RoyalMailTracker({ trawl: new TrawlClient(TRAWL_URL) }).fetch('1Z999AA10123456784');
    await expect(lookup).rejects.toThrow('Royal Mail tracking numbers must match the UPU S10 format');
    await expect(lookup).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts both 2D reference families but not 21 digits outside the 32 prefix', () => {
    expect(royalMailTrackingUrl('4c-000 000 0000-0AB CDE F12')).toBe('https://www.royalmail.com/track-your-item#/tracking-results/4C00000000000ABCDEF12');
    expect(royalMailTrackingUrl('320000000000000000000')).toContain('/320000000000000000000');
    expect(royalMailTrackingUrl('0000ABCDEF000000')).toContain('/0000ABCDEF000000');
    expect(() => royalMailTrackingUrl('120000000000000000000')).toThrow('domestic 2D reference');
    expect(() => royalMailTrackingUrl('4C000A0000000ABCDEF12')).toThrow('domestic 2D reference');
    // FAN Courier International's shape is Royal Mail's too when it starts 32.
    expect(royalMailTrackingUrl('3200192540002217F4500')).toContain('/3200192540002217F4500');
    expect(() => royalMailTrackingUrl('1000000000000001F0001')).toThrow('domestic 2D reference');
  });

  it('accepts a Parcelforce parcel number, which the same tracker answers, but not its consignment number', () => {
    expect(royalMailTrackingUrl('pbzz 0000000 001')).toBe('https://www.royalmail.com/track-your-item#/tracking-results/PBZZ0000000001');
    expect(() => royalMailTrackingUrl('ZZ0000000')).toThrow('Parcelforce parcel number');
    expect(() => royalMailTrackingUrl('PBZZ00000000001')).toThrow('Parcelforce parcel number');
  });

  it('accepts another post\'s S10 number, which the tracker answers once the item reaches the UK, when its check digit holds', () => {
    expect(royalMailTrackingUrl('zz 000 000 005 nl')).toBe('https://www.royalmail.com/track-your-item#/tracking-results/ZZ000000005NL');
    expect(() => royalMailTrackingUrl('ZZ000000004NL')).toThrow('UPU S10 format');
  });

  it('builds the canonical tracking and summary URLs', () => {
    expect(royalMailTrackingUrl(DELIVERED_NUMBER)).toBe(
      `https://www.royalmail.com/track-your-item#/tracking-results/${DELIVERED_NUMBER}`);
    expect(royalMailSummaryApiUrl(DELIVERED_NUMBER)).toBe(
      `https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/${DELIVERED_NUMBER}`);
    expect(royalMailEventsApiUrl(DELIVERED_NUMBER)).toBe(
      `https://api-web.royalmail.com/mailpieces/v3/${DELIVERED_NUMBER}/events`);
  });
});

describe('Royal Mail rendered page', () => {
  it('tells a challenge from an inconclusive load', () => {
    expect(parseRoyalMailTrackingHtml('<html><body><h1>Access Denied</h1></body></html>')).toBe('challenged');
    expect(parseRoyalMailTrackingHtml('<html><body>Track your item</body></html>')).toBe('inconclusive');
  });
});

describe('Royal Mail lookup budget', () => {
  it('gives the service its own time and waits the transport allowance for its answer when no budget is set', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error), { once: true });
    }));
    const pending = new RoyalMailTracker({ timeoutMs: 40, trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher })
      .fetch(DELIVERED_NUMBER, { signal: controller.signal });
    const settled = vi.fn();
    pending.then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The service was told 40 ms; the request is still open for its timeout answer.
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ maxTimeout: 40 });
    expect(settled).not.toHaveBeenCalled();
    controller.abort(new Error('caller cancelled'));
    await expect(pending).rejects.toThrow('caller cancelled');
    // A caller's budget is a hard stop instead.
    await expect(new RoyalMailTracker({ trawl: new TrawlClient(TRAWL_URL, fetcher), fetcher }).fetch(DELIVERED_NUMBER, { budgetMs: 40 }))
      .rejects.toMatchObject({ kind: 'transport' });
  });
});

it('dates collection from the summary when its code recurs another day', () => {
  const result = parseRoyalMailTrackingResponse({ mailPieces: { mailPieceId: IN_TRANSIT_NUMBER,
    events: [{ eventCode: 'EVNSC', eventName: 'Collected From Your Customer Service Point', eventDateTime: '2026-01-19T16:00:00Z' }],
    summary: { statusCategory: 'Collected', statusDescription: 'Collected', lastEventCode: 'EVNSC', lastEventDateTime: '2026-01-20T16:00:00Z' },
  } }, IN_TRANSIT_NUMBER);
  expect(result.delivered_at).toBe('2026-01-20T16:00:00Z');
  expect(result.events?.[0]?.stage).toBeUndefined();
});
