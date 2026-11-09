import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LIBANPOST_ENDPOINT, LibanPostTracker } from './adapter.js';
import { normalizeLibanPostNumber, parseLibanPost } from './parser.js';
import { libanPostWordingStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'ZZ000000014CN';
const UNKNOWN = 'ZZ000000028LB';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const factory = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null, env: {} });

describe('LibanPost mobile guest tracking', () => {
  it('reads the whole bound history, keeping international wall clocks and stripping signatures', () => {
    const result = parseLibanPost(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Item delivered', last_update: null, last_update_local: '2025-11-12T08:41:00',
      service_name: 'LETTERS (LC/AO)', destination_country: 'LB' });
    expect(result.events).toHaveLength(8);
    expect(result.events![0]).toEqual({ local_time: '2025-11-12T08:41:00', description: 'Item delivered',
      location: 'LEBANON-SAMPLE DELIVERY OFFICE', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2025-10-16T15:30:00', stage: 'accepted', location: 'CHINA-SAMPLE POST' });
    expect(result.events!.every(event => !event.time && !event.time_zone)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Sample Recipient|Signed|Sending date|10\/16\/2025/);
  });

  it('does not confuse a prefilled field or another returned identity with the requested item', () => {
    for (const shown of ['ZZ000000028CN', `${NUMBER}${' '.repeat(200)}A`]) {
      expect(() => parseLibanPost(fixture().replace(`<span class="trackNumber">${NUMBER}</span>`, `<span class="trackNumber">${shown}</span>`), NUMBER))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseLibanPost(fixture().replace('Shipment number', 'Reference'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLibanPost(`<form><input value="${NUMBER}"></form>`, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLibanPost(fixture().replaceAll('LEBANON', 'SAMPLE COUNTRY'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('uses only the explicit native negative, leaving empty forms and verification inconclusive', () => {
    expect(() => parseLibanPost(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLibanPost('<div id="cpMain_panelTrace"></div>', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLibanPost('<div id="cpMain_divNoData">Temporary unavailable</div>', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLibanPost('<html><title>Just a moment</title></html>', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseLibanPost('<div class="g-recaptcha"></div>', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseLibanPost(' ', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects malformed, duplicate and oversized sections rather than inventing history', () => {
    for (const html of [fixture().replace('16/10/2025', '31/02/2025'), fixture().replace('15:30', '24:00'),
      fixture().replace('class="trackTime"', 'class="changed"'), fixture().replace('class="trackEvent"', 'class="changed"'),
      fixture().replace('<div id="cpMain_divTrackTable">', '<div id="changed">'),
      fixture()+fixture(), fixture().replace('Shipment number', 'Shipment number</label><span class="trackNumber">Sample</span><label>')]) {
      expect(() => parseLibanPost(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseLibanPost(fixture().replace(/<div class="trackingListing">[\s\S]*<\/div><\/body>/, '</div></body>'), NUMBER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it('preserves page sequence across unlike facility clocks and deduplicates identical scans', () => {
    const row = /<div class="trackingListing">[\s\S]*?<\/div><\/div>/.exec(fixture())![0];
    const duplicate = fixture().replace('</div></body>', row + '</div></body>');
    expect(parseLibanPost(duplicate, NUMBER).events).toHaveLength(8);
    const changed = fixture().replace('12/11/2025', '06/11/2025').replace('08:41', '21:59');
    const result = parseLibanPost(changed, NUMBER);
    expect(result.events![0]).toMatchObject({ description: 'Item delivered', local_time: '2025-11-06T21:59:00' });
    expect(result.events![1]).toMatchObject({ local_time: '2025-11-06T22:07:00' });
  });

  it('maps observed wordings and preserves an unknown event without claiming its stage', () => {
    const result = parseLibanPost(fixture().replace('Item delivered Signed: Sample Recipient', 'Sample processing notice'), NUMBER);
    expect(result.events![0]).not.toHaveProperty('stage');
    for (const entry of statuses.entries) expect(libanPostWordingStage(entry.wording)).toBe(entry.stage);
  });

  it('reads through the supplied transport with one whole query, host user agent, signal and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LibanPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz 000 000 014 cn ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LIBANPOST_ENDPOINT}?sn=${NUMBER}&lang=2`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'libanpost', outcome: 'ok', attempts: 1 }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [302, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s without retrying it', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('not-found'), status));
      await expect(factory(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('retries a network failure once and retains recovery provenance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LibanPostTracker({ fetcher, recorder }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'transport' }));
  });

  it('keeps exact negative recognition, rejects bad input and respects cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('not-found')));
    await expect(factory(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    for (const n of ['', 'SAMPLE', 'ZZ'.repeat(30), '123?secret=value']) await expect(factory(fetcher).track({ number: n })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(normalizeLibanPostNumber(' px-789 654 321 09 ')).toBe('PX78965432109');
    const control = new AbortController();const reason = new Error('Synthetic cancellation');control.abort(reason);
    await expect(factory(fetcher).track({ number: NUMBER }, { signal: control.signal })).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
