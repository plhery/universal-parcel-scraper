import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LBC_SEARCH, LbcExpressTracker, lbcRedirectUrl } from './adapter.js';
import { normalizeLbcNumber, parseLbc } from './parser.js';

const NUMBER = '100000000001';
const fixture = () => readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const REDIRECT = { page_slug: 'track', hash: 'SYNTHETIC_OPAQUE_HANDLE' };

afterEach(() => vi.restoreAllMocks());

describe('LBC current public history parser', () => {
  it('binds identity, removes recipients, deduplicates scans, and preserves date-only certainty', () => {
    const result = parseLbc(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update: null });
    expect(result.events).toHaveLength(6);
    expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery' });
    expect(result.events?.at(-1)).toMatchObject({ stage: 'accepted' });
    expect(result.events?.every(event => event.provider_time_text && !event.time && !event.local_time)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC RECIPIENT');
  });
  it.each(['wrong', 'absent', 'ambiguous'])('rejects %s shipment identity', mode => {
    let html = fixture();
    if (mode === 'wrong') html = html.replace(`value="${NUMBER}"`, 'value="100000000002"');
    if (mode === 'absent') html = html.replace('id="inputTrackingSearchForm"', 'id="other"');
    if (mode === 'ambiguous') html += `<input id="inputTrackingSearchForm" value="${NUMBER}">`;
    expect(() => parseLbc(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('keeps a bound empty page inconclusive', () => {
    expect(() => parseLbc(`<input id="inputTrackingSearchForm" value="${NUMBER}">`, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
  it.each(['date', 'description', 'multiple labels'])('rejects a changed %s scan layout', mode => {
    let html = fixture();
    if (mode === 'date') html = html.replace('mobile-tracking-timedate', 'other-date');
    if (mode === 'description') html = html.replace('mobile-tracking-details', 'other-description');
    if (mode === 'multiple labels') html = html.replace('</p>', '</p><p class="mobile-tracking-details">Other scan</p>');
    expect(() => parseLbc(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
  it('keeps unknown current wording and malformed calendar labels unresolved', () => {
    const html = fixture().replace('Delivered to PRIVATE SYNTHETIC RECIPIENT on 10/02/2026.', 'New provider operation')
      .replace('Fri, 02 October 2026', 'not a calendar date');
    const result = parseLbc(html, NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'New provider operation', last_update: null });
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_time_text: 'not a calendar date' });
  });
  it('redacts unrecognized delivered-to details without assigning a terminal milestone', () => {
    const result = parseLbc(fixture().replace('on 10/02/2026.', 'pending verification.'), NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Delivery update' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('validates input before retrieval and bounds provider HTML', () => {
    expect(normalizeLbcNumber(' 1000 0000 0001 ')).toBe(NUMBER);
    expect(() => normalizeLbcNumber('100000000001&x=1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseLbc('x'.repeat(1_000_001), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

function browserSeam() {
  let currentUrl = 'about:blank';
  const page = {
    mainFrame: vi.fn(() => ({})),
    waitForResponse: vi.fn(async () => ({ status: () => 200 })),
    goto: vi.fn(async (url: string) => { currentUrl = url; return { status: (): number => 200 }; }),
    url: () => currentUrl,
    locator: vi.fn(() => ({ first: () => ({ waitFor: vi.fn(async () => {}) }) })),
    evaluate: vi.fn(async (_callback: unknown, parameters: unknown) => { void parameters; return { status: 200, oversized: false, body: JSON.stringify(REDIRECT) }; }),
    content: vi.fn(async () => fixture()),
  };
  const context = { newPage: vi.fn(async () => page) };
  const browser = { version: () => '148.0.0.0', newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const launch = vi.spyOn(chromium, 'launch').mockResolvedValue(browser as never);
  return { page, context, browser, launch };
}

describe('LBC bounded anonymous browser transport', () => {
  it('uses a fresh session and the current returned handle inside one recorded lookup', async () => {
    const seam = browserSeam(), recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const instance = adapter({ browserExecutablePath: '/synthetic/chromium', trawl: null, recorder, env: {} });
    await expect(instance.track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(seam.page.goto.mock.calls.map(call => call[0])).toEqual(['https://www.lbcexpress.com/', 'https://www.lbcexpress.com/track/', lbcRedirectUrl(REDIRECT)]);
    expect(seam.page.evaluate.mock.calls[0]?.[1]).toMatchObject({ number: NUMBER, endpoint: LBC_SEARCH, maxBytes: 1_000_000 });
    expect(Object.keys(seam.launch.mock.calls[0]![0]!.env!)).toEqual(['PATH', 'HOME', 'LANG']);
    expect(seam.browser.close).toHaveBeenCalledOnce();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'browser', outcome: 'ok' }));
  });
  it.each(['slug', 'external path', 'empty', 'malformed escape', 'encoded separator'])('rejects %s redirect before capability navigation', async mode => {
    const seam = browserSeam();
    const payload = { ...REDIRECT };
    if (mode === 'slug') payload.page_slug = 'SearchResult';
    if (mode === 'external path') payload.hash = '//different.example/path';
    if (mode === 'empty') payload.hash = '';
    if (mode === 'malformed escape') payload.hash = 'SYNTHETIC%XX';
    if (mode === 'encoded separator') payload.hash = 'SYNTHETIC%2FHANDLE';
    seam.page.evaluate.mockResolvedValue({ status: 200, oversized: false, body: JSON.stringify(payload) });
    await expect(new LbcExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(seam.page.goto).toHaveBeenCalledTimes(2);
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });
  it.each([403, 404, 410, 429])('keeps search HTTP %s distinct from shipment absence', async status => {
    const seam = browserSeam(); seam.page.evaluate.mockResolvedValue({ status, oversized: false, body: '' });
    await expect(new LbcExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER)).rejects.toMatchObject({ status,
      kind: status === 403 ? 'challenge' : status === 429 ? 'rate_limited' : 'transport' });
    expect(seam.page.goto).toHaveBeenCalledTimes(2);
  });
  it.each(['oversized', 'invalid JSON'])('rejects %s redirect data', async mode => {
    const seam = browserSeam(); seam.page.evaluate.mockResolvedValue({ status: 200, oversized: mode === 'oversized', body: 'not JSON' });
    await expect(new LbcExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });
  it('does not expose a capability URL from a failed browser navigation', async () => {
    const seam = browserSeam();
    const navigate = seam.page.goto.getMockImplementation()!;
    seam.page.goto.mockImplementation(async url => {
      if (url === lbcRedirectUrl(REDIRECT)) throw new Error(`page.goto failed ${url}`);
      return navigate(url);
    });
    const error: unknown = await new LbcExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER).catch(caught => caught);
    expect(error).toMatchObject({ kind: 'transport', message: 'LBC browser tracking failed' });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain(REDIRECT.hash);
  });
  it('waits for the website’s automatic JavaScript reload after an initial challenge document', async () => {
    const seam = browserSeam(), navigate = seam.page.goto.getMockImplementation()!;
    seam.page.goto.mockImplementation(async url => { await navigate(url); return { status: () => 403 }; });
    await expect(new LbcExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(seam.page.waitForResponse).toHaveBeenCalledTimes(3);
  });
  it('keeps an unfinished website challenge distinct from shipment absence', async () => {
    const seam = browserSeam(), navigate = seam.page.goto.getMockImplementation()!;
    seam.page.goto.mockImplementation(async url => { await navigate(url); return { status: () => 403 }; });
    seam.page.waitForResponse.mockRejectedValue(new Error('Synthetic challenge timeout'));
    await expect(new LbcExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(seam.page.evaluate).not.toHaveBeenCalled();
    expect(seam.browser.close).toHaveBeenCalledOnce();
  });
  it('closes its browser when a current form submission is cancelled', async () => {
    const seam = browserSeam(), controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    seam.page.evaluate.mockImplementation(() => { entered(); return new Promise(() => {}); });
    const pending = new LbcExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER, { signal: controller.signal });
    await ready; controller.abort(new Error('Synthetic cancellation'));
    await expect(pending).rejects.toThrow('Synthetic cancellation');
    expect(seam.browser.close).toHaveBeenCalledOnce();
    expect(seam.page.goto).toHaveBeenCalledTimes(2);
  });
  it('requires configuration and rejects invalid or pre-aborted input before browser work', async () => {
    const seam = browserSeam();
    expect(() => new LbcExpressTracker().fetch(NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => new LbcExpressTracker({ executablePath: '/synthetic/chromium' }).fetch('bad')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    await expect(new LbcExpressTracker({ executablePath: '/synthetic/chromium' }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(seam.launch).not.toHaveBeenCalled();
  });
});
