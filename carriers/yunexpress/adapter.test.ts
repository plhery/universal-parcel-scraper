import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient, type TrawlScrapeResponse } from '../../core/transport/index.js';
import { adapter, parse, parseCaptured, YunExpressTracker } from './adapter.js';
import { InvalidInputError } from '../../core/errors/index.js';
import statuses from './statuses.json' with { type: 'json' };
import { yunExpressCodeStatus, yunExpressStatus } from './status.js';

const NUMBER = 'YT0000000000000001';
const API = 'https://services.yuntrack.com/Track/Query';
const fixture = (name = 'in-transit') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const captured = (body = fixture()): TrawlScrapeResponse => ({ url: 'https://www.yuntrack.com/parcelTracking', html: '<div>Tracking results</div>', tier: 2,
  statusCode: 200, userAgent: null, cookies: [], raw: {}, capturedResponses: [{ url: API, status: 200, headers: {}, body: JSON.stringify(body), base64Encoded: false, truncated: false, error: null }] });

describe('YunExpress captured response projection', () => {
  it('binds both result identities and preserves per-event clock evidence', () => {
    const result = normalizeCarrierResult(parse(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', last_update: '2026-03-20T13:39:00-04:00',
      destination_country: 'US', delivery_tracking_number: '9000000000000000000001' });
    expect(result.events).toHaveLength(14);
    expect(result.events?.[0]).toMatchObject({ time: '2026-03-20T13:39:00-04:00', location: 'Example facility' });
    expect(result.events?.[1]).toMatchObject({ local_time: '2026-03-19T13:39:00' });
    expect(result.events?.[1]!.time).toBeUndefined();
    expect(result.events?.at(-1)?.stage).toBe('registered');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each(['description', 'location', 'clock', 'missing summary'])('rejects a latest %s mismatch instead of returning older progress', mode => {
    const payload = fixture();
    const item = payload.ResultList[0];
    if (mode === 'description') item.TrackInfo.LastTrackEvent.ProcessContent = 'Different description';
    if (mode === 'location') item.TrackInfo.LastTrackEvent.ProcessLocation = 'Different facility';
    if (mode === 'clock') item.TrackInfo.LastTrackEvent.ProcessDate = '2026-03-20T13:40:00';
    if (mode === 'missing summary') delete item.TrackInfo.LastTrackEvent;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('maps an explicit delivered latest-event code without promoting earlier partner scans', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    item.Status = item.TrackInfo.TrackingStatus = item.TrackInfo.LastTrackEvent.TrackingStatus = 50;
    item.TrackInfo.LastTrackEvent.ProcessContent = 'Delivered by Mailbox, synthetic delivery note';
    item.TrackData.ProcessGroupList[0].ProcessDetailList[0].ProcessContent = 'Delivered by Mailbox, synthetic delivery note----Example facility';
    const result = parse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-03-20T13:39:00-04:00' });
    expect(result.events?.[1]!.stage).toBe('in_transit');
    item.TrackInfo.LastTrackEvent.ProcessContent = 'Different description';
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('stages the destination leg, and a hand-over to the local carrier is no delivery', () => {
    expect(yunExpressStatus('Delivered to local carrier')).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(yunExpressStatus('Package accepted at courier partner')).toEqual({ status: 'in_transit', stage: 'in_transit' });
    expect(yunExpressStatus('Arrived at GOFO Regional Destination Facility')?.stage).toBe('in_transit');
    expect(yunExpressStatus('The driver is out for delivery')?.stage).toBe('out_for_delivery');
    // Yuntrack's capitals and spacing vary; the wording does not.
    expect(yunExpressStatus('arrived at  SORT facility ')?.stage).toBe('in_transit');
    expect(yunExpressStatus('Delivered')).toBeUndefined();
  });

  it('requires a unique returned number and matching waybill identity', () => {
    const payload = fixture();
    payload.ResultList[0].TrackInfo.WaybillNumber = 'YT0000000000000002';
    expect(() => parse(payload, NUMBER)).toThrow('identity');
    payload.ResultList[0].TrackInfo.WaybillNumber = NUMBER;
    payload.ResultList.push(payload.ResultList[0]);
    expect(() => parse(payload, NUMBER)).toThrow('ambiguous');
  });

  it('recognizes only explicit missing-item records and separates interactive verification', () => {
    expect(() => parse(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const payload = fixture();
    payload.ResultList[0].TrackData.ProcessGroupList = [];
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ Code: 1003 }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parse({ ResultList: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['count absent', 'count positive', 'summary populated', 'child parcel', 'last status absent'])('keeps an incomplete negative %s indeterminate', mode => {
    const payload = fixture('not-found');
    const item = payload.ResultList[0];
    if (mode === 'count absent') delete item.TrackInfo.TrackEventCount;
    if (mode === 'count positive') item.TrackInfo.TrackEventCount = 1;
    if (mode === 'summary populated') item.TrackInfo.LastTrackEvent.ProcessContent = 'Shipment information received';
    if (mode === 'child parcel') item.TrackData.ChildCount = 1;
    if (mode === 'last status absent') delete item.TrackInfo.LastTrackEvent.TrackingStatus;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects mismatched history even when every scan already carries an explicit offset', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    for (const group of item.TrackData.ProcessGroupList) for (const scan of group.ProcessDetailList) scan.ProcessDate += '-04:00';
    item.TrackInfo.LastTrackEvent.ProcessDate += '-04:00';
    item.TrackInfo.LastTrackEvent.ProcessLocation = 'Different facility';
    expect(() => parseCaptured(captured(payload), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('compares full latest text before applying output length limits', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    const prefix = 'A'.repeat(520);
    item.TrackData.ProcessGroupList[0].ProcessDetailList[0].ProcessContent = `${prefix}first----Example facility`;
    item.TrackInfo.LastTrackEvent.ProcessContent = `${prefix}other`;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('skips an older row that has a place but no wording', () => {
    const payload = fixture();
    const rows = payload.ResultList[0].TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: unknown[] }) => group.ProcessDetailList);
    rows[3].ProcessContent = '----Example airport';
    const result = parse(payload, NUMBER);
    expect(result.events).toHaveLength(13);
    expect(result.events?.some((event) => !event.description)).toBe(false);
  });

  it('keeps a dash given as the place out of a relayed line, newest or older', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    const rows = item.TrackData.ProcessGroupList.flatMap((group: { ProcessDetailList: unknown[] }) => group.ProcessDetailList);
    const preAdvice = 'Order information received. We\'re expecting your parcel to arrive with us.';
    rows[13].ProcessContent = `${preAdvice}-----`;
    const older = parse(payload, NUMBER);
    expect(older.events?.[13]).toMatchObject({ description: preAdvice, location: '', stage: 'registered' });
    // The latest scan's own record gives the dash as its place.
    rows[0].ProcessContent = `${preAdvice}-----`;
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessContent: preAdvice, ProcessLocation: '-' });
    const newest = parse(payload, NUMBER);
    expect(newest).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: preAdvice });
    expect(newest.events?.[0]).toMatchObject({ description: preAdvice, location: '', time: '2026-03-20T13:39:00-04:00' });
    rows[0].ProcessContent = 'Customs inspection - Import----Example facility';
    rows[13].ProcessContent = 'Shipment information received----Example-facility';
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessContent: 'Customs inspection - Import', ProcessLocation: 'Example facility' });
    expect(parse(payload, NUMBER).events?.[13]).toMatchObject({ description: 'Shipment information received', location: 'Example-facility' });
    // A wording that ends in a dash before an empty place, as its latest-scan record gives it.
    rows[0].ProcessContent = 'Arrived at sorting center -----';
    Object.assign(item.TrackInfo.LastTrackEvent, { ProcessContent: 'Arrived at sorting center -', ProcessLocation: '' });
    expect(parse(payload, NUMBER).events?.[0]).toMatchObject({ description: 'Arrived at sorting center -', location: '' });
  });

  it('names the last-mile carrier its notes link to only when that carrier offers the reference', () => {
    const payload = fixture();
    const info = payload.ResultList[0].TrackInfo;
    info.TrackingNumber = 'GFUS01000000000001';
    info.AdditionalNotes = '<p>Last Mile Website:</p><p><a href="https://www.gofo.com/" target="_blank">https://www.gofo.com</a></p>';
    expect(parse(payload, NUMBER)).toMatchObject({ delivery_carrier: 'gofo', delivery_tracking_number: 'GFUS01000000000001' });
    // The same brand's host also serves networks outside the carrier's scope.
    info.TrackingNumber = 'GFFR00000000000001';
    const regional = parse(payload, NUMBER);
    expect(regional.delivery_carrier).toBeUndefined();
    expect(regional.delivery_tracking_number).toBe('GFFR00000000000001');
    info.TrackingNumber = 'GFUS01000000000001';
    info.AdditionalNotes += '<p><a href="https://tracking.dpd.de/">https://tracking.dpd.de</a></p>';
    expect(parse(payload, NUMBER).delivery_carrier).toBeUndefined();
    info.AdditionalNotes = '<p><a href="https://www.example.com/">https://www.example.com</a></p>';
    expect(parse(payload, NUMBER).delivery_carrier).toBeUndefined();
  });

  it('files every recorded wording under its recorded stage', () => {
    for (const entry of statuses.entries) {
      if (!entry.wording) expect(yunExpressCodeStatus(Number(entry.code)), entry.code).toBeDefined();
      else expect(yunExpressStatus(entry.wording, entry.code === undefined ? undefined : Number(entry.code))?.stage, entry.wording).toBe(entry.stage);
    }
  });

  it('takes the status from the latest code when the newest wording is new, without staging it', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    item.TrackInfo.LastTrackEvent.ProcessContent = 'Synthetic partner wording';
    item.TrackData.ProcessGroupList[0].ProcessDetailList[0].ProcessContent = 'Synthetic partner wording----Example facility';
    item.TrackInfo.LastTrackEvent.TrackingStatus = 20;
    const transit = parse(payload, NUMBER);
    expect(transit.status).toBe('in_transit');
    expect(transit.current_stage).toBeUndefined();
    expect(transit.events?.[0]!.stage).toBeUndefined();
    item.TrackInfo.LastTrackEvent.TrackingStatus = 60;
    expect(parse(payload, NUMBER).status).toBe('unknown');
  });

  it('leaves a relayed notice without a stage and the status to the scan before it', () => {
    const payload = fixture();
    const item = payload.ResultList[0];
    const [newest, previous] = [item.TrackData.ProcessGroupList[0].ProcessDetailList[0], item.TrackData.ProcessGroupList[1].ProcessDetailList[0]];
    newest.ProcessContent = 'REMINDER EMAIL SENT FAILED----Example facility';
    previous.ProcessContent = 'DELIVERING, WAIT FOR CONSIGNEE PICK UP----Example facility';
    item.TrackInfo.LastTrackEvent.ProcessContent = 'REMINDER EMAIL SENT FAILED';
    item.TrackInfo.LastTrackEvent.TrackingStatus = 20;
    const waiting = parse(payload, NUMBER);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_status_text: 'REMINDER EMAIL SENT FAILED' });
    expect(waiting.events?.[0]!.stage).toBeUndefined();
    expect(waiting.events?.[1]!.stage).toBe('ready_for_pickup');
    // A delivery before the notice is no delivery at the notice's time.
    previous.ProcessContent = 'POD available----Example facility';
    const delivered = parse(payload, NUMBER);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(delivered.delivered_at).toBeUndefined();
  });

  it('rejects a projection that omits scans present in the raw history', () => {
    const payload = fixture();
    payload.ResultList[0].TrackData.ProcessGroupList.pop();
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each(['date', 'description', 'group'])('rejects invalid latest %s instead of promoting older progress', (mode) => {
    const payload = fixture();
    const groups = payload.ResultList[0].TrackData.ProcessGroupList;
    if (mode === 'date') groups[0].ProcessDetailList[0].ProcessDate = '2026-02-30T12:00:00';
    if (mode === 'description') groups[0].ProcessDetailList[0].ProcessContent = '';
    if (mode === 'group') groups[0].ProcessDetailList = null;
    expect(() => parse(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the final capture and propagates failures rather than replaying an older success', () => {
    const page = captured();
    page.capturedResponses.push({ ...page.capturedResponses[0]!, status: 403 });
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    page.capturedResponses.at(-1)!.status = 200;
    page.capturedResponses.at(-1)!.body = JSON.stringify({ ResultList: [] });
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('separates a missing, truncated or failed capture from an explicit unknown parcel', () => {
    const page = captured();
    page.capturedResponses[0]!.truncated = true;
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    page.capturedResponses[0]!.truncated = false;
    page.capturedResponses[0]!.body = 'invalid JSON';
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    page.capturedResponses = [];
    expect(() => parseCaptured(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'transport' }));
  });

  it('decodes an explicitly base64 encoded capture and proves each declared capability', () => {
    const page = captured();
    page.capturedResponses[0]!.body = Buffer.from(page.capturedResponses[0]!.body!).toString('base64');
    page.capturedResponses[0]!.base64Encoded = true;
    const result = parseCaptured(page, NUMBER);
    const delivered = fixture();
    const item = delivered.ResultList[0];
    item.Status = item.TrackInfo.TrackingStatus = item.TrackInfo.LastTrackEvent.TrackingStatus = 50;
    item.TrackInfo.TrackingNumber = 'GFUS01000000000001';
    item.TrackInfo.AdditionalNotes = '<a href="https://www.gofo.com/">GOFO</a>';
    const handed = parse(delivered, NUMBER);
    const checks: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.some((event) => event.location)),
      delivered_at: Boolean(handed.delivered_at), delivery_partner: Boolean(handed.delivery_carrier && handed.delivery_tracking_number) };
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    for (const capability of metadata.capabilities) expect(checks[capability], capability).toBe(true);
  });
});

describe('YunExpress browser execution', () => {
  it('selects configured local Chromium without an additional service attempt', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const launch = vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('Synthetic browser launch failure'));
    try {
      const instance = adapter({ trawl: new TrawlClient('http://127.0.0.1:8191', fetcher), browserExecutablePath: '/synthetic/chromium',
        fetcher, env: {}, recorder });
      expect(instance.steps).toEqual(['browser', 'trawl']);
      await expect(instance.track({ number: NUMBER })).rejects.toThrow('Synthetic browser launch failure');
      expect(launch).toHaveBeenCalledTimes(1);
      expect(fetcher).not.toHaveBeenCalled();
      expect(recorder.step).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ step: 'browser', outcome: 'error' }));
      expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1, stepsAvailable: 1 }));
    } finally { launch.mockRestore(); }
  });

  it('gives local Chromium its 60 s limit out of a longer budget', async () => {
    const goto = vi.fn(async (url: string, options: { timeout: number }) => { void url; void options; return { status: () => 503 }; });
    const browser = { newPage: vi.fn(async () => ({ on: vi.fn(), goto })), close: vi.fn(async () => {}) };
    const launch = vi.spyOn(chromium, 'launch').mockResolvedValue(browser as never);
    try {
      await expect(new YunExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER, { budgetMs: 90_000 }))
        .rejects.toMatchObject({ kind: 'transport', message: 'YunExpress tracking page is unavailable' });
      expect(launch).toHaveBeenCalledOnce();
      const timeout = goto.mock.calls[0]![1].timeout;
      expect(timeout).toBeGreaterThan(50_000);
      expect(timeout).toBeLessThanOrEqual(60_000);
      expect(browser.close).toHaveBeenCalledOnce();
    } finally { launch.mockRestore(); }
  });

  it('requests Trawl capture with a fresh page and bounded cancellation-aware timeout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(captured())));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const instance = adapter({ trawl: new TrawlClient('http://127.0.0.1:8191', fetcher), browserExecutablePath: null, fetcher, env: {}, recorder });
    await expect(instance.track({ number: NUMBER }, { budgetMs: 10_000.5 })).resolves.toMatchObject({ current_stage: 'customs' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:8191/scrape');
    expect(JSON.parse(String(init?.body))).toMatchObject({ url: `https://www.yuntrack.com/parcelTracking?id=${NUMBER}`, skipHttp: true,
      maxTier: 2, captureResponses: [API], settleTimeout: 5_000 });
    expect(Number.isInteger(JSON.parse(String(init?.body)).maxTimeout)).toBe(true);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok' }));
  });

  it('does not fabricate a direct result when browser runtime is unavailable', async () => {
    await expect(new YunExpressTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('rejects unsupported input and pre-abort before contacting Trawl', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = new YunExpressTracker({ trawl: new TrawlClient('http://127.0.0.1:8191', fetcher) });
    await expect(tracker.fetch('bad&number')).rejects.toThrow(InvalidInputError);
    await expect(tracker.fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
