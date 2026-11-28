import { describe, expect, it, vi } from 'vitest';
import { NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import type { TrawlClient, TrawlCapturedResponse, TrawlScrapeRequest } from '../../core/transport/trawl.js';
import { adapter, inpostUkResult } from './adapter.js';
import { INPOST_UK_API, parseInpostUkReply } from './uk.js';

// Synthetic numbers and scans. The reply's shape follows InPost UK's tracking page script, which posts the number and
// its Turnstile token to /tracking/api and reads `status`, `data[].mainTrackingNumber`, `statusTitle` and `events`.
const UK = `JJD${'0'.repeat(15)}7`;
const PAGE = `https://inpost.co.uk/tracking/result?parcel_code=${UK}`;
const created = { eventCode: 'CRE.1001', eventTitle: 'Your parcel is on its way to InPost', timestamp: '2026-05-01T08:00:00+01:00', location: null };
const received = { eventCode: 'MMD.1001', eventTitle: 'We have your parcel', timestamp: '2026-05-02T09:00:00+01:00',
  location: { city: 'Exampletown', countryCode: 'GB' } };
const out = { eventCode: 'LMD.1001', eventTitle: 'Your parcel is out for delivery', timestamp: '2026-05-03T07:30:00+01:00',
  location: { city: 'Exampletown', countryCode: 'GB' } };
const delivered = { eventCode: 'EOL.1001', eventTitle: 'Delivered', timestamp: '2026-05-03T12:10:00+01:00', location: { city: 'Exampletown', countryCode: 'GB' } };

function reply(events: unknown[], overrides: Record<string, unknown> = {}) {
  return { status: 'ok', data: [{ mainTrackingNumber: UK, status: 'IN_TRANSIT_LAST_MILE', statusTitle: 'On its way', statusDescription: '',
    destination: { locationType: 'ADDRESS', countryCode: 'GB' }, events, ...overrides }] };
}

function hubParcel(details: unknown[], status = 'CRE.1001') {
  return { trackingNumber: UK, status, statusTitle: 'Parcel created', destination: { countryCode: 'GB' },
    trackingDetails: details };
}
const hubCreated = { status: 'CRE.1001', statusTitle: 'Parcel created', datetime: '2026-05-01T08:00:00+01:00' };
const notFoundProblem = { type: '/errors/external/not-found', title: 'NOT_FOUND', status: 404, instance: `/api/tracking/${UK}` };

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function trawlAnswering(rows: Partial<TrawlCapturedResponse>[], statusCode = 200) {
  const scrape = vi.fn(async (request: TrawlScrapeRequest) => ({
    url: request.url, html: '', cookies: [], userAgent: null, tier: 3, statusCode, raw: {},
    capturedResponses: rows.map((row) => ({ url: INPOST_UK_API, status: 200, headers: {}, body: null, truncated: false, base64Encoded: false,
      error: null, trackingNumberSubmitted: UK, ...row })),
  }));
  return { scrape, trawl: { scrape } as unknown as TrawlClient };
}

function instanceWith(hub: Response, trawl: TrawlClient | null) {
  const fetcher = vi.fn<typeof fetch>(async () => hub.clone());
  return { fetcher, instance: adapter({ fetcher, trawl, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER }) };
}

describe('InPost UK reply', () => {
  it('reads the parcel for the whole number, and the tracker\'s own not-found', () => {
    const parcel = parseInpostUkReply(reply([received, created]), UK);
    expect(parcel).toMatchObject({ status: 'IN_TRANSIT_LAST_MILE', destinationCountry: 'GB' });
    expect(parcel?.scans.map((scan) => [scan.code, scan.place])).toEqual([['MMD.1001', 'Exampletown (GB)'], ['CRE.1001', '']]);
    expect(parseInpostUkReply({ status: 'not_found' }, UK)).toBeNull();
    expect(() => parseInpostUkReply(reply([], { mainTrackingNumber: `JJD${'0'.repeat(15)}8` }), UK)).toThrow(SchemaError);
    expect(() => parseInpostUkReply({ status: 'failed' }, UK)).toThrow(TransportError);
    expect(() => parseInpostUkReply({ data: [] }, UK)).toThrow(SchemaError);
  });

  it('stages its scans by the hub\'s codes, the receipt after creation being the acceptance', () => {
    const accepted = inpostUkResult(parseInpostUkReply(reply([received, created]), UK)!);
    expect(accepted).toMatchObject({ status: 'in_transit', current_stage: 'accepted', destination_country: 'GB', last_status_text: 'On its way' });
    expect(accepted.events?.map((event) => [event.stage, event.time])).toEqual([['accepted', '2026-05-02T09:00:00+01:00'], ['registered', '2026-05-01T08:00:00+01:00']]);
    const done = inpostUkResult(parseInpostUkReply(reply([delivered, out, received, created], { status: 'DELIVERED' }), UK)!);
    expect(done).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-05-03T12:10:00+01:00' });
    // A clock without its offset says nothing of its zone: the scan is left out rather than placed.
    expect(inpostUkResult(parseInpostUkReply(reply([{ ...received, timestamp: '2026-05-02T09:00:00' }, created]), UK)!).current_stage).toBe('registered');
  });
});

describe('InPost UK step', () => {
  it('asks InPost UK\'s tracker when the hub knows the UK parcel by its creation alone', async () => {
    const { scrape, trawl } = trawlAnswering([{ body: JSON.stringify(reply([received, created])) }]);
    const { instance } = instanceWith(json(hubParcel([hubCreated])), trawl);
    const result = await instance.track({ number: UK });
    expect(result).toMatchObject({ current_stage: 'accepted' });
    expect(result.history_truncated).toBeUndefined();
    expect(scrape).toHaveBeenCalledOnce();
    expect(scrape.mock.calls[0]?.[0]).toMatchObject({ url: PAGE, skipHttp: true, captureResponses: [INPOST_UK_API] });
  });

  it('keeps the hub\'s partial answer when the tracker cannot be read or adds nothing', async () => {
    for (const rows of [[], [{ status: 403 }], [{ error: 'challenge-html' }], [{ trackingNumberSubmitted: `JJD${'0'.repeat(15)}8` }],
      [{ body: JSON.stringify(reply([created])) }], [{ status: 404, body: JSON.stringify({ status: 'not_found' }) }]]) {
      const { trawl } = trawlAnswering(rows);
      const { instance } = instanceWith(json(hubParcel([hubCreated])), trawl);
      await expect(instance.track({ number: UK })).resolves.toMatchObject({ current_stage: 'registered', history_truncated: true });
    }
  });

  it('finds a UK parcel the hub does not know, and leaves the hub\'s not-found when the tracker cannot say', async () => {
    const found = trawlAnswering([{ body: JSON.stringify(reply([out, received, created])) }]);
    await expect(instanceWith(json(notFoundProblem, 404), found.trawl).instance.track({ number: UK }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    const none = trawlAnswering([{ status: 404, body: JSON.stringify({ status: 'not_found' }) }]);
    await expect(instanceWith(json(notFoundProblem, 404), none.trawl).instance.track({ number: UK })).rejects.toThrow(NotFoundError);
    const blocked = trawlAnswering([]);
    await expect(instanceWith(json(notFoundProblem, 404), blocked.trawl).instance.track({ number: UK }))
      .rejects.toMatchObject({ name: 'NotFoundError', provider: 'InPost' });
    // A reply whose JSON contradicts its status proves nothing either way.
    const mismatch = trawlAnswering([{ status: 200, body: JSON.stringify({ status: 'not_found' }) }]);
    await expect(instanceWith(json(notFoundProblem, 404), mismatch.trawl).instance.track({ number: UK }))
      .rejects.toMatchObject({ provider: 'InPost' });
  });

  it('opens no browser for recognition, without the browser service, or for a hub answer with more than creation', async () => {
    const { scrape, trawl } = trawlAnswering([{ body: JSON.stringify(reply([received, created])) }]);
    const partial = instanceWith(json(hubParcel([hubCreated])), trawl);
    await expect(partial.instance.recognize!(UK)).resolves.toBeDefined();
    const moved = instanceWith(json(hubParcel([{ status: 'MMD.1001', statusTitle: 'Parcel at our warehouse', datetime: '2026-05-06T01:00:00+01:00' }, hubCreated], 'MMD.1001')), trawl);
    await expect(moved.instance.track({ number: UK })).resolves.toMatchObject({ current_stage: 'accepted' });
    expect(scrape).not.toHaveBeenCalled();
    const alone = instanceWith(json(hubParcel([hubCreated])), null);
    await expect(alone.instance.track({ number: UK })).resolves.toMatchObject({ history_truncated: true });
  });
});
