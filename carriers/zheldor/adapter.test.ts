import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { ZheldorTracker } from './adapter.js';
import { normalizeZheldorNumber, parseZheldorResponse } from './parser.js';

const NUMBER = '3746192837054612';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const history = () => JSON.parse(fixture());
const parse = (data: unknown, status = 200) => parseZheldorResponse(JSON.stringify(data), status, NUMBER);
const guest = (suffix = '1') => Response.json({ result: ['synthetic_guest_' + suffix] }, {
  headers: { Pragma: `dssession=synthetic_session_${suffix},dssessionexpires=0,jdesid=synthetic_guest_${suffix}` },
});

describe('Zheldorexpeditsia receipt history', () => {
  it('retains newest-first scans and wall clocks without contacts, documents or offsets', () => {
    const result = parse(history());
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-01-21T13:18:00', expected_delivery: null });
    expect(result.events).toHaveLength(15);
    expect(result.events![1]).toMatchObject({ provider_code: '31', stage: 'in_transit', stage_source: 'none' });
    const sms = result.events!.find(event => event.provider_code === '52');
    expect(sms).toMatchObject({ stage: 'registered', stage_source: 'none' });
    expect(result.events!.every(event => !event.time && event.local_time && event.description)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|ID_TTN|ID_GM|KG_SHIR|mstobj|SROK/);
    const data = history(); data.result[0].DTIME = '21.01.2026 3:18:00';
    expect(parse(data).events![0]!.local_time).toBe('2026-01-21T03:18:00');
  });

  it('binds the whole root and every scan, including hidden scans and rows after the history cap', () => {
    for (const change of [
      (data: ReturnType<typeof history>) => { data.ID_TTN += '9'; },
      (data: ReturnType<typeof history>) => { data.ID_TTN = Number(NUMBER); },
      (data: ReturnType<typeof history>) => { data.result[0].ID_TTN = '0746192837054612'; },
      (data: ReturnType<typeof history>) => { data.result[0].HIDE = '1'; data.result[0].ID_TTN += '9'; },
    ]) { const data = history(); change(data); expect(() => parse(data)).toThrow(expect.objectContaining({ kind: 'schema' })); }
    const data = history(); data.result = Array.from({ length: 110 }, () => ({ ...data.result[0] }));
    expect(parse(data)).toMatchObject({ history_truncated: true }); expect(parse(data).events).toHaveLength(100);
    data.result[109].ID_TTN += '9'; expect(() => parse(data)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('omits erroneous actions and rejects impossible clocks or malformed scans', () => {
    const data = history(); data.result[0].HIDE = '1';
    expect(parse(data).events).toHaveLength(14);
    for (const time of ['30.02.2026 12:00:00', '21.01.2026 24:00:00', '21.01.2026 12:00:00+03:00']) {
      const data = history(); data.result[0].DTIME = time;
      expect(() => parse(data)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const field of ['HIDE', 'TIP', 'TEXT', 'MST_NAME']) {
      const data = history(); delete data.result[0][field];
      expect(() => parse(data)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    data.result.forEach((row: { HIDE: string }) => { row.HIDE = '1'; });
    expect(() => parse(data)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it('recognizes only the exact whole-bound missing error and preserves challenge, HTTP and schema failures', () => {
    const missing = JSON.parse(fixture('not-found'));
    expect(() => parse(missing, 500)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const data of [{ error: missing.error.replace(NUMBER, NUMBER + '9') }, { ...missing, result: [] }, { error: 'not found' }]) {
      expect(() => parse(data, 500)).toThrow(expect.objectContaining({ name: 'UpstreamHttpError', kind: 'indeterminate', status: 500 }));
    }
    expect(() => parse(missing)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse({ CAPTCHA_ERROR: '1' })).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseZheldorResponse('<title>Just a moment</title>', 403, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseZheldorResponse('server unavailable', 500, NUMBER)).toThrow(expect.objectContaining({ name: 'UpstreamHttpError', kind: 'indeterminate' }));
    expect(() => parse({ ...history(), error: 'changed' })).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('maps wording rather than numeric codes and declares informational gaps', () => {
    const data = history(); data.result[0].TEXT = 'Unrecognized activity';
    expect(parse(data).events![0]).not.toHaveProperty('stage');
    expect(statusMapAnswer({ carrier: 'zheldor', providerCode: '52', description: 'Отправлена СМС Получателю об отправке' }).kind).toBe('intentional_gap');
    expect(statusMapAnswer({ carrier: 'zheldor', providerCode: '31', description: 'Недозвон Клиенту' }).kind).toBe('intentional_gap');
    expect(statusMapAnswer({ carrier: 'zheldor', providerCode: '7', description: 'Unrecognized activity' }).kind).toBe('unknown');
    expect(normalizeZheldorNumber('3746-1928-3705-4612')).toBe(NUMBER);
    expect(() => normalizeZheldorNumber(NUMBER + '9')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('Zheldorexpeditsia anonymous QR transport', () => {
  it('uses the supplied transport, fresh sessions and whole-reference QR requests through the registered adapter', async () => {
    let generation = 0;
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! });
      return String(input).endsWith('/GetSessionId/') ? guest(String(++generation)) : new Response(fixture());
    }) as unknown as typeof fetch;
    const registry = new AdapterRegistry(REGISTRY, { fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, userAgent: 'host-agent' });
    const adapter = registry.for('zheldor')!;
    for (let i = 0; i < 2; i++) expect((await adapter.track({ number: NUMBER })).events).toHaveLength(15);
    expect(calls).toHaveLength(4);
    for (const i of [1, 3]) {
      const headers = new Headers(calls[i]!.init.headers);
      expect(headers.get('Pragma')).toBe(`dssession=synthetic_session_${(i + 1) / 2},jdesid=synthetic_guest_${(i + 1) / 2}`);
      expect(headers.get('Cookie')).toContain('dssessiona=synthetic_session_');
      expect(headers.get('User-Agent')).toBe('host-agent');
      expect(headers.get('Referer')).toContain(`ttn=${NUMBER}&qr=1`);
      expect(JSON.parse(String(calls[i]!.init.body))).toEqual({ ttn: NUMBER, pincode: 1, qr: true, captcha_code: '', tmpkey: expect.stringMatching(/^[a-f0-9]{32}$/) });
      expect(calls[i]!.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls[1]!.init.body).not.toBe(calls[3]!.init.body);
    expect(hasDirectHandoffAdapter('zheldor', NUMBER)).toBe(true);
    expect(hasDirectHandoffAdapter('zheldor', 'RR123456789RU')).toBe(false);
    expect(recognitionAskedCarriers(NUMBER, { hint: 'zheldor', countryHint: 'RU' })).not.toContain('zheldor');
  });

  it('reopens the anonymous session only after a network failure', async () => {
    let lookups = 0, sessions = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/GetSessionId/')) return guest(String(++sessions));
      if (++lookups === 1) throw new TypeError('fetch failed');
      return new Response(fixture());
    }) as unknown as typeof fetch;
    expect((await new ZheldorTracker({ fetcher }).fetch(NUMBER)).events).toHaveLength(15);
    expect(sessions).toBe(2); expect(lookups).toBe(2);
  });

  it('does not retry definite missing, challenged, malformed, rate-limited or HTTP replies, and hides session diagnostics', async () => {
    for (const [body, status, kind] of [
      [fixture('not-found'), 500, 'not_found'], ['{"CAPTCHA_ERROR":1}', 200, 'challenge'],
      ['{}', 200, 'schema'], ['refused synthetic_guest_1 synthetic_session_1', 429, 'rate_limited'], ['failure', 500, 'indeterminate'],
    ] as const) {
      const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/GetSessionId/') ? guest() : new Response(body, { status })) as unknown as typeof fetch;
      const error = await new ZheldorTracker({ fetcher }).fetch(NUMBER).catch(error => error);
      expect(error).toMatchObject({ kind }); expect(fetcher).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(error)).not.toMatch(/synthetic_guest|synthetic_session|tmpkey|captcha_code/);
    }
  });

  it('honors invalid input, cancellation and exhausted budgets without another request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => { controller.abort(); return guest(); }) as unknown as typeof fetch;
    const tracker = new ZheldorTracker({ fetcher });
    await expect(tracker.fetch('invalid')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(tracker.fetch(NUMBER, { budgetMs: 0 })).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
