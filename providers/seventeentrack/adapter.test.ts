// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierErrorKind } from '../../core/errors/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, parse17TrackResponse, SeventeenTrackTracker } from './adapter.js';

const number = 'ZZ12345678900';
const API = 'https://t.17track.net/track/restapi';
interface Payload { meta: { code: number }; shipments: Record<string, unknown>[] }
const delivered = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8')) as Payload;
const history = (value = number): Payload => ({ ...delivered, shipments: [{ ...delivered.shipments[0], number: value }] });
const noHistory = (value = number): Payload => ({ meta: { code: 200 }, shipments: [{ number: value, code: 400, shipment: null }] });
const postalHistory = (events: Record<string, unknown>[], status = 'Expired'): Payload => ({
  meta: { code: 200 }, shipments: [{ number, code: 200, shipment: {
    latest_status: { status, sub_status: `${status}_Other` },
    tracking: { providers: [{ provider: { key: 3011, name: 'China Post' }, events }] },
  } }],
});
const postalScan = (sub_status: string, description = '邮件运输中') => ({
  time_iso: '2026-09-20T12:22:00+08:00', time_utc: '2026-09-20T04:22:00Z',
  time_raw: { date: '2026-09-20', time: '12:22:00', timezone: null }, description, stage: null, sub_status,
});
const thrown = (run: () => unknown): unknown => {
  try { run(); } catch (error) { return error; }
  return null;
};

const captured = (data: unknown, overrides: Record<string, unknown> = {}) => new Response(JSON.stringify({
  url: `https://t.17track.net/en#nums=${number}`, html: '<html></html>', statusCode: 200, tier: 3,
  capturedResponses: [{ url: API, body: JSON.stringify(data), status: 200, truncated: false, base64Encoded: false }],
  ...overrides,
}));

function tracker(fetcher: typeof fetch, trawlUrl = 'http://browser.test') {
  return new SeventeenTrackTracker({ trawl: new TrawlClient(trawlUrl, fetcher) });
}

