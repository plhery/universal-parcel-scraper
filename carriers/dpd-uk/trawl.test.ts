import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient, type TrawlCapturedResponse } from '../../core/transport/trawl.js';
import { adapter, DpdUkTracker } from './adapter.js';
import { parseDpdUkHistory } from './parser.js';
import { dpdUkTrackingUrl } from './trawl.js';

const NUMBER = '15500000000001';
const CODE = `${NUMBER}*10000`;
const API = 'https://apis.track.dpd.co.uk/v1/';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const urls = {
  reference: `${API}reference?origin=PRTK&postcode=&referenceNumber=${NUMBER}`,
  detail: `${API}parcels/${CODE}?_=1795218132355`,
  events: `${API}parcels/${CODE}/parcelevents`,
};
type Kind = keyof typeof urls;
const bodyOf = (kind: Kind) => ({ reference: fixture().reference, detail: fixture().detail, events: fixture().history })[kind];
const entry = (kind: Kind, status = 200, overrides: Partial<TrawlCapturedResponse> = {}): TrawlCapturedResponse => ({
  url: urls[kind], status, body: [200, 404].includes(status) ? JSON.stringify(bodyOf(kind)) : null, headers: {}, error: null,
  truncated: false, base64Encoded: false, trackingNumberSubmitted: NUMBER, ...overrides,
});
const entries = () => [entry('reference'), entry('detail'), entry('events')];
const refused = (status = 403) => new Response(JSON.stringify({ error: { statusCode: status, error: 'Forbidden', message: 'Forbidden' } }), { status });

function site(captures: TrawlCapturedResponse[] = entries(), direct: (target: string) => Response = () => refused(), page: Record<string, unknown> = {}) {
  const scrapes: Record<string, unknown>[] = [];
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    if (String(target) !== 'https://browser.test/scrape') return direct(String(target));
    const request = JSON.parse(String(init?.body));
    scrapes.push(request);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ tier: 3, statusCode: 200, html: '', url: request.url, capturedResponses: captures, ...page });
  });
  const recorder = { ...NOOP_RECORDER, step: vi.fn() };
  const instance = adapter({ fetcher, recorder, trawl: new TrawlClient('https://browser.test'), env: {}, browserExecutablePath: null });
  return { instance, fetcher, recorder, scrapes };
}

