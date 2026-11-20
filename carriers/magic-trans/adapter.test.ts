import { describe, expect, it, vi } from 'vitest';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import inTransit from './fixtures/in-transit.json' with { type: 'json' };
import unknown from './fixtures/unknown.json' with { type: 'json' };
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { adapter, MagicTransTracker, magicTransPageUrl } from './adapter.js';
import { normalizeMagicTransNumber, parseMagicTrans } from './parser.js';
import { magicTransStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '021147139';
const URL = magicTransPageUrl(NUMBER);
const capture = (data: unknown = delivered, extra: Record<string, unknown> = {}) => ({ url: URL, status: 200, trackingNumberSubmitted: NUMBER,
  headers: {}, body: JSON.stringify(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'magic-trans-reply', statusCode = 200, url = URL) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url, html: '', statusCode,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new MagicTransTracker(environment) };
}

describe('Magic Trans tracker', () => {
  it('reads an issued cargo’s days newest first, the handover on the act’s clock', () => {
    const result = parseMagicTrans(delivered, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Груз выдан', last_update: null, last_update_local: '2025-07-23', expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2025-07-23', description: 'Выдача груза', location: 'Пятигорск', provider_code: 'issue', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2025-07-22', description: 'Прибытие груза на терминал', location: 'Пятигорск', provider_code: 'arrival', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2025-07-20T19:37:34', description: 'Сдача груза', location: 'Москва Беседы', provider_code: 'handover', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(parseMagicTrans(delivered, `TR${NUMBER}MT`).events).toHaveLength(3);
  });

  it('keeps a planned arrival out of the history and the estimate until the cargo is issued', () => {
    const result = parseMagicTrans(inTransit, '000000001');
    // A wording no rule knows leaves the stage to the newest dated row.
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map', last_status_text: 'Груз в пути',
      last_update_local: '2026-01-10T09:15:00', expected_delivery: '2026-01-14' });
    expect(result.events?.map(e => e.provider_code)).toEqual(['handover']);
    const arrived = { ...inTransit, dump: { ...inTransit.dump, DateArrivalWarehouseRecipient: '13.01.2026' } };
    expect(parseMagicTrans(arrived, '000000001').events?.map(e => [e.provider_code, e.local_time])).toEqual([['arrival', '2026-01-13'], ['handover', '2026-01-10T09:15:00']]);
    // Without the record the page's row is all there is.
    const rowsOnly = { ...inTransit, dump: undefined };
    expect(parseMagicTrans(rowsOnly, '000000001').events?.map(e => [e.provider_code, e.local_time, e.location])).toEqual([
      ['arrival', '2026-01-13', undefined], ['handover', '2026-01-10', undefined]]);
    const quiet = { ...inTransit, rows: inTransit.rows.map(r => r.key === 'Статус груза' ? { ...r, value: '--' } : r) };
    expect(parseMagicTrans(quiet, '000000001')).toMatchObject({ current_stage: 'accepted', last_status_text: 'Сдача груза' });
  });

  it('reads an unknown, an empty or an unreadable answer as what it is', () => {
    expect(() => parseMagicTrans(unknown, '000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const bare = { ...inTransit, rows: inTransit.rows.filter(r => !/^Дата|Прибытие/.test(r.key)), dump: {} };
    expect(() => parseMagicTrans(bare, '000000001')).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseMagicTrans(delivered, '000000001')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMagicTrans({ ...unknown, rows: [{ key: 'Статус груза', value: 'Груз выдан' }] }, '000000000')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMagicTrans({ ...delivered, heading: 'Ошибка' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMagicTrans({ ...delivered, rows: 'x' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMagicTrans({ ...delivered, rows: [{ key: 'Дата выдачи груза', value: '32.13.2025' }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMagicTrans({ wrapper: false }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeMagicTransNumber(' tr 021147139-mt ')).toBe(`TR${NUMBER}MT`);
    expect(normalizeMagicTransNumber('021 147 139')).toBe(NUMBER);
    for (const bad of ['21147139', 'ZZZZ000000000', 'https://magic-trans.ru/']) {
      expect(() => normalizeMagicTransNumber(bad)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it.each(statuses.entries)('maps $wording', entry => {
    const code = 'code' in entry ? entry.code : undefined;
    expect(statusMap.stage(code ?? null, normalizeStatusWording(entry.wording))).toBe(entry.stage);
    expect(magicTransStage(code, entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
  });

  it('asks the browser service for the tracker and its bound lookup', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ url: `https://magic-trans.ru/otsledit-gruz/?id=${NUMBER}`,
      skipHttp: true, maxTier: 3, captureResponses: [`https://magic-trans.ru/otsledit-gruz/?id=${NUMBER}`] });
    expect(adapter(h.environment)).toMatchObject({ id: 'magic-trans', steps: ['trawl'] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads the lookup’s, the check’s and the page’s refusals as what they are', async () => {
    await expect(harness([capture(unknown)]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture({ ...unknown, shown: false })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture({ ...delivered, captchaError: true })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture({ wrapper: false })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(null, { status: 403, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { body: null, error: 'challenge-html' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 400, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 400 });
    await expect(harness([capture(null, { status: 502, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', status: 502 });
    await expect(harness([capture(null, { status: 429, body: '', headers: { 'retry-after': '60' } })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    await expect(harness([capture(delivered, { trackingNumberSubmitted: '000000002' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(delivered, { truncated: true })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { body: '<html>' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture()], 'magic-trans-reply', 200, 'https://magic-trans.ru/').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([], 'magic-trans-unverified').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'magic-trans-capture_missing', 403).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'magic-trans-capture_missing').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], 'magic-trans-runtime').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new MagicTransTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });
});