describe('17TRACK result parsing', () => {
  it.each(['Not delivered to sender', 'Will be delivered back to sender', 'May have been delivered to the sender',
    "Wasn't delivered back to shipper", 'To be delivered to the shipper', 'Being delivered back to sender', 'Will not be delivered to sender'])(
    'does not complete sender delivery from %s without a provider status', description => {
      const result = parse17TrackResponse(postalHistory([postalScan('', description)]), number);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', events: [{ stage: 'exception' }] });
      expect(result.delivered_at).toBeUndefined();
    },
  );

  it.each(['Delivered back to sender', 'Delivered to the shipper', 'Has been delivered back to the sender',
    'The item was not delivered and has been returned to sender'])(
    'keeps affirmative completed sender delivery from %s without a provider status', description => {
      const result = parse17TrackResponse(postalHistory([postalScan('', description)]), number);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', events: [{ stage: 'returned' }] });
    },
  );
  it('refines Swiss Post vehicle loading without reclassifying other operators or future wording', () => {
    const payload = postalHistory([postalScan('InTransit_Other', 'Loading into delivery vehicle')]);
    const shipment = payload.shipments[0]!.shipment as { tracking: { providers: Array<{ provider: { name: string }; events: unknown[] }> } };
    shipment.tracking.providers[0]!.provider = { name: 'Swiss Post' };
    expect(parse17TrackResponse(payload, number)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      events: [{ stage: 'out_for_delivery', provider_code: 'InTransit_Other' }] });
    shipment.tracking.providers[0]!.provider = { name: 'Other postal operator' };
    expect(parse17TrackResponse(payload, number).current_stage).toBe('in_transit');
    shipment.tracking.providers[0]!.provider = { name: 'Swiss Post' };
    shipment.tracking.providers[0]!.events = [postalScan('InTransit_Other', 'Will be loaded into delivery vehicle')];
    expect(parse17TrackResponse(payload, number).current_stage).toBe('in_transit');
  });

  it('reads an exact voided label as a problem despite the generic transit code', () => {
    const label = { ...postalScan('InfoReceived', 'Shipping Label Created'),
      time_iso: '2026-09-19T12:22:00+08:00', time_utc: '2026-09-19T04:22:00Z' };
    for (const description of ['Parcel Void', 'PARCEL VOIDED', 'Shipping label has been voided.']) {
      expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other', description), label]), number)).toMatchObject({
        status: 'exception', current_stage: 'exception', last_status_text: description,
        events: [{ stage: 'exception', provider_code: 'InTransit_Other' }, { stage: 'registered', provider_code: 'InfoReceived' }] });
    }
    // A relabel is a new label, not a cancelled shipment.
    expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other', 'Label voided, new label created')]), number))
      .toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it.each(['Returning to sender', 'Return to sender', 'Will be returned to sender',
    'To be returned to the sender', 'Being returned to sender', 'Will soon be returned to sender',
    'Not yet returned to sender', 'Could not be returned to sender', 'Cannot be returned to sender',
    'Will not be returned to sender', "Hasn't been returned to sender", 'Hasn’t yet been returned to the sender',
    "Won't be returned to sender", "Wasn't returned to sender", 'May be returned to sender',
    'Should be returned to sender', 'Might have been returned to sender', 'Will have been returned to sender',
    'Could already have been returned to sender', 'Return initiated'])(
    'does not complete a return from generic transit and %s', description => {
      const result = parse17TrackResponse(postalHistory([postalScan('InTransit_Other', description)]), number);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'exception' });
      expect(result.events?.[0]?.stage).toBe('exception');
      expect(result.delivered_at).toBeUndefined();
    },
  );

  it.each(['Returned to sender', 'Has been returned to the sender', 'Has already been returned to sender',
    'The item was not delivered and has been returned to sender'])(
    'preserves completed sender return from generic transit and %s', description => {
      const result = parse17TrackResponse(postalHistory([postalScan('InTransit_Other', description)]), number);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', events: [{ stage: 'returned' }] });
    },
  );

  it.each([
    ['InTransit_TransportArrived', '飞机进港', 'in_transit'],
    ['InTransit_Other', '航空公司接收', 'in_transit'],
    ['InTransit_PickedUp', '中国邮政已收取邮件', 'accepted'],
    ['InTransit_CustomsProcessing', '送交出口海关', 'customs'],
    ['InTransit_CustomsReleased', '出口海关/放行', 'in_transit'],
    ['InTransit_CustomsRequiringInformation', '等待清关资料', 'customs'],
    ['Exception_Delayed', '运输延误', 'exception'],
    ['Exception_Returning', '退回中', 'exception'],
    ['Exception_Returned', '已退回', 'returned'],
    ['OutForDelivery_Other', '正在投递', 'out_for_delivery'],
    ['Delivered_Other', '已妥投', 'delivered'],
  ])('uses %s with a null stage independently of scan language', (code, description, stage) => {
    const result = parse17TrackResponse(postalHistory([postalScan(code, description)]), number);
    expect(result.current_stage).toBe(stage);
    expect(result.events?.[0]).toMatchObject({ stage, provider_code: code,
      reporting_carrier: 'China Post', reporting_carrier_key: 3011,
      time_provenance: 'provider_inferred', provider_time_iso: '2026-09-20T12:22:00+08:00' });
    expect(result.events?.[0]?.description).toBe(stage === 'delivered' ? 'Delivered' : description);
  });

  it('does not convert stale tracking or unknown codes into shipment progress', () => {
    expect(parse17TrackResponse(postalHistory([postalScan('Future_Unknown')]), number).current_stage).toBe('pending');
    expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other')]), number).status).toBe('in_transit');
    expect(parse17TrackResponse(postalHistory([postalScan('Delivered_Other', 'Not delivered')]), number).current_stage).toBe('failed_attempt');
    expect(parse17TrackResponse(postalHistory([postalScan('Delivered_Other', 'Delivered to local carrier')]), number).current_stage).toBe('in_transit');
    expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other', 'Returned to sender')]), number).current_stage).toBe('returned');
  });

  it('keeps dated history when explanatory rows have no dates, without inventing timestamps', () => {
    const result = parse17TrackResponse(postalHistory([
      { ...postalScan('InTransit_Other'), time_iso: null, time_utc: null, time_raw: { date: null, time: null, timezone: null } },
      { ...postalScan('Delivered_Other', 'Delivered'), time_raw: { timezone: '+08:00' } },
    ]), number);
    expect(result).toMatchObject({ current_stage: 'delivered', undated_event_count: 1 });
    expect(result.events).toHaveLength(1);
    expect(result.events?.[0]?.time_provenance).toBe('carrier_reported');
    expect(() => parse17TrackResponse(postalHistory([{ ...postalScan('InTransit_Other'), time_utc: 'broken' }]), number))
      .toThrow('invalid tracking event');
  });

  it('reads DHL Express scans on their facility\'s clock, not on the one offset 17TRACK gives the parcel', () => {
    // Public shape: every scan stamped with the destination's offset, the facility's clock in time_raw.
    const scan = (date: string, time: string, location: string, description = 'Processed') => ({
      time_iso: `${date}T${time}+02:00`, time_utc: `${date}T${time}Z`, time_raw: { date, time, timezone: null },
      description, location, stage: null, sub_status: 'InTransit_Other' });
    const reply = (events: Record<string, unknown>[], name = 'DHL Express'): Payload => ({ meta: { code: 200 }, shipments: [{ number, code: 200,
      shipment: { latest_status: { status: 'InTransit' }, tracking: { providers: [{ provider: { key: 100001, name }, events }] } } }] });
    const result = parse17TrackResponse(reply([
      scan('2026-10-05', '09:13:00', 'EXAMPLE CITY - ITALY'),
      scan('2026-10-04', '17:34:00', 'EXAMPLE CITY - HONG KONG SAR, CHINA'),
      scan('2026-10-04', '11:13:00', 'EXAMPLE CITY - CHINA, PEOPLES REPUBLIC'),
      scan('2026-10-04', '09:20:00', 'EXAMPLE CITY - THE PEOPLE\'S REPUBLIC OF CHINA'),
      scan('2026-10-03', '18:00:00', 'EXAMPLE CITY - EXAMPLELAND'),
    ]), number);
    expect(result.events?.map((event) => event.time)).toEqual([
      '2026-10-05T07:13:00.000Z', '2026-10-04T09:34:00.000Z', '2026-10-04T03:13:00.000Z', '2026-10-04T01:20:00.000Z']);
    // The provider's own reading stays on the scan; a facility it cannot place is counted, not dated.
    expect(result.undated_event_count).toBe(1);
    expect(result.events?.[0]).toMatchObject({ provider_time_iso: '2026-10-05T09:13:00+02:00', time_provenance: 'provider_inferred' });
    // Unplaced as the latest scan, the reply cannot say where the parcel is.
    expect(carrierErrorKind(thrown(() => parse17TrackResponse(reply([
      scan('2026-10-05', '09:13:00', 'EXAMPLE CITY - EXAMPLELAND'), scan('2026-10-04', '09:20:00', 'EXAMPLE CITY - ITALY'),
    ]), number)))).toBe('indeterminate');
    // Another carrier's scans keep 17TRACK's reading: the clock and offset it shows.
    expect(parse17TrackResponse(reply([scan('2026-10-04', '17:34:00', 'EXAMPLE CITY - HONG KONG SAR, CHINA')], 'Example Parcel Co'), number)
      .events?.[0]?.time).toBe('2026-10-04T15:34:00.000Z');
  });

  it('reads the clock and offset 17TRACK shows when its UTC conversion disagrees', () => {
    // An India Post leg: the wall clock under India's offset, and a conversion 30 minutes after it.
    const scan = { time_iso: '2026-07-14T14:40:00+05:30', time_utc: '2026-07-14T09:40:00Z',
      time_raw: { date: '2026-07-14', time: '14:40:00', timezone: null },
      description: 'Item received', location: 'EXAMPLE OFFICE', stage: null, sub_status: 'InTransit_Other' };
    const reply: Payload = { meta: { code: 200 }, shipments: [{ number, code: 200, shipment: { latest_status: { status: 'InTransit' },
      tracking: { providers: [{ provider: { key: 9021, name: 'India Post' }, events: [scan] }] } } }] };
    expect(parse17TrackResponse(reply, number).events?.[0]).toMatchObject({
      time: '2026-07-14T09:10:00.000Z', provider_time_iso: '2026-07-14T14:40:00+05:30',
      reporting_carrier: 'India Post', time_provenance: 'provider_inferred',
    });
    // Agreeing readings, or a shown clock without an offset, leave time_utc in charge.
    const utc = (overrides: Record<string, unknown>) =>
      parse17TrackResponse(postalHistory([{ ...postalScan('InTransit_Other'), ...overrides }]), number).events?.[0]?.time;
    expect(utc({})).toBe('2026-09-20T04:22:00.000Z');
    expect(utc({ time_iso: '2026-09-20T12:22:00' })).toBe('2026-09-20T04:22:00.000Z');
    expect(utc({ time_iso: null })).toBe('2026-09-20T04:22:00.000Z');
    expect(utc({ time_utc: null })).toBe('2026-09-20T04:22:00.000Z');
    expect(() => utc({ time_utc: 'broken' })).toThrow('invalid tracking event');
  });

  it('requires a completed identity-matched NotFound and an empty history for a negative answer', () => {
    expect(thrown(() => parse17TrackResponse(postalHistory([], 'NotFound'), number)))
      .toMatchObject({ name: 'NotFoundError', kind: 'not_found', status: 404 });
    expect(thrown(() => parse17TrackResponse(postalHistory([]), number))).not.toMatchObject({ kind: 'not_found' });
    expect(thrown(() => parse17TrackResponse(postalHistory([], 'NotFound'), 'OTHER123')))
      .toMatchObject({ kind: 'schema' });
    expect(parse17TrackResponse(postalHistory([postalScan('InTransit_Other')], 'NotFound'), number).current_stage).toBe('in_transit');
  });

  it('distinguishes a matching no-history reply from request failure, polling and an invalid number', () => {
    expect(thrown(() => parse17TrackResponse(noHistory(), number)))
      .toMatchObject({ name: 'SeventeenTrackNoHistoryError', kind: 'indeterminate', status: 502, reason: 'no_history', providerCode: 400 });
    expect(thrown(() => parse17TrackResponse({ meta: { code: 400 }, shipments: [] }, number)))
      .toMatchObject({ name: 'SeventeenTrackLookupError', kind: 'transport', reason: 'lookup_unavailable', providerCode: 400 });
    expect(thrown(() => parse17TrackResponse({ meta: { code: 200 }, shipments: [{ number, code: 100, shipment: null }] }, number)))
      .toMatchObject({ name: 'SeventeenTrackLookupError', kind: 'transport', reason: 'lookup_pending', providerCode: 100 });
  });

  it.each([
    { params_v2: [{ key: 'postal_code', input_type: 'Text' }] },
    { param: { type: 'PostalCode' } },
    { params: [{ type: 'PostalCode' }] },
  ])('relays a matching postcode prompt without inferring that a supplied postcode worked: %j', fields => {
    const payload = { meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null, ...fields }] };
    expect(thrown(() => parse17TrackResponse(payload, number))).toMatchObject({ kind: 'input_required', provider: '17TRACK', field: 'postcode' });
    expect(thrown(() => parse17TrackResponse(payload, number, '8000'))).toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
    expect(thrown(() => parse17TrackResponse(payload, 'OTHER123'))).toMatchObject({ kind: 'schema' });
    expect(thrown(() => parse17TrackResponse({ ...payload, shipments: [...payload.shipments, ...payload.shipments] }, number))).toMatchObject({ kind: 'schema' });
  });

  it('keeps history ahead of optional postcode metadata and ignores other requested inputs', () => {
    const payload = history();
    payload.shipments[0]!.params_v2 = [{ key: 'postal_code' }];
    expect(parse17TrackResponse(payload, number).current_stage).toBe('delivered');
    for (const fields of [{ params_v2: [{ key: 'phone_number_last_4' }] }, { param: { type: 'ShipDate' } },
      { params_v2: [], param: { type: 'PostalCode' } }]) {
      expect(thrown(() => parse17TrackResponse({ meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null, ...fields }] }, number)))
        .toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
    }
  });

  it('does not infer no history from another identity, ambiguity, an unknown code or an unexpected payload', () => {
    for (const payload of [noHistory('OTHER123'), { ...noHistory(), shipments: [noHistory().shipments[0], noHistory().shipments[0]] }]) {
      expect(thrown(() => parse17TrackResponse(payload, number))).toMatchObject({ kind: 'schema' });
    }
    for (const shipment of [{ number, code: 500, shipment: null }, { number, code: 400 }, { number, code: 400, shipment: {} }]) {
      expect(thrown(() => parse17TrackResponse({ meta: { code: 200 }, shipments: [shipment] }, number)))
        .toMatchObject({ name: 'SeventeenTrackLookupError', kind: 'transport' });
    }
  });

  it('uses matching history, keeps the reported carrier and scan places, and strips recipient data', () => {
    const result = parse17TrackResponse(delivered, number);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', tracking_provider: '17TRACK',
      last_update: '2026-08-31T18:50:50.000Z' });
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', description: 'Delivered' });
    expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery', time: '2026-08-31T17:12:44.000Z',
      location: 'EXAMPLE TOWN, CH' });
    // A place holding private delivery details is dropped, and the street-level address never read.
    expect(result.events?.[0]?.location).toBeUndefined();
    expect(result).toMatchObject({ reported_carriers: ['Swiss Post'], discovered_carrier: 'swiss-post' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('rejects demos, ambiguity, unfinished polling and verification errors', () => {
    const ambiguous: Payload = { ...delivered, shipments: [delivered.shipments[0]!, delivered.shipments[0]!] };
    for (const payload of [history('TestNumber00017'), ambiguous, { meta: { code: 400 }, shipments: [] }]) {
      expect(() => parse17TrackResponse(payload, number)).toThrow();
    }
    expect(thrown(() => parse17TrackResponse({ meta: { code: -14 }, shipments: [] }, number)))
      .toMatchObject({ name: 'SeventeenTrackVerificationError', reason: 'verification_required', providerCode: -14, status: 403 });
    expect(thrown(() => parse17TrackResponse({ meta: { code: 200 }, shipments: [{ number, code: 100 }] }, number)))
      .toMatchObject({ name: 'SeventeenTrackLookupError', reason: 'lookup_pending', providerCode: 100 });
  });
});

