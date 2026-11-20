import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { AltexCurierTracker } from './adapter.js';
import { altexNumber, altexTrackingUrl, parseAltex } from './parser.js';
import { altexStage } from './status.js';

const NUMBER = '200000001234', OTHER = '200000001235';
const fixture = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const page = (rows: unknown, number = NUMBER) => '<title>Altex Curier</title><h2>Detalii AWB: ' + number
  + '</h2><script>displayTrackingData(' + JSON.stringify(rows) + ');</script>';

describe('Altex Curier public AWB history', () => {
  it('retains all native wordings and calendar days without inventing clock times', () => {
    const result = parseAltex(fixture, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', status: 'delivered', last_update: null,
      last_update_local: '2026-07-25', expected_delivery: null });
    expect(result.events).toHaveLength(6);
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'exception', 'out_for_delivery', 'in_transit', 'in_transit', 'registered']);
    expect(result.events?.every(event => /^2026-07-\d{2}$/.test(event.local_time!))).toBe(true);
    expect(result.events?.every(event => event.time === undefined)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
  });

  it('requires one whole returned AWB heading and the carrier page title', () => {
    expect(() => parseAltex(fixture, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const changed of [fixture.replace(NUMBER, NUMBER + '0'), fixture.replace('</h2>', '</h2><h2>Detalii AWB: ' + NUMBER + '</h2>'),
      fixture.replace('<h2>', '<h3>').replace('</h2>', '</h3>')]) {
      expect(() => parseAltex(changed, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseAltex(fixture.replace('Altex Curier', 'Other tracker'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('finalizes only the exact native single AWB-bound error object', () => {
    expect(() => parseAltex(missing, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const rows of [[{ AWB: OTHER, isError: true }], [{ AWB: NUMBER, isError: true, message: 'Verification required' }],
      [{ AWB: NUMBER, isError: true }, { Date: '25.07.2026', Title: 'Expedierea a fost livrata', isError: false }]]) {
      expect(() => parseAltex(page(rows), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseAltex(page([]), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('parses JSON without evaluating script or accepting duplicate data assignments', () => {
    for (const changed of [fixture.replace('</script>', '</script><script>displayTrackingData([]);</script>'),
      fixture.replace('displayTrackingData(', 'window.displayTrackingData('), fixture.replace('displayTrackingData(', 'const demo = "displayTrackingData('),
      fixture.replace(']);', ']);window.unrelated();'), fixture.replace('"Date"', 'Date'),
      fixture.replace('displayTrackingData(', 'displayTrackingData(doNotExecute(),')]) {
      expect(() => parseAltex(changed, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects invalid dates, invalid flags and oversized histories', () => {
    for (const row of [{ Date: '31.02.2026', Title: 'Expedierea a fost livrata', isError: false },
      { Date: '25.07.2026 12:30', Title: 'Expedierea a fost livrata', isError: false },
      { Date: '25.07.2026', Title: '', isError: false }, { Date: '25.07.2026', Title: 'Example' }, null]) {
      expect(() => parseAltex(page([row]), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const row = { Date: '25.07.2026', Title: 'Expedierea a fost livrata', isError: false };
    expect(parseAltex(page(Array.from({ length: 101 }, () => row)), NUMBER)).toMatchObject({ history_truncated: true });
    expect(() => parseAltex(page(Array.from({ length: 501 }, () => row)), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not turn a generic undelivered scan into a failed attempt or keep an old delivery across unknown meaning', () => {
    expect(altexStage('Expedierea este nelivrata')).toBe('exception');
    expect(altexStage('Expedierea a fost livrata partial')).toBeUndefined();
    expect(parseAltex(page([{ Date: '24.07.2026', Title: 'Expedierea a fost livrata', isError: false },
      { Date: '25.07.2026', Title: 'A changed native state', isError: false }]), NUMBER)).toMatchObject({ current_stage: 'unknown' });
  });

  it('uses one supplied, cancellable, bounded guest GET and keeps rate limits and redirects distinct', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe(altexTrackingUrl(NUMBER)); expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers); expect(headers.has('Authorization')).toBe(false); expect(headers.has('Cookie')).toBe(false);
      return new Response(fixture);
    });
    expect((await new AltexCurierTracker({ fetcher }).fetch(NUMBER)).events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('limited', { status: 429, headers: { 'Retry-After': '7' } }));
    await expect(new AltexCurierTracker({ fetcher: limited }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
    const moved = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 302, headers: { Location: 'https://other.invalid' } }));
    await expect(new AltexCurierTracker({ fetcher: moved }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(new Response('<title>Just a moment</title>'));
    await expect(new AltexCurierTracker({ fetcher: blocked }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('rejects invalid inputs, exhausted budget and cancellation before issuing a request', async () => {
    expect(altexNumber(' 2000 0000 1234 ')).toBe(NUMBER);
    for (const invalid of ['', 'ABC123456789', '1234567', '1'.repeat(41)]) expect(() => altexNumber(invalid)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    const fetcher = vi.fn<typeof fetch>(), tracker = new AltexCurierTracker({ fetcher });
    await expect(tracker.fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(tracker.fetch(NUMBER, { signal: AbortSignal.abort(Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serves selected-carrier SDK lookups with native date precision and no fabricated delivery instant', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture));
    const result = await createTracker({ fetcher, providers: [], env: {} }).track({ carrier: 'altex-curier', number: NUMBER }, { budgetMs: 5000 });
    expect(result).toMatchObject({ source: 'altex-curier', result: { current_stage: 'delivered', last_update_local: '2026-07-25' } });
    expect(result.result.events?.every(event => !event.time?.includes('T'))).toBe(true);
    expect(result.result.delivered_at).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
