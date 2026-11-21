import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, AquantuoTracker, aquantuoTrackingUrl } from './adapter.js';
import { normalizeAquantuoNumber, parseAquantuo } from './parser.js';
import { aquantuoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json.
const SAMPLE = '2236371763054025';
const UNKNOWN = '0000000000000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const CHECK = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
/** The page for an id: the sample's, and the bare search box for any other. */
const tracking = (number: string) => (number === SAMPLE ? fixture(SAMPLE) : fixture('not-found').replaceAll(UNKNOWN, number));
const numberOf = (url: unknown) => new URL(String(url)).searchParams.get('package_id')!;
const direct = () => vi.fn<typeof fetch>(async url => page(tracking(numberOf(url))));
const carrier = (fetcher: typeof fetch, trawl: TrawlClient | null = null) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl, browserExecutablePath: null });
/**
 * A fetcher for the site that Cloudflare checks, and for a browser service that renders the page
 * in the address it is asked for. The browser step sends its requests through the adapter's fetcher.
 */
const checked = (render: (url: string) => string = url => tracking(numberOf(url))) => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).startsWith('http://browser.test/')) return page(CHECK, { status: 403 });
    const { url: address } = JSON.parse(String(init!.body)) as { url: string };
    return Response.json({ tier: 3, statusCode: 200, url: address, html: render(address) });
  });
  return { fetcher, trawl: new TrawlClient('http://browser.test', fetcher) };
};

describe('Aquantuo adapter', () => {
  it('reads the package’s steps by their names, with the page’s wall clocks', async () => {
    const fetcher = direct();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new AquantuoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2236 3717 6305 4025 ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://aquantuo.com/track-order?package_id=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // A collected package's expected day is behind it.
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Picked Up',
      last_update: null, last_update_local: '2026-04-22T07:40:00', expected_delivery: null, events: [
        { local_time: '2026-04-22T07:40:00', description: 'Picked Up', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-04-21T10:51:00', description: 'Sorting Completed', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-04-07T08:42:00', description: 'Pending', stage: 'registered', stage_source: 'carrier_map' },
      ] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'aquantuo', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the expected day of a package on its way', () => {
    expect(parseAquantuo(fixture(`${SAMPLE}-sorted`), SAMPLE)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Sorting Completed', last_update_local: '2026-04-21T10:51:00', expected_delivery: '2026-04-30' });
  });

  it('opens the page in the browser service when Cloudflare checks the direct read', async () => {
    const { fetcher, trawl } = checked();
    const result = await carrier(fetcher, trawl).track({ number: SAMPLE });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([aquantuoTrackingUrl(SAMPLE), 'http://browser.test/scrape']);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toMatchObject({ url: aquantuoTrackingUrl(SAMPLE), skipHttp: true, maxTier: 3 });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Picked Up' });
  });

  it('reads the bare search box as not found, and checks the id the page answers for', async () => {
    await expect(carrier(direct()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const service = checked();
    await expect(carrier(service.fetcher, service.trawl).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseAquantuo(fixture('not-found'), '0000000000000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAquantuo(fixture(SAMPLE), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = fixture(SAMPLE).replace(/<div class="to-history">[\s\S]*$/, '</body></html>');
    expect(() => parseAquantuo(empty, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('keeps a check, a rate limit and an outage apart from a missing package', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: SAMPLE });
    await expect(answer(page(CHECK, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page(CHECK))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(page('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // The browser service is asked once, and its own check is a challenge too.
    const service = checked(() => CHECK);
    await expect(carrier(service.fetcher, service.trawl).track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'challenge' });
    expect(service.fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries once when the first read does not reach the site', async () => {
    const fetcher = direct();
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: SAMPLE }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads a changed page as a schema change', () => {
    expect(() => parseAquantuo('<html><body>Maintenance</body></html>', SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAquantuo(fixture(SAMPLE).replace('Apr 22, 2026 07:40 AM', '22/04/2026 07:40'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAquantuo(fixture(SAMPLE).replace('<div class="to-history-status">Picked Up</div>', ''), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes ids of letters and digits', () => {
    expect(normalizeAquantuoNumber('aq-12345')).toBe('AQ12345');
    for (const bad of ['12345', 'A'.repeat(33), '2236/3717', '']) {
      expect(() => normalizeAquantuoNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the step names statuses.json records', () => {
    for (const entry of statuses.entries as ReadonlyArray<{ wording: string; stage?: string; note: string }>) {
      expect(statusMapAnswer({ carrier: 'aquantuo', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: entry.note });
      expect(aquantuoStage(entry.wording.toUpperCase())).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'aquantuo', providerCode: null, description: 'Something else' })).toEqual({ kind: 'unknown' });
  });
});