describe('17TRACK browser capture', () => {
  it('preserves completed not-found and malformed matching history errors through capture', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(postalHistory([], 'NotFound')));
    await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject({ kind: 'not_found' });
    fetcher.mockResolvedValue(captured(postalHistory([{ ...postalScan('InTransit_Other'), time_utc: 'broken' }])));
    await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject({ kind: 'schema' });
  });
  it('asks the browser service for the page and reads its captured API response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(delivered));
    await expect(tracker(fetcher, 'http://browser.test/v1').fetch(number)).resolves.toMatchObject({ tracking_provider: '17TRACK' });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://browser.test/scrape');
    expect(JSON.parse(String(options!.body))).toMatchObject({
      url: `https://t.17track.net/en#nums=${number}`, skipHttp: true, maxTier: 3,
      captureResponses: [API], settleTimeout: 15_000,
    });
    expect(Number.isInteger(JSON.parse(String(options!.body)).maxTimeout)).toBe(true);
  });

  it('forwards adapter input, accepts a bound postcode reply, and records a prompt through telemetry', async () => {
    const prompt = { meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null, params_v2: [{ key: 'postal_code' }] }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(prompt));
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const provider = adapter({ trawl: new TrawlClient('http://browser.test', fetcher), recorder, env: {}, browserExecutablePath: null });
    await expect(provider.track({ number, postcode: null, timezone: null })).rejects.toMatchObject({ kind: 'input_required', field: 'postcode' });
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'input_required', errorType: 'InputRequiredError' }));
    const url = `https://t.17track.net/en#nums=${number}&trawl-postcode=AB1%202CD`;
    fetcher.mockResolvedValue(captured(null, { url, capturedResponses: [
      { url: API, status: 200, body: JSON.stringify(prompt) },
      { url: API, status: 200, body: JSON.stringify(delivered), postcodeSubmitted: true },
    ] }));
    await expect(provider.track({ number, postcode: ' ab1  2cd ', timezone: null })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body)).url).toBe(url);
    fetcher.mockResolvedValue(captured(null, { url, capturedResponses: [
      { url: API, status: 200, body: JSON.stringify(prompt), postcodeSubmitted: true },
    ] }));
    await expect(provider.track({ number, postcode: 'AB1 2CD', timezone: null })).rejects.toMatchObject({ name: 'SeventeenTrackNoHistoryError' });
  });

  it('does not silently claim a postcode retry when the browser service ignored it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(noHistory(), { url: `https://t.17track.net/en#nums=${number}&trawl-postcode=8000` }));
    await expect(tracker(fetcher).fetch(number, undefined, undefined, '8000')).rejects.toMatchObject({ kind: 'transport', reason: 'postcode_not_submitted' });
    fetcher.mockClear();
    await expect(tracker(fetcher).fetch(number, undefined, undefined, '<script>8000')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('needs the browser service and never requests an arbitrary user URL', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SeventeenTrackTracker().fetch(number)).rejects.toThrow('tracking browser service');
    await expect(tracker(fetcher).fetch('http://localhost')).rejects.toThrow('Invalid tracking number');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects redirected, unsolved, truncated and binary pages', async () => {
    for (const overrides of [{ url: 'https://evil.test/' }, { statusCode: 403 }, { tier: 1 }, { error: 'browser failed' },
      { capturedResponses: [{ url: API, body: JSON.stringify(delivered), status: 200, truncated: true }] },
      { capturedResponses: [{ url: API, body: JSON.stringify(delivered), status: 200, base64Encoded: true }] }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(delivered, overrides));
      await expect(tracker(fetcher).fetch(number)).rejects.toThrow();
    }
  });

  it('distinguishes missing capture capability, unreadable bodies and provider lookup failures', async () => {
    for (const [data, overrides, expected] of [
      [null, { capturedResponses: undefined }, { name: 'TrackingCaptureError', reason: 'capture_missing' }],
      [null, { capturedResponses: [{ url: API, status: 200, body: null, error: 'compressed gzip body was not read safely' }] },
        { name: 'TrackingCaptureError', reason: 'capture_unreadable' }],
      [null, { capturedResponses: [{ url: 'https://t.17track.net/other', status: 200, body: '{}' }] },
        { name: 'TrackingCaptureError', reason: 'history_missing' }],
      [{ meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null }] }, {},
        { name: 'SeventeenTrackNoHistoryError', kind: 'indeterminate', reason: 'no_history', providerCode: 400 }],
      [{ meta: { code: -14 }, shipments: [] }, {}, { name: 'SeventeenTrackVerificationError', providerCode: -14 }],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(data, overrides));
      await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject(expected);
    }
  });

  it('reports no history through telemetry and accepts a later completed history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(noHistory()));
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const adapter = new SeventeenTrackTracker({ trawl: new TrawlClient('http://browser.test', fetcher), recorder });
    await expect(adapter.fetch(number)).rejects.toMatchObject({ name: 'SeventeenTrackNoHistoryError', kind: 'indeterminate' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'indeterminate', errorType: 'SeventeenTrackNoHistoryError' }));
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'indeterminate', errorType: 'SeventeenTrackNoHistoryError' }));
    fetcher.mockResolvedValue(captured(null, { capturedResponses: [
      { url: API, status: 200, body: JSON.stringify(noHistory()) },
      { url: API, status: 200, body: JSON.stringify(delivered) },
    ] }));
    await expect(adapter.fetch(number)).resolves.toMatchObject({ tracking_provider: '17TRACK', current_stage: 'delivered' });
  });

  it('accepts completed matching history after intermediate polling and keeps the API Retry-After', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(captured(null, { capturedResponses: [
      { url: API, status: 200, body: JSON.stringify({ meta: { code: 200 }, shipments: [{ number, code: 100 }] }) },
      { url: API, status: 200, body: JSON.stringify(delivered) },
    ] }));
    await expect(tracker(fetcher).fetch(number)).resolves.toMatchObject({ tracking_provider: '17TRACK' });
    fetcher.mockResolvedValue(captured(null, { capturedResponses: [
      { url: API, status: 429, body: null, headers: { 'retry-after': '300' } },
    ] }));
    await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 429, retryAfterMs: 300_000 });
    fetcher.mockResolvedValue(captured(null, { capturedResponses: [{ url: API, status: 503, body: null }] }));
    await expect(tracker(fetcher).fetch(number)).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
  });
});
