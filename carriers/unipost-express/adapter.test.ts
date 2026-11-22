import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import statuses from './statuses.json' with { type: 'json' };
import { UnipostTracker } from './adapter.js';
import { normalizeUnipostNumber, parseUnipost, unipostTrackingUrl } from './parser.js';
import { statusMap } from './status.js';

const WAYBILL = '1001419';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('Unipost-Express guest adapter', () => {
  it('posts the waybill as the home page form does, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new UnipostTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' 373-1001419 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://www.unipost.md/ru/track/1001419');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', body: 'track_nr=1001419&track_do=&show_form=track_package_guest',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.unipost.md/ru', 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Shipment delivered', last_update: null,
      last_update_local: '2017-08-09T19:29:00', destination_country: 'RU', weight_kg: 8 });
  });

  it('keeps the rows newest first on their wall clocks, a midnight row by its day alone, and places only the delivery', () => {
    const result = parseUnipost(page('delivered.html'), WAYBILL);
    expect(result.events!.map(event => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2017-08-09T19:29:00', 'Shipment delivered', 'LED, RU', 'delivered'],
      ['2017-08-04', 'Shipment manifested', undefined, 'in_transit'],
      ['2017-08-04', 'Shipment received in destination country and scanned', undefined, 'in_transit'],
    ]);
    expect(result.events!.every(event => !event.time)).toBe(true);
    const dubai = parseUnipost(page('dubai.html'), '1000814');
    expect(dubai.events!.map(event => event.local_time)).toEqual(['2016-05-29T07:46:00', '2016-05-23T23:00:00', '2016-05-23T10:33:00']);
    expect(dubai).toMatchObject({ destination_country: 'AE', weight_kg: 0.1 });
    const manifested = parseUnipost(page('manifested.html'), '1001427');
    expect(manifested).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Shipment manifested', destination_country: 'MD' });
    expect(manifested.events!.map(event => event.location)).toEqual([undefined, undefined]);
  });

  it('never reads the sender, the recipient or who signed', () => {
    for (const [name, number] of [['delivered.html', WAYBILL], ['dubai.html', '1000814'], ['manifested.html', '1001427']] as const) {
      expect(JSON.stringify(parseUnipost(page(name), number))).not.toMatch(/SENDER|RECIPIENT|SIGNER/);
    }
  });

  it('reports an unknown waybill as not found only when the notice names it, and requires the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new UnipostTracker({ fetcher }).fetch('999999990')).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseUnipost(page('not-found.html'), '999999991')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const html = page('delivered.html');
    expect(() => parseUnipost(html, '1001418')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUnipost(html.replace('<td>1001419</td><td>LED/RU</td><td>2017-08-09', '<td>1001418</td><td>LED/RU</td><td>2017-08-09'), WAYBILL))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUnipost(html.replace('2017-08-09 19:29:00', '2017-02-30 19:29:00'), WAYBILL)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUnipost(html.replace('2017-08-09 19:29:00', '09.08.2017 19:29'), WAYBILL)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUnipost(html.replace('<td>SIGNER</td>', ''), WAYBILL)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUnipost('<html>maintenance</html>', WAYBILL)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['10014', '1001419A', '0373-1001419', '1234567890123456']) {
      expect(() => normalizeUnipostNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(normalizeUnipostNumber('373 - 1001419')).toBe(WAYBILL);
    expect(unipostTrackingUrl(WAYBILL)).toBe('https://www.unipost.md/ru/track/1001419');
  });

  it('reads a waybill on file without a scan as listed', () => {
    const html = page('manifested.html').replace(/<tr {2}class='this_form_history'>[\s\S]*?<\/tr>/g, '');
    expect(() => parseUnipost(html, '1001427')).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseUnipost('<html><title>Just a moment...</title></html>', WAYBILL)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new UnipostTracker({ fetcher }).fetch(WAYBILL)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps every recorded status and leaves others without a stage', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    expect(statusMap.stage(null, 'shipment on hold')).toBeUndefined();
    const result = parseUnipost(page('delivered.html').replace('<td>Shipment delivered</td>', '<td>Shipment on hold</td>'), WAYBILL);
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Shipment on hold' });
  });

  it('is not detected and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(WAYBILL).candidates ?? []).not.toContain('unipost-express');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'unipost-express', number: WAYBILL });
    expect(tracked.source).toBe('unipost-express');
    expect(tracked.result.status).toBe('delivered');
  });
});
