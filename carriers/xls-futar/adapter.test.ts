import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, XlsFutarTracker } from './adapter.js';
import { normalizeXlsFutarNumber, parseXlsFutar, xlsFutarTrackingUrl } from './parser.js';
import { xlsFutarStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '8306829';
const OTHER = '9407128';
const html = readFileSync(new URL('./fixtures/summary.html', import.meta.url), 'utf8');
const absent = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const page = (body = html) => new Response(body, { headers: { 'Content-Type': 'text/html' } });
const make = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('XLS Futár public summary', () => {
  it('preserves the date-only last change without inventing a scan or delivery clock', () => {
    const result = parseXlsFutar(html, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', status: 'delivered', summary_only: true,
      last_update: null, last_update_local: '2024-04-13', expected_delivery: null, events: [] });
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/T00:00|pin|synthetic-csrf|1234|5678/);
  });

  it('maps the official state legend and keeps depot and closed summaries unresolved', () => {
    for (const row of statuses.entries) expect(xlsFutarStage(row.wording)).toEqual({ stage: row.stage, source: 'carrier_map' });
    for (const wording of ['Depó', 'Lezárva', 'SAMPLE NEW NATIVE STATE']) {
      expect(xlsFutarStage(wording)).toBeNull();
      expect(parseXlsFutar(html.replace('Kézbesítve', wording), NUMBER)).toMatchObject({ current_stage: 'unknown', summary_only: true });
    }
  });

  it('requires the whole reference in the native guest form before reading any outcome', () => {
    expect(() => parseXlsFutar(html, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXlsFutar(absent, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXlsFutar(html.replace('name="id"', 'name="other"'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires the supported form, native summary and one active state', () => {
    for (const changed of [html.replace('method="GET"', 'method="POST"'), html.replace('https://xlsfutar.hu/track', 'https://other.invalid/track'),
      html.replace('<div class="content">', '<div class="content"></div><div class="content">'),
      html.replace('class="col active"', 'class="col"'),
      html.replace('<div class="order-state-path">', '<div class="order-state-path"><div class="col active"><div class="label">Kézbesítve</div></div>')]) {
      expect(() => parseXlsFutar(changed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('accepts only the calendar day in the last-change field', () => {
    for (const day of ['2024-02-30', '2024-04-13T15:00:00Z', '13/04/2024', '2024-04-13 (age) unexpected']) {
      expect(() => parseXlsFutar(html.replace('2024-04-13 (2 éve)', day), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseXlsFutar(html.replace('Utolsó változás', 'Other date'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts only the exact identity-bound native unknown, without a state path', () => {
    expect(() => parseXlsFutar(absent, NUMBER)).toThrow(expect.objectContaining({ name: 'NotFoundError', kind: 'not_found' }));
    expect(() => parseXlsFutar(absent.replace('Nem létező csomagszám', 'SAMPLE UNFINISHED'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const contradictory = html.replace('<div class="order-state-path">', '<div class="alert">Nem létező csomagszám Kérjük vegye fel a kapcsolatot a feladóval!</div><div class="order-state-path">');
    expect(() => parseXlsFutar(contradictory, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps browser checks separate from missing parcels', () => {
    expect(() => parseXlsFutar('<title>Just a moment</title>' + absent, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseXlsFutar('<html>synthetic empty page</html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses one supplied HTTP request for the whole number and submits no PIN or form state', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://xlsfutar.hu');expect(url.pathname).toBe('/track/' + NUMBER);expect(url.search).toBe('');
      expect(init?.method ?? 'GET').toBe('GET');expect(init?.body).toBeUndefined();expect(init?.signal).toBeInstanceOf(AbortSignal);
      return page();
    });
    expect((await new XlsFutarTracker({ fetcher }).fetch(NUMBER, { budgetMs: 5000 })).summary_only).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves rate limits and refuses generic missing HTTP pages as transport failures', async () => {
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('synthetic rate limit', { status: 429, headers: { 'Retry-After': '5' } }));
    await expect(make(limited).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 5000 });
    expect(limited).toHaveBeenCalledTimes(1);
    for (const status of [404, 410]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(absent, { status }));
      await expect(make(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport', status });
    }
  });

  it('rejects malformed and pre-cancelled inputs without egress', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const raw of ['', 'A8306829', '1'.repeat(21), 'https://other.invalid/track']) expect(() => normalizeXlsFutarNumber(raw)).toThrow();
    expect(normalizeXlsFutarNumber(' 830 6829 ')).toBe(NUMBER);
    expect(xlsFutarTrackingUrl(NUMBER)).toBe('https://xlsfutar.hu/track/' + NUMBER);
    await expect(make(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serves a selected XLS parcel through the public facade without manufacturing history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page());
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER, carrier: 'xls-futar' }, { budgetMs: 5000 });
    expect(answer).toMatchObject({ source: 'xls-futar', carrier: 'xls-futar', result: {
      current_stage: 'delivered', last_status_text: 'Kézbesítve', last_update: null, last_update_local: '2024-04-13',
      summary_only: true, events: [] } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
