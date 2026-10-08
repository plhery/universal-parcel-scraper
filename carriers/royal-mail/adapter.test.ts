import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrawlClient } from '../../core/transport/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
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
import { royalMailStage, royalMailStatus } from './status.js';

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
    expect(result).toMatchObject({status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', expected_delivery: null});
    expect(result.events?.[0]?.stage).toBe('accepted');
    expect(JSON.stringify(result)).not.toContain('PRIVATE RECIPIENT');
  });

  it('projects the delivered summary with per-scan codes', () => {
    const result = parseRoyalMailTrackingResponse(structuredClone(DELIVERED), DELIVERED_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-03-14T08:00:00Z',
      expected_delivery: null,
    });
    expect(result.events).toEqual([
      { time: '2026-03-14T08:00:00Z', location: 'LONDON', description: 'Delivered', stage: 'delivered', provider_code: 'DL' },
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

  it('keeps the signatory out of the result', () => {
    const serialized = JSON.stringify(parseRoyalMailTrackingResponse(structuredClone(DELIVERED), DELIVERED_NUMBER));
    expect(serialized).not.toContain('PRIVATE RECIPIENT');
  });

  it('uses full-history codes before repeated wording and removes Markdown delivery prose', () => {
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
      'delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'registered',
    ]);
    expect(result.delivered_at).toBe('2026-01-03T09:56:31Z');
    expect(result.events?.every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(result.events?.[0]?.description).toBe('Delivered');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('**');
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
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-01-09T15:24:00+01:00', destination_country: 'US' });
    expect(result.events?.map(event => event.location)).toEqual([
      'Exampleville, United States of America', undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'Example Post Office', 'Example DO [Main]', undefined,
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
      .toThrow('could not confirm');
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
    const result = await new RoyalMailTracker({ trawlUrl: TRAWL_URL, fetcher, fullHistory: true }).fetch(DELIVERED_NUMBER);
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', stage_source: 'carrier_map' });
    expect(result).not.toHaveProperty('summary_only');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      captureResponses: [royalMailSummaryApiUrl(DELIVERED_NUMBER), royalMailEventsApiUrl(DELIVERED_NUMBER)],
    });
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
    await expect(new RoyalMailTracker({ trawlUrl: TRAWL_URL, fetcher, fullHistory: true }).fetch(DELIVERED_NUMBER))
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
    await expect(new RoyalMailTracker({ trawlUrl: TRAWL_URL, fetcher, fullHistory: true }).fetch(DELIVERED_NUMBER))
      .resolves.toMatchObject({ events: [], summary_only: true });
  });

  it('requires local Chromium for normal routing even when a browser service exists', () => {
    const fetcher = vi.fn();
    const instance = adapter({ trawl: new TrawlClient(TRAWL_URL, fetcher), browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher });
    expect(instance.steps).toEqual(['browser']);
    expect(() => instance.track({ number: DELIVERED_NUMBER })).toThrow('TRACKING_CHROMIUM_PATH');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([404, 410])('keeps an unrecognized HTTP %s outside parcel absence', async status => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ tier: 3, statusCode: 200, html: '', capturedResponses: [
      { url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status, headers: {}, body: '{}' },
    ] }));
    await expect(new RoyalMailTracker({ trawlUrl: TRAWL_URL, fetcher }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('reports the missing browser service without any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch'));
    await expect(new RoyalMailTracker({ trawlUrl: '' }).fetch(DELIVERED_NUMBER))
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

    const result = await new RoyalMailTracker({ timeoutMs: 2_000, trawlUrl: TRAWL_URL, recorder }).fetch(DELIVERED_NUMBER);

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
    await expect(new RoyalMailTracker({trawlUrl: TRAWL_URL, fetcher}).fetch(DELIVERED_NUMBER))
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
    const result = new RoyalMailTracker({trawlUrl: TRAWL_URL, fetcher}).fetch(DELIVERED_NUMBER);
    if (recovered) await expect(result).resolves.toMatchObject({status: 'delivered'});
    else await expect(result).rejects.toMatchObject({name: 'ChallengeError'});
  });

  it.each([[1, 200], [3, 302], [3, 0]])('rejects unsolved browser tier %s / document %s', async (tier, statusCode) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({tier, statusCode, html: '<html>app</html>'}));
    await expect(new RoyalMailTracker({trawlUrl: TRAWL_URL, fetcher}).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({name: 'TransportError'});
  });

  it.each([
    [404, {errors: [{errorCode: 'E1142'}]}, 'IndeterminateError'],
    [403, {}, 'ChallengeError'],
    [429, {}, 'RateLimitedError'],
    [200, {errors: [{errorCode: 'E0015'}]}, 'ChallengeError'],
    [200, {mailPieces: {mailPieceId: 'SG999999997GB', summary: {statusDescription: 'Delivered'}}}, 'SchemaError'],
  ])('preserves failure classification for HTTP %s', async (status, payload, name) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      tier: 3, statusCode: 200, html: '<html>tracking app</html>',
      capturedResponses: [{url: royalMailSummaryApiUrl(DELIVERED_NUMBER), status,
        body: JSON.stringify(payload), headers: {'retry-after': '60'}}],
    }));
    await expect(new RoyalMailTracker({trawlUrl: TRAWL_URL, fetcher}).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({name, ...(status === 429 ? {retryAfterMs: 60_000} : {})});
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

    await expect(new RoyalMailTracker({ timeoutMs: 2_000, trawlUrl: TRAWL_URL }).fetch(DELIVERED_NUMBER))
      .rejects.toMatchObject({ name: 'ChallengeError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects a number that is not a Royal Mail number before any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch'));
    const lookup = new RoyalMailTracker({ trawlUrl: TRAWL_URL }).fetch('1Z999AA10123456784');
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
  });

  it('accepts a Parcelforce parcel number, which the same tracker answers, but not its consignment number', () => {
    expect(royalMailTrackingUrl('pbzz 0000000 001')).toBe('https://www.royalmail.com/track-your-item#/tracking-results/PBZZ0000000001');
    expect(() => royalMailTrackingUrl('ZZ0000000')).toThrow('Parcelforce parcel number');
    expect(() => royalMailTrackingUrl('PBZZ00000000001')).toThrow('Parcelforce parcel number');
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
    const pending = new RoyalMailTracker({ timeoutMs: 40, trawlUrl: TRAWL_URL, fetcher })
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
    await expect(new RoyalMailTracker({ trawlUrl: TRAWL_URL, fetcher }).fetch(DELIVERED_NUMBER, { budgetMs: 40 }))
      .rejects.toMatchObject({ kind: 'transport' });
  });
});
