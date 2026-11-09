import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JAndTBrTracker } from './adapter.js';
import { JT_BR_API, JT_BR_PAGE, parseJAndTBr } from './parser.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const NUMBER = '888746193820571', SERVICE = 'https://trawl.invalid';
const capture = (body: unknown = fixture(), extra: Record<string, unknown> = {}) => ({
  url: JT_BR_API, status: 200, trackingNumberSubmitted: NUMBER, body: JSON.stringify(body), headers: {}, ...extra,
});
function harness(rows = [capture()], extra: Record<string, unknown> = {}) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    url: `${JT_BR_PAGE}?waybillNo=${NUMBER}`, html: '', tier: 3, statusCode: 200, cookies: [], capturedResponses: rows, ...extra,
  }), { headers: { 'Content-Type': 'application/json' } }));
  const recorder = { ...NOOP_RECORDER, step: vi.fn() };
  return { fetcher, recorder, tracker: new JAndTBrTracker({ fetcher, recorder, env: {}, browserExecutablePath: null, trawl: new TrawlClient(SERVICE) }) };
}
describe('J&T Brazil guest history', () => {
  it('retains all source milestones and wall clocks while excluding private fields', () => {
    const result = parseJAndTBr(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-01-20T16:33:39' });
    expect(result.events).toHaveLength(10);
    expect(result.events!.map(e => e.stage)).toEqual(['delivered', 'out_for_delivery', 'out_for_delivery',
      'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted']);
    expect(result.events!.every(e => e.local_time && !e.time)).toBe(true);
    expect(result.summary_only).toBeUndefined(); expect(result.history_truncated).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private\.invalid|remark|signature|staff/i);
  });
  it('preserves stated offsets and rejects invalid clocks, including rows beyond the result cap', () => {
    const data = fixture(); data.data[0].details[0].scanTime = '2026-01-20 16:33:39-03:00';
    expect(parseJAndTBr(data, NUMBER).events![0]).toMatchObject({ time: '2026-01-20T16:33:39-03:00' });
    data.data[0].details = Array.from({ length: 101 }, () => ({ ...data.data[0].details[0] }));
    expect(parseJAndTBr(data, NUMBER)).toMatchObject({ history_truncated: true });
    data.data[0].details[100].scanTime = '2026-02-30 16:33:39';
    expect(() => parseJAndTBr(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it.each([
    (d: ReturnType<typeof fixture>) => { d.data[0].keyword += '1'; },
    (d: ReturnType<typeof fixture>) => { d.data.push(d.data[0]); },
    (d: ReturnType<typeof fixture>) => { d.succ = false; },
    (d: ReturnType<typeof fixture>) => { d.data[0].details[0].status = '<private>'; },
  ])('rejects changed identity and schema', change => {
    const data = fixture(); change(data);
    expect(() => parseJAndTBr(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it("keeps J&T's code in an untyped refusal's message, and names a reply for another waybill", () => {
    expect(() => parseJAndTBr({ code: 0, succ: false, data: null, failureKind: null }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema', message: expect.stringContaining('without success (code 0, succ false)') }));
    expect(() => parseJAndTBr({ code: '<b>', succ: null, data: null }, NUMBER)).toThrow(expect.objectContaining({ message: expect.stringContaining('(code string, succ null)') }));
    expect(() => parseJAndTBr({ code: 1, succ: true, data: null, identityMismatch: true }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema', message: expect.stringContaining('another waybill') }));
  });
  it('keeps empty successes inconclusive and typed refusals separate', () => {
    for (const data of [{ code: 1, succ: true, data: [] }, { code: 1, succ: true, data: [{ keyword: NUMBER, details: [] }] }]) {
      expect(() => parseJAndTBr(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
    for (const [failureKind, kind] of [['challenge', 'challenge'], ['rate_limited', 'rate_limited']]) {
      expect(() => parseJAndTBr({ failureKind }, NUMBER)).toThrow(expect.objectContaining({ kind }));
    }
    const d = fixture(); d.data[0].details[0].code = 999;
    expect(parseJAndTBr(d, NUMBER).events![0]!.stage).toBeUndefined();
  });
  it('uses supplied transport, whole submission binding and remaining browser budget', async () => {
    const h = harness(); await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SERVICE}/scrape`); expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init!.body))).toMatchObject({ url: `${JT_BR_PAGE}?waybillNo=${NUMBER}`,
      skipHttp: true, maxTier: 3, captureResponses: [JT_BR_API] });
    const body = JSON.parse(String(init!.body)); expect(body.maxTimeout).toBeLessThanOrEqual(90000);
    expect(h.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'j-and-t-br', step: 'trawl' }));
  });
  it.each([undefined, NUMBER + '7'])('requires the whole outgoing number on every captured reply', async trackingNumberSubmitted => {
    await expect(harness([capture(fixture(), { trackingNumberSubmitted })]).tracker.fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'schema' });
  });
  it('keeps a later refusal and its rate-limit window instead of returning an earlier success', async () => {
    await expect(harness([capture(), capture(null, { status: 429, headers: { 'Retry-After': '120' } })]).tracker.fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120000, status: 429 });
    await expect(harness([capture(), capture(null, { status: 403 })]).tracker.fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'challenge', status: 403 });
    const wrong = fixture(); wrong.data[0].keyword += '1';
    await expect(harness([capture(wrong), capture()]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
  it.each([
    [{ status: 404 }, 'transport'], [{ status: 410 }, 'transport'],
    [{ error: 'invalid-json' }, 'schema'], [{ truncated: true }, 'transport'],
    [{ error: 'body-read' }, 'transport'], [{ base64Encoded: true }, 'transport'],
  ])('keeps capture failures distinct', async (extra, kind) => {
    await expect(harness([capture(fixture(), extra)]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind });
  });
  it('does not start I/O without a browser, sufficient budget or an active signal', async () => {
    await expect(new JAndTBrTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const h = harness();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 24000 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(h.tracker.fetch('12345')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController(); controller.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('dispatches explicit native tracking and named handoffs without adding HTTP recognition', async () => {
    const h = harness();
    const a = adapter({ env: {}, browserExecutablePath: null, recorder: h.recorder, trawl: new TrawlClient(SERVICE), fetcher: h.fetcher });
    expect(a.recognize).toBeUndefined(); expect(a.recognizeWithBrowser).toBeUndefined();
    expect(hasDirectHandoffAdapter('j-and-t-br', NUMBER)).toBe(true);
    expect(hasDirectHandoffAdapter('j-and-t-br', '999746193820571')).toBe(false);
    expect(recognitionAskedCarriers(NUMBER, { hint: 'j-and-t-br', countryHint: 'BR' })).not.toContain('j-and-t-br');
    const result = await createTracker({ providers: [], trawlUrl: SERVICE, fetcher: h.fetcher }).track({ number: NUMBER, carrier: 'j-and-t-br' });
    expect(result).toMatchObject({ source: 'j-and-t-br', result: { current_stage: 'delivered' } });
    expect(result.result.events).toHaveLength(8);
  });
});