describe('DPD UK browser recovery', () => {
  it('recovers a refused API read through the public page, bound to the whole number and issued code', async () => {
    const test = site();
    const result = await test.instance.track({ number: NUMBER });
    expect(result).toEqual(parseDpdUkHistory(fixture().detail, fixture().history, NUMBER, CODE));
    expect(test.instance.steps).toEqual(['direct', 'trawl']);
    expect(test.scrapes).toEqual([expect.objectContaining({ url: dpdUkTrackingUrl(NUMBER), skipHttp: true, maxTier: 3, captureResponses: [API] })]);
    expect(test.scrapes[0]!.maxTimeout).toBeLessThanOrEqual(25_000);
    expect(test.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dpd-uk', step: 'trawl', outcome: 'ok', fallbackReason: 'challenge' }));
  });

  it('recovers a refusal at any of the three reads, and names the read and the notice', async () => {
    const payload = fixture();
    for (const refusedAt of [0, 1, 2]) {
      let call = 0;
      const test = site(entries(), () => call++ === refusedAt ? refused(401)
        : Response.json([payload.reference, payload.detail, payload.history][call - 1]));
      await expect(test.instance.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
      const direct = test.recorder.step.mock.calls.find(([record]) => record.step === 'direct')![0];
      expect(direct).toMatchObject({ outcome: 'challenge' });
    }
    const error = await new DpdUkTracker({ fetcher: async () => refused() }).fetch(NUMBER).catch(caught => caught);
    expect(error).toMatchObject({ kind: 'challenge', status: 403, reason: 'api_denied', message: 'DPD UK refused the reference search with HTTP 403: "Forbidden"' });
    const page = await new DpdUkTracker({ fetcher: async () => new Response(`<html>${CODE}</html>`, { status: 403 }) }).fetch(NUMBER).catch(caught => caught);
    expect(page.message).toBe('DPD UK refused the reference search with HTTP 403: an HTML page');
    const handle = await new DpdUkTracker({ fetcher: async () => Response.json({ error: { message: `No parcel ${CODE}` } }, { status: 401 }) })
      .fetch(NUMBER).catch(caught => caught);
    expect(handle.message).toBe('DPD UK refused the reference search with HTTP 401');
  });

  it('opens no browser after a rate limit, an answer or without the time it needs', async () => {
    const limited = site(entries(), () => new Response('{}', { status: 429, headers: { 'Retry-After': '3030' } }));
    await expect(limited.instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3_030_000 });
    const missing = site(entries(), () => Response.json({ error: { statusCode: 404, error: 'Not Found', message: 'Your reference number could not be found' } }, { status: 404 }));
    await expect(missing.instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    const short = site();
    await expect(short.instance.track({ number: NUMBER }, { budgetMs: 20_000 })).rejects.toMatchObject({ kind: 'challenge', reason: 'api_denied' });
    for (const test of [limited, missing, short]) expect(test.scrapes).toEqual([]);
  });

  it('keeps the last bound read of each kind and classifies the browser read as over HTTP', async () => {
    const absent = { error: { statusCode: 404, error: 'Not Found', message: 'Your reference number could not be found' } };
    for (const [captures, expected] of [
      [[entry('reference', 403), ...entries()], { status: 'delivered' }],
      [[entry('reference', 403, { body: JSON.stringify({ error: { message: 'Forbidden' } }) })], { kind: 'challenge', reason: 'api_denied', message: 'DPD UK refused the reference search with HTTP 403: "Forbidden"' }],
      [[entry('reference'), entry('detail', 401)], { kind: 'challenge', message: 'DPD UK refused the parcel detail with HTTP 401' }],
      [[entry('reference', 404, { body: JSON.stringify(absent) })], { kind: 'not_found' }],
      [[entry('reference', 404, { body: '{}' })], { kind: 'transport' }],
      [[entry('reference'), entry('detail'), entry('events', 404)], { kind: 'transport' }],
      [[entry('reference', 429, { headers: { 'retry-after': '60' } })], { kind: 'rate_limited', retryAfterMs: 60_000 }],
      [[entry('reference'), entry('detail', 503)], { kind: 'maintenance' }],
      [[entry('reference'), entry('detail', 0)], { kind: 'transport' }],
      [[entry('reference'), entry('detail', 200, { truncated: true, body: null }), entry('events')], { kind: 'transport' }],
      [[entry('reference'), entry('detail', 200, { body: '<html>' }), entry('events')], { kind: 'schema' }],
      [[entry('reference')], { kind: 'transport', reason: 'capture_missing' }],
      [[entry('reference'), entry('detail')], { kind: 'transport', reason: 'capture_missing' }],
      [[], { kind: 'transport', reason: 'capture_missing' }],
    ] as const) {
      const answer = site([...captures]).instance.track({ number: NUMBER });
      if ('status' in expected) await expect(answer).resolves.toMatchObject(expected);
      else await expect(answer).rejects.toMatchObject(expected);
    }
  });

  it('refuses captures the service did not bind, and replies for another number or code', async () => {
    const other = '15500000000002';
    const unbound = entries().map(row => { const copy = { ...row }; delete copy.trackingNumberSubmitted; return copy; });
    await expect(site(unbound).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport', message: 'The browser service does not support bound DPD UK capture' });
    await expect(site(entries().map(row => ({ ...row, trackingNumberSubmitted: other }))).instance.track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    const reference = fixture().reference;
    reference.data[0].parcelNumber = other;
    await expect(site([entry('reference', 200, { body: JSON.stringify(reference) }), entry('detail'), entry('events')]).instance.track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    const otherCode = (kind: 'detail' | 'events') => entry(kind, 200, { url: urls[kind].replace(CODE, `${NUMBER}*20000`) });
    await expect(site([entry('reference'), otherCode('detail'), otherCode('events')]).instance.track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'transport', reason: 'capture_missing' });
    const detail = fixture().detail;
    detail.data.parcelCode = `${NUMBER}*20000`;
    await expect(site([entry('reference'), entry('detail', 200, { body: JSON.stringify(detail) }), entry('events')]).instance.track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('turns a browser read given up for time into the budget and keeps cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>(async target => String(target) === 'https://browser.test/scrape'
      ? Response.json({ error: 'Max tier reached without success', timings: [{ tier: 3, status: 'error', reason: 'DPD UK browser budget exhausted' }] }, { status: 500 })
      : refused());
    const tracker = new DpdUkTracker({ fetcher, trawl: new TrawlClient('https://browser.test') });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'budget' });
    const reason = new Error('Caller canceled');
    const controller = new AbortController();
    const cancelled = new DpdUkTracker({ trawl: new TrawlClient('https://browser.test'), fetcher: async target => {
      if (String(target) === 'https://browser.test/scrape') controller.abort(reason);
      return String(target) === 'https://browser.test/scrape' ? Response.json({ tier: 3, statusCode: 200, html: '', capturedResponses: entries() }) : refused();
    } });
    await expect(cancelled.fetch(NUMBER, { signal: controller.signal })).rejects.toBe(reason);
  });

  it('keeps recognition on HTTP', async () => {
    const test = site();
    await expect(test.instance.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(test.scrapes).toEqual([]);
  });
});
