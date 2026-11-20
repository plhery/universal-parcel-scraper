import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking, readFormToken, SEARCH_URL } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const example = fixture('example');
const number = '903088';
const token = 'a'.repeat(40);
const form = `<title>Найти посылку - Logexim Express</title><meta name="csrf-token" content="${token}">
  <form class="track-form"><input name="invoice_number"></form>`;

describe('Logexim Express freight tracking', () => {
  it('keeps the reported creation and actual delivery at calendar-day precision', () => {
    expect(parseTracking(example, number)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'Исполнена', provider_code: '3', last_update: null, last_update_local: '2026-03-30',
      expected_delivery: null,
      events: [
        { local_time: '2026-03-30', description: 'Доставлена', stage: 'delivered', stage_source: 'explicit_mapping' },
        { local_time: '2026-03-27', description: 'Заявка создана', stage: 'registered', stage_source: 'explicit_mapping' },
      ],
    });
  });

  it('keeps dated detail but leaves future and undated steps out of history', () => {
    const withDetail = example.replace('"detail_steps": []', `"detail_steps": [
      { "title": "Отправлено", "state": "done", "at": "28.03.2026 09:31" },
      { "title": "Доставлена", "state": "pending", "at": "30.03.2026" }
    ]`).replace('"fact_date": "30.03.2026"', '"fact_date": ""');
    expect(parseTracking(withDetail, number)).toMatchObject({
      status: 'in_transit', last_status_text: 'Отправлено', last_update_local: '2026-03-28T09:31',
      expected_delivery: null,
      events: [{ local_time: '2026-03-28T09:31', description: 'Отправлено', stage: 'in_transit' }],
    });
  });

  it('requires the exact waybill and distinguishes native absence from malformed replies', () => {
    expect(() => parseTracking(example, '903089')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(fixture('not-found'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('{"found":false,"error":"temporary failure"}', number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Attention Required</title>', number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects a token outside the carrier guest form', () => {
    expect(readFormToken(form)).toBe(token);
    expect(() => readFormToken(form.replace('name="invoice_number"', 'name="phone"')))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('obtains a guest session and posts the waybill using the caller’s user agent and signal', async () => {
    const formResponse = new Response(form, { headers: { 'Set-Cookie': 'logeximexpress-session=guest-test; Path=/; Secure' } });
    Object.defineProperty(formResponse, 'url', { value: SEARCH_URL });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(formResponse).mockResolvedValueOnce(new Response(example));
    const tracker = adapter({
      fetcher, userAgent: 'Logexim Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [formUrl, formInit] = fetcher.mock.calls[0]!;
    const [lookupUrl, lookupInit] = fetcher.mock.calls[1]!;
    expect(String(formUrl)).toBe(SEARCH_URL);
    expect(String(lookupUrl)).toBe('https://www.logeximexpress.kz/ajax/trackInvoice');
    expect(new Headers(formInit?.headers).get('user-agent')).toBe('Logexim Test');
    expect(new Headers(lookupInit?.headers).get('user-agent')).toBe('Logexim Test');
    expect(new Headers(lookupInit?.headers).get('x-csrf-token')).toBe(token);
    expect(new Headers(lookupInit?.headers).get('cookie')).toBe('logeximexpress-session=guest-test');
    expect(lookupInit?.body).toBe(JSON.stringify({ invoice_number: number }));
    expect(formInit?.signal).toBeInstanceOf(AbortSignal);
    expect(lookupInit?.signal).toBeInstanceOf(AbortSignal);
  });
});
