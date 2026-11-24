import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, RUNNER_EXPRESS_TRACK, runnerExpressLookupUrl, RunnerExpressTracker } from './adapter.js';
import { normalizeRunnerExpressNumber, parseRunnerExpress } from './parser.js';
import { runnerExpressMappedStage, runnerExpressStage, statusMap } from './status.js';
import corpus from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// The public sample, whose page is `fixtures/returned.html`.
const SAMPLE = (corpus.records as { number: string; context?: { assessment?: string } }[])
  .find((record) => record.context?.assessment === 'confirmed')!.number;
// The synthetic number of the sample's shape that `fixtures/not-found.html` answers.
const UNKNOWN = 'ZYIL3141592653589';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';
const NEWEST = '2026-05-19 08:09:41 UTC+2:00 returned to shipper';
const OLDEST = '2026-02-07 06:30:29 UTC+2:00 Shipment Information Received';

/** The sample's page with its newest scan line replaced. */
const newest = (line: string) => text('returned.html').replace(`<li>${NEWEST}</li>`, `<li>${line}</li>`);

describe('Runner Express HTTP adapter', () => {
  it('opens the tracker with the number in the form\'s one field, through the supplied transport', async () => {
    const fetcher = replying(() => html(text('returned.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new RunnerExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${SAMPLE.slice(0, 4).toLowerCase()} ${SAMPLE.slice(4)} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'returned' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://runnerexpress.co.il/track/?search_query=${SAMPLE}`);
    expect(url).toBe(`${RUNNER_EXPRESS_TRACK}?search_query=${SAMPLE}`);
    expect(url).toBe(runnerExpressLookupUrl(SAMPLE));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'runner-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s history newest first, each scan at the offset it states', () => {
    const result = parseRunnerExpress(text('returned.html'), SAMPLE);
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'returned to shipper', last_update: '2026-05-19T08:09:41+02:00', expected_delivery: null,
    });
    expect(result).not.toHaveProperty('last_update_local');
    const events = result.events!;
    expect(events).toHaveLength(36);
    expect(events[0]).toEqual({ time: '2026-05-19T08:09:41+02:00', description: 'returned to shipper', stage: 'returned', stage_source: 'carrier_map' });
    // The line's line break is the page's; the wording keeps its own spelling.
    expect(events[3]).toEqual({ time: '2026-04-19T10:17:49+02:00', description: 'On the way back to Sorting Center', stage: 'returned', stage_source: 'carrier_map' });
    expect(events[4]).toMatchObject({ description: 'enReady to back to Sorting Center', stage: 'returned' });
    // The origin warehouse and the flight's departure state UTC+8, the landing and customs in Israel UTC+2, with or without a leading zero.
    expect(events.slice(29, 34).map(({ time, description }) => [time, description])).toEqual([
      ['2026-02-25T10:14:16+02:00', 'Held at Clearance Facility – Declaration submitted'],
      ['2026-02-24T13:17:00+02:00', 'Flight arrive at destination airpot'],
      ['2026-02-24T01:53:00+08:00', 'Flight depart'],
      ['2026-02-20T10:30:00+08:00', 'Transport delay, Wait for flight.'],
      ['2026-02-12T16:45:31+08:00', 'The shenzhen warehouse has been sent out'],
    ]);
    expect(events.at(-1)).toEqual({ time: '2026-02-07T06:30:29+02:00', description: 'Shipment Information Received', stage: 'registered', stage_source: 'carrier_map' });
    expect(events.map((event) => event.stage)).toEqual([
      ...Array(5).fill('returned'), ...Array(20).fill('ready_for_pickup'), 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit',
      'customs', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered',
    ]);
    // Every scan is mapped, has an instant and no wall clock or place.
    expect(events.every((event) => event.stage_source === 'carrier_map' && typeof event.time === 'string'
      && event.local_time === undefined && event.location === undefined)).toBe(true);
    // Instants run back in time down the list.
    const instants = events.map((event) => Date.parse(event.time!));
    expect(instants.every((instant, index) => index === 0 || instant <= instants[index - 1]!)).toBe(true);
  });

  it('never reads a recipient the summary could show', () => {
    const page = text('returned.html').replace('<span>TimeZone：</span>',
      '<span>Recipient information：</span>\n<span>RECIPIENT NAME, RECIPIENT STREET 1, 0500000000</span>\n</td><td><span>TimeZone：</span>');
    const result = parseRunnerExpress(page, SAMPLE);
    expect(result.events).toHaveLength(36);
    expect(JSON.stringify(result)).not.toMatch(/RECIPIENT|0500000000/);
    for (const field of ['receiver_name', 'receiver_address', 'signed_by']) expect(result).not.toHaveProperty(field);
  });

  it('keeps a scan without an offset as a wall clock, and turns an oldest-first list round', () => {
    const wall = parseRunnerExpress(newest('2026-05-20 09:00:00 returned to shipper'), SAMPLE);
    expect(wall.events![0]).toEqual({ local_time: '2026-05-20T09:00:00', description: 'returned to shipper', stage: 'returned', stage_source: 'carrier_map' });
    expect(wall).toMatchObject({ last_update: null, last_update_local: '2026-05-20T09:00:00' });
    expect(parseRunnerExpress(newest('2026-05-19 08:09:41 UTC-3:30 returned to shipper'), SAMPLE).events![0])
      .toMatchObject({ time: '2026-05-19T08:09:41-03:30' });
    const page = text('returned.html');
    const reversed = page.replace(`<li>${NEWEST}</li>`, '<li>NEWEST</li>').replace(`<li>${OLDEST}</li>`, `<li>${NEWEST}</li>`)
      .replace('<li>NEWEST</li>', `<li>${OLDEST}</li>`);
    const events = parseRunnerExpress(reversed, SAMPLE).events!;
    expect(events[0]).toMatchObject({ description: 'returned to shipper', time: '2026-05-19T08:09:41+02:00' });
    expect(events.at(-1)).toMatchObject({ description: 'Shipment Information Received' });
  });

  it('stages by the newest staged scan, and leaves a wording no rule knows without a stage', () => {
    const delivering = text('returned.html').replace(/<li>2026-05-19[\s\S]*?(?=<li>2026-02-26 20:31:19)/, '');
    expect(parseRunnerExpress(delivering, SAMPLE)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for delivery' });
    const note = '<li>2026-02-27 09:00:00 UTC+2:00 Synthetic note</li>';
    const noted = parseRunnerExpress(delivering.replace('<li>2026-02-26 20:31:19', `${note}<li>2026-02-26 20:31:19`), SAMPLE);
    expect(noted.events![0]).toEqual({ time: '2026-02-27T09:00:00+02:00', description: 'Synthetic note' });
    expect(noted).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Synthetic note' });
    // A newer scan no rule knows may have undone a return, so the parcel keeps no stage.
    const returned = parseRunnerExpress(newest('2026-05-20 09:00:00 UTC+2:00 Synthetic note'), SAMPLE);
    expect(returned).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
    expect(returned).not.toHaveProperty('current_stage');
  });

  it('reads the tracker\'s "not found" as a missing parcel, its request binding it to the number', async () => {
    expect(() => parseRunnerExpress(text('not-found.html'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: UNKNOWN.toLowerCase() }))
      .rejects.toMatchObject({ kind: 'not_found' });
    // Another notice, or two, is no answer; beside a parcel's details the notice is passed over.
    expect(() => parseRunnerExpress(text('not-found.html').replace('This logistics item was not found', 'Please try again later'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRunnerExpress(text('returned.html').replace('<table>', '<p>This logistics item was not found</p><table>'), SAMPLE))
      .not.toThrow();
    expect(() => parseRunnerExpress(text('not-found.html').replace('<p>This logistics item was not found</p>',
      '<p>This logistics item was not found</p><p>This logistics item was not found</p>'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only a page that names the whole number asked', () => {
    const page = text('returned.html');
    const echoed = `<span>${SAMPLE}</span>`;
    expect(() => parseRunnerExpress(page, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Runner Express answered for another number' }));
    expect(() => parseRunnerExpress(page.replace(echoed, `<span>${SAMPLE}0</span>`), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Runner Express answered for another number' }));
    expect(() => parseRunnerExpress(page.replace(echoed, `<span>${SAMPLE.slice(0, -1)}</span>`), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Runner Express answered for another number' }));
    expect(() => parseRunnerExpress(page.replace(echoed, '<span></span>'), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Runner Express did not name the waybill' }));
    expect(() => parseRunnerExpress(page.replace('Way Bill No：', 'Order No：'), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Runner Express did not name the waybill' }));
    expect(parseRunnerExpress(page.replace(echoed, `<span> ${SAMPLE.toLowerCase()} </span>`), SAMPLE)).toMatchObject({ current_stage: 'returned' });
  });

  it('rejects a changed page', () => {
    const page = text('returned.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      page.replace('company-desc', 'company-text'),
      page.replace('</table>', '</table><table></table>'),
      page.replace(/<ul>[\s\S]*<\/ul>/, ''),
      page.replace('<h3>Web Tracking Details</h3>', '<h3>Details</h3>'),
      newest('19/05/2026 08:09:41 UTC+2:00 returned to shipper'),
      newest('2026-05-19 08:09 UTC+2:00 returned to shipper'),
      newest('2026-02-30 08:09:41 UTC+2:00 returned to shipper'),
      newest('2026-05-19 24:09:41 UTC+2:00 returned to shipper'),
      newest('2026-05-19 08:09:41 UTC+15:00 returned to shipper'),
      newest('2026-05-19 08:09:41 UTC+2:60 returned to shipper'),
      newest('2026-05-19 08:09:41 UTC+2 returned to shipper'),
      newest('2026-05-19 08:09:41 GMT+2:00 returned to shipper'),
      newest('2026-05-19 08:09:41 UTC+2:00'),
      newest('returned to shipper'),
      page.replace('<h3>Web Tracking Details</h3></li>', `<h3>Web Tracking Details</h3></li>${`<li>${NEWEST}</li>`.repeat(501)}`),
    ].entries()) {
      expect(() => parseRunnerExpress(body, SAMPLE), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a parcel whose list holds no scan', () => {
    const empty = text('returned.html').replace(/(<\/h3><\/li>)[\s\S]*(<\/ul>)/, '$1$2');
    expect(() => parseRunnerExpress(empty, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a browser check, a refusal, a moved route and a broken page apart from a missing parcel', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: SAMPLE });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://runnerexpress.co.il/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response('{"sample":true}', { headers: { 'Content-Type': 'application/json' } }))).rejects.toMatchObject({ kind: 'schema' });
    // A page that carries the parcel is the tracker's, whatever else it embeds.
    await expect(lookup(() => html(text('returned.html').replace('</body>', '<div class="g-recaptcha"></div></body>'))))
      .resolves.toMatchObject({ current_stage: 'returned' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: SAMPLE })).rejects.toMatchObject({ kind });
  });

  it('tries a network failure once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(html(text('returned.html')));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'returned' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: UNKNOWN }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('refuses what is no number, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZYIL1', 'ZYILZYIL', 'Z'.repeat(40) + '1', `${UNKNOWN},${SAMPLE}`, 'ZYIL/3141592653589', `${UNKNOWN}?`, '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: UNKNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeRunnerExpressNumber(' zyil-3141 5926 53589 ')).toBe(UNKNOWN);
  });

  it('declares no recognition: no rule offers Runner Express', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });
});

describe('Runner Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    expect(STATUS_MAPS['runner-express']).toBe(statusMap);
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(runnerExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves another wording to the shared rules', () => {
    expect(runnerExpressMappedStage('delivered')).toBeUndefined();
    expect(runnerExpressStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(runnerExpressStage('Synthetic note')).toBeNull();
    expect(statusMap.stage(null, normalizeStatusWording('Synthetic note'))).toBeUndefined();
  });
});
