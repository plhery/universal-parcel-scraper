import { describe, expect, it, vi } from 'vitest';
// The browser helper's reading of the public sample's reply (numbers.json), its rows grouped by status.
import fixture from './fixtures/delivered.json' with { type: 'json' };
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, PASAREX_RESULT, PasarexTracker, pasarexUrl } from './adapter.js';
import { normalizePasarexNumber, parsePasarex } from './parser.js';
import { pasarexStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = fixture.number;
const capture = (data: unknown = fixture, extra: Record<string, unknown> = {}) => ({ url: PASAREX_RESULT, status: 200, trackingNumberSubmitted: NUMBER,
  headers: {}, body: JSON.stringify(data), ...extra });
function harness(rows = [capture()], statusCode = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url: pasarexUrl(NUMBER), html: '', statusCode,
    tier: 3, cookies: [], capturedResponses: rows }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new PasarexTracker(environment) };
}

describe('PasarEX tracking', () => {
  it('puts the status groups\' rows in time order on their wall clocks', () => {
    const result = parsePasarex(fixture, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_update: null,
      last_update_local: '2026-08-13T15:31:03', last_status_text: 'Shipment delivered in perfect condition' });
    expect(result.events).toHaveLength(14);
    expect(result.events!.map(event => event.local_time)).toEqual([...result.events!.map(event => event.local_time)].sort().reverse());
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-08-07T13:51:01', stage: 'registered', description: 'Information (Manifest) of the shipment received.' });
    expect(result.events!.at(-1)).not.toHaveProperty('location');
    expect(result.events![1]).toMatchObject({ stage: 'out_for_delivery' });
    expect(result.events!.every(event => !event.time && event.stage_source === 'carrier_map')).toBe(true);
  });

  it.each(statuses.entries)('maps the wording $wording', entry => expect(pasarexStage(entry.wording)?.stage).toBe(entry.stage ?? undefined));

  it('leaves an arrangement with the recipient during the round without a stage, on purpose', () => {
    expect(statusMapAnswer({ carrier: 'pasarex', providerCode: null, description: 'A delivery agreement has been made with the consignee' }))
      .toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: 'pasarex', providerCode: null, description: 'No one at home at the time of delivery' }))
      .toEqual({ kind: 'mapped', stage: 'failed_attempt' });
  });

  it('rejects another number, an empty history and a bad clock', () => {
    expect(() => parsePasarex({ ...fixture, number: 'PSRTEST000001' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePasarex({ ...fixture, groups: [] }, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const row = fixture.groups[0]!.rows[0]!;
    for (const date of ['31/02/2026', '2026-08-13']) {
      expect(() => parsePasarex({ ...fixture, groups: [{ status: 'DELIVERED', rows: [{ ...row, date }] }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parsePasarex({ ...fixture, groups: [null] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the notice, verification, another shipment and an unread page apart', () => {
    for (const [kind, expected] of [['not_found', 'not_found'], ['challenge', 'challenge'], ['identity_mismatch', 'indeterminate'], ['unconfirmed', 'indeterminate'], ['schema', 'schema']]) {
      expect(() => parsePasarex({ kind }, NUMBER)).toThrow(expect.objectContaining({ kind: expected }));
    }
    expect(normalizePasarexNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    expect(() => normalizePasarexNumber('https://bad.invalid')).toThrow();
  });

  it('asks the browser service for the tracking page, bound to the whole number, within the budget', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ url: `https://tracking.pasarex.com/?awb=${NUMBER}`, skipHttp: true, maxTier: 3,
      captureResponses: [PASAREX_RESULT] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    await expect(harness([capture(fixture, { trackingNumberSubmitted: undefined })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    const c = new AbortController(); c.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: c.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(new PasarexTracker({ ...h.environment, trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('reads again through the configured proxy only after the checkbox was not passed', async () => {
    const page = (rows: unknown[]) => new Response(JSON.stringify({ url: pasarexUrl(NUMBER), html: '', statusCode: 200, tier: 3, cookies: [], capturedResponses: rows }),
      { headers: { 'content-type': 'application/json' } });
    const proxied = (first: unknown[], env: Record<string, string> = { PASAREX_BROWSER_PROXY_URL: 'http://proxy.invalid:8080' }) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page(first)).mockResolvedValue(page([capture()]));
      return { fetcher, tracker: new PasarexTracker({ fetcher, recorder: NOOP_RECORDER, env, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') }) };
    };
    const retried = proxied([]);
    await expect(retried.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    const bodies = retried.fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { proxy?: string });
    expect(bodies.map((body) => body.proxy)).toEqual([undefined, 'http://proxy.invalid:8080']);
    // A history, a rate limit or no proxy at all asks once.
    for (const [first, env] of [[[capture()], undefined], [[capture(null, { status: 429 })], undefined], [[], {}]] as const) {
      const once = proxied([...first], env);
      await once.tracker.fetch(NUMBER).catch(() => undefined);
      expect(once.fetcher).toHaveBeenCalledOnce();
    }
  });

  it('keeps refusals, rate limits and an unfinished checkbox apart from a history', async () => {
    await expect(harness([capture(null, { status: 429, headers: { 'retry-after': '120' } })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120000 });
    await expect(harness([capture(null, { status: 403 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { error: 'unexpected-redirect', body: null })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 0).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', message: expect.stringContaining('did not load') });
    await expect(harness([capture(null, { status: 404, body: null })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([], 404).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(harness([capture({ kind: 'not_found' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
