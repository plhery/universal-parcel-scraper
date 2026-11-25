import { describe, expect, it, vi } from 'vitest';
// The browser helper's reading of the public sample's reply (numbers.json): every scan, oldest first.
import fixture from './fixtures/forwarded.json' with { type: 'json' };
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, KUWAIT_POST_PAGE, KuwaitPostTracker, kuwaitPostUrl } from './adapter.js';
import { normalizeKuwaitPostNumber, parseKuwaitPost } from './parser.js';
import { kuwaitPostStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const capture = (data: unknown = fixture, extra: Record<string, unknown> = {}) => ({ url: KUWAIT_POST_PAGE, status: 200, trackingNumberSubmitted: NUMBER,
  headers: {}, body: JSON.stringify(data), ...extra });
function harness(rows: unknown[] = [capture()], statusCode = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url: kuwaitPostUrl(NUMBER), html: '', statusCode,
    tier: 3, cookies: [], capturedResponses: rows }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new KuwaitPostTracker(environment) };
}
const refusal = (message: string, extra: Record<string, unknown> = {}) => ({ success: false, message, data: [], ...extra });

describe('Kuwait Post tracking', () => {
  it('reads every post\'s scans newest first on their wall clocks', () => {
    const result = parseKuwaitPost(fixture, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_update: null,
      last_update_local: '2018-08-06T06:56:00', last_status_text: 'Receive item at office of exchange (Inb)', destination_country: 'CH' });
    expect(result.events).toHaveLength(7);
    expect(result.events!.map(event => event.local_time)).toEqual([...result.events!.map(event => event.local_time)].sort().reverse());
    expect(result.events![0]).toMatchObject({ location: 'ZURICH-URDORF, Switzerland' });
    expect(result.events![3]).toMatchObject({ local_time: '2017-09-06T10:13:36', location: 'PARCEL OFFICE OF EXCHANGE, Kuwait' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2017-08-21T15:30:00', stage: 'accepted', description: 'Receive item from customer (Otb)' });
    expect(result.events!.every(event => !event.time && event.stage_source === 'carrier_map')).toBe(true);
  });

  it.each(statuses.entries)('maps the wording $wording', entry => expect(kuwaitPostStage(entry.wording)?.stage).toBe(entry.stage));

  it('keeps non-delivery details and drops a repeated scan', () => {
    const row = { ...fixture.data[6]!, EVENT_TYPE_NM: 'Unsuccessful item delivery attempt (Inb)', NON_DELIVERY_REASON_NM: 'Addressee absent',
      NON_DELIVERY_MEASURE_NM: 'Item held at delivery office' };
    const result = parseKuwaitPost({ ...fixture, data: [...fixture.data, row, row] }, NUMBER);
    expect(result.events).toHaveLength(8);
    expect(result).toMatchObject({ current_stage: 'failed_attempt',
      last_status_text: 'Unsuccessful item delivery attempt (Inb): Addressee absent; Item held at delivery office' });
  });

  it('reads the tracker\'s refusals apart from a history', () => {
    expect(() => parseKuwaitPost(refusal('no_data_found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseKuwaitPost(refusal('captcha_invalid'), NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseKuwaitPost(refusal('rate_limit_exceeded', { retryAfterSeconds: 60 }), NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited', retryAfterMs: 60000 }));
    expect(() => parseKuwaitPost(refusal('tracking_unavailable'), NUMBER)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseKuwaitPost(refusal('something_else'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKuwaitPost({ success: true, message: '', data: [] }, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    for (const clock of ['2018-02-30 10:00:00.000', '2018-08-06T06:56:00Z', null]) {
      expect(() => parseKuwaitPost({ ...fixture, data: [{ ...fixture.data[0]!, EVENT_LOCAL_DT: clock }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseKuwaitPost({ ...fixture, data: 'unreadable' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeKuwaitPostNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    expect(() => normalizeKuwaitPostNumber(NUMBER.replace(/5CA$/, '4CA'))).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('asks the browser service for the tracker, bound to the whole item code, within the budget', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ destination_country: 'CH' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ url: `https://moc.gov.kw/en/shipment-tracking#${NUMBER}`, skipHttp: true,
      maxTier: 3, captureResponses: [KUWAIT_POST_PAGE] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    await expect(harness([capture(fixture, { trackingNumberSubmitted: undefined })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(), capture()]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    const c = new AbortController(); c.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: c.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(new KuwaitPostTracker({ ...h.environment, trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('keeps refusals, rate limits and an unfinished checkbox apart from a history', async () => {
    await expect(harness([capture(null, { status: 429, headers: { 'retry-after': '120' } })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120000 });
    await expect(harness([capture(null, { status: 403 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 404, body: null })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { status: 503, body: null })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(harness([capture(null, { error: 'challenge-html', body: null })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { error: 'invalid-reply', body: null })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 404).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(harness([], 0).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', message: expect.stringContaining('did not load') });
    await expect(harness([capture(refusal('no_data_found'))]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture(refusal('captcha_invalid'))]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });
});
