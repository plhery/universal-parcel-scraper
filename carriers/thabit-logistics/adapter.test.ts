import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import type { TrawlClient, TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { ThabitTracker } from './adapter.js';
import { normalizeThabitNumber, parseThabit, thabitTrackingUrl } from './parser.js';
import { thabitStage } from './status.js';

const NUMBER = 'NKT83524916', OTHER = 'NKT62941758';
const direct = readFileSync(new URL('./fixtures/direct.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');
const $ = load(direct);
$('tbody tr').each((_index, row) => {
  const cell = $(row).children('td').eq(1), clock = cell.text().replace('(loading...)', '');
  cell.attr('data-utc-time', clock).text('viewer-local display');
});
const browser = $.html();
const client = (scrape: TrawlClient['scrape']) => ({ scrape }) as unknown as TrawlClient;
const page = (url: string, html: string): TrawlScrapeResponse => ({ url, html, cookies: [], userAgent: null, tier: 3, statusCode: 200, capturedResponses: [], raw: {} });

describe('Thabit whole-waybill guest history', () => {
  it('reads status, original explicit UTC clocks and stations without form state or contact details', () => {
    const result = parseThabit(direct, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-09T08:39:27.418Z', expected_delivery: null });
    expect(result.events).toHaveLength(9);
    expect(result.events?.[0]).toMatchObject({ time: '2026-01-09T08:39:27.418Z', description: 'Delivered', location: 'Madinah Station' });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-csrf|synthetic-private-contact|airway_bill_no/);
  });

  it('reads the original UTC attribute after the browser localizes visible clocks', () => {
    expect(parseThabit(browser, NUMBER)).toEqual(parseThabit(direct, NUMBER));
    expect(() => parseThabit(browser.replace('data-utc-time="2026-01-09T08:39:27.418Z"', 'data-utc-time="bad"'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseThabit(direct.replace('2026-01-09T08:39:27.418Z', '2026-02-30T08:39:27.418Z'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const changed = load(browser); changed('tbody tr').first().children('td').eq(1).text('2026-01-09T10:39:27.418Z');
    expect(() => parseThabit(changed.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('requires the supported form, canonical address and exact whole value before any outcome', () => {
    for (const html of [direct, missing]) expect(() => parseThabit(html, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const html of [direct.replace('rel="canonical"', 'rel="other"'), direct.replace('name="airway_bill_no"', 'name="other"'),
      direct.replace('method="POST"', 'method="GET"'), direct.replace('Station Name', 'Changed column')]) {
      expect(() => parseThabit(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('accepts only the scoped native missing-record table without conflicting rows', () => {
    expect(() => parseThabit(missing, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const changed = load(missing); changed('table').append('<tbody><tr><td>synthetic conflicting row</td></tr></tbody>');
    expect(() => parseThabit(changed.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseThabit(missing.replace('Record Not Found', 'Synthetic unfinished result'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('retains physical milestones while administrative counters or assignment assert none', () => {
    const result = parseThabit(direct, NUMBER);
    for (const description of ['Accept', 'Assigned to courier', 'Third delivery attempt']) {
      expect(result.events?.find(event => event.description === description)).toMatchObject({ stage: 'pending', stage_source: 'none' });
    }
    expect(result.events?.find(event => event.description === 'Dispatched')).toMatchObject({ stage: 'in_transit' });
    expect(result.events?.find(event => event.description === 'Recipient mobile switched off')).toMatchObject({ stage: 'failed_attempt' });
    expect(thabitStage('Recipient mobile no response')).toMatchObject({ stage: 'failed_attempt' });
    expect(thabitStage('First delivery attempt')).toBeNull();
    expect(thabitStage('Second delivery attempt')).toBeNull();
    expect(thabitStage('First pickup attempt')).toBeNull();
  });

  it('does not let an unknown newer movement preserve an older delivered stage', () => {
    const changed = load(direct);changed('tbody tr').first().children('td').first().text('SYNTHETIC NEW RETURN MOVEMENT');
    expect(() => parseThabit(changed.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the existing truncation contract and rejects unbounded tables', () => {
    const changed = load(direct), row = changed('tbody tr').first().toString();
    changed('tbody').html(row.repeat(101));
    const result = parseThabit(changed.html(), NUMBER);expect(result.events).toHaveLength(100);expect(result.history_truncated).toBe(true);
    expect(result).not.toHaveProperty('events_truncated');
    changed('tbody').html(row.repeat(501));
    expect(() => parseThabit(changed.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not mistake ModSecurity or browser checks for missing shipments', () => {
    for (const text of ['ModSecurity synthetic wall', '<title>Just a moment</title>' + missing]) {
      expect(() => parseThabit(text, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(parseThabit('<script src="https://www.google.com/recaptcha/api.js"></script>' + direct, NUMBER).events).toHaveLength(9);
  });

  it('uses the supplied transport and normal User-Agent once, without account, phone or POST calls', async () => {
    const scrape = vi.fn<TrawlClient['scrape']>(), fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(String(input)).toBe(thabitTrackingUrl(NUMBER));expect(init?.method ?? 'GET').toBe('GET');expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('User-Agent')).toMatch(/Mozilla/);expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);expect(new Headers(init?.headers).has('Cookie')).toBe(false);
      return new Response(direct);
    });
    expect((await new ThabitTracker({ fetcher, trawl: client(scrape) }).fetch(NUMBER)).events).toHaveLength(9);
    expect(fetcher).toHaveBeenCalledTimes(1);expect(scrape).not.toHaveBeenCalled();
  });

  it.each([403, 406])('recovers HTTP %i through the same whole URL and original clock attributes', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('synthetic refusal', { status }));
    const scrape = vi.fn<TrawlClient['scrape']>().mockImplementation(async (request, options) => {
      expect(request).toMatchObject({ url: thabitTrackingUrl(NUMBER), skipHttp: true, maxTier: 3 });
      expect(options?.signal).toBeInstanceOf(AbortSignal);return page(request.url, browser);
    });
    expect(await new ThabitTracker({ fetcher, trawl: client(scrape) }).fetch(NUMBER)).toEqual(parseThabit(direct, NUMBER));
    expect(fetcher).toHaveBeenCalledTimes(1);expect(scrape).toHaveBeenCalledTimes(1);
  });

  it('does not spend a browser on a native miss, a changed schema or a rate limit', async () => {
    for (const [kind, response] of [['not_found', new Response(missing)], ['schema', new Response('<html>unfinished</html>')],
      ['rate_limited', new Response('limited', { status: 429, headers: { 'Retry-After': '5' } })]] as const) {
      const scrape = vi.fn<TrawlClient['scrape']>(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(new ThabitTracker({ fetcher, trawl: client(scrape) }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(scrape).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects a browser redirect and respects the caller deadline or cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('blocked', { status: 403 }));
    const scrape = vi.fn<TrawlClient['scrape']>().mockResolvedValue(page(thabitTrackingUrl(OTHER), browser));
    await expect(new ThabitTracker({ fetcher, trawl: client(scrape) }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    scrape.mockClear();fetcher.mockClear();
    await expect(new ThabitTracker({ fetcher, trawl: client(scrape) }).fetch(NUMBER, { budgetMs: 3000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(scrape).not.toHaveBeenCalled();fetcher.mockClear();
    await expect(new ThabitTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort(Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    for (const value of ['', 'https://other.invalid', 'A'.repeat(41)]) expect(() => normalizeThabitNumber(value)).toThrow();
  });

  it('serves a selected carrier through the public SDK without inferring a zone over native UTC', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(direct));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER, carrier: 'thabit-logistics' }, { budgetMs: 5000 });
    expect(answer).toMatchObject({ source: 'thabit-logistics', carrier: 'thabit-logistics', result: { current_stage: 'delivered', last_update: '2026-01-09T08:39:27.418Z' } });
    expect(answer.result.events).toHaveLength(9);expect(answer.result.events?.[0]?.time).toBe('2026-01-09T08:39:27.418Z');
  });
});
