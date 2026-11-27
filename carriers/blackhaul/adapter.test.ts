import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS, statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { createTracker } from '../../facade/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, BlackhaulTracker, blackhaulLookupUrl } from './adapter.js';
import { normalizeBlackhaulNumber, parseBlackhaul } from './parser.js';
import { blackhaulMappedStage, blackhaulStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic consignment of `fixtures/synthetic-delivered.html`.
const DELIVERED = 'ZZZ0000001';
// The synthetic number `fixtures/not-found.html` answers.
const UNKNOWN = 'ZQX0000000017';
const OTHER = 'ZQX0000000018';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';
// The detail-panel address of the depot row, and its ticks.
const DEPOT_ROW = 'Depot+In%3aSAMPLEVILLE%7c%7c2%2f03%2f2026%7c%7c100000001%7c%7c639080256000000000%7c%7c639080256900000000';
const DELIVERY_ROW = /<tr>\n<td><\/td>\n<td class="ScanType" >Delivered<\/td>[\s\S]*?<\/tr>\n/;

/** The consignment before its delivery, out for delivery, with the heading `current`. */
function onDelivery(current = 'On Delivery'): string {
  return text('synthetic-delivered.html').replace(DELIVERY_ROW, '').replace('Current Status: Delivered', `Current Status: ${current}`);
}

describe('Blackhaul HTTP adapter', () => {
  it('opens its portal on Transvirtual\'s tracker with the number in the address', async () => {
    const fetcher = replying(() => html(text('synthetic-delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BlackhaulTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zzz 000-0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://portal.transvirtual.com/Track/654472/${DELIVERED}`);
    expect(url).toBe(blackhaulLookupUrl(DELIVERED));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'blackhaul', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history, newest first, with the instants its ticks and Western Australian clocks give', () => {
    const result = parseBlackhaul(text('synthetic-delivered.html'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-03T10:05:00+08:00', delivered_at: '2026-03-03T10:05:00+08:00',
      expected_delivery: null, weight_kg: 12 });
    expect(result.events).toEqual([
      { time: '2026-03-03T10:05:00+08:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
      // 7:34 in Perth, which is the evening before in UTC.
      { time: '2026-03-02T23:34:00Z', location: 'SAMPLETON', description: 'On Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-03-02T09:00:00Z', location: 'SAMPLEVILLE', description: 'Linehaul Out', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-02T05:20:00Z', location: 'SAMPLEVILLE', description: 'Depot In', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-03-02T08:39:00+08:00', description: 'Pickup Completed', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(result).not.toHaveProperty('last_update_local');
  });

  it('never reads the receiver\'s suburb, postcode or name, or the map\'s points', () => {
    const result = parseBlackhaul(text('synthetic-delivered.html'), DELIVERED);
    for (const field of ['receiver_address', 'receiver_name', 'signed_by', 'sender_name']) expect(result).not.toHaveProperty(field);
    expect(JSON.stringify(result)).not.toMatch(/Sampletown|SAMPLE\b|0000\b|100000001|-10\.0|mydel/);
  });

  it('reads the estimate before the delivery, and a dated status above the history that is newer than every scan', () => {
    expect(parseBlackhaul(onDelivery(), DELIVERED)).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'On Delivery', last_update: '2026-03-02T23:34:00Z', delivered_at: null, expected_delivery: '2026-03-03' });
    const window = onDelivery().replace('1-2 Business Days <br/><small>3/03/2026</small>', '3/03/2026 - 4/03/2026');
    expect(parseBlackhaul(window, DELIVERED)).toMatchObject({ expected_delivery_from: '2026-03-03', expected_delivery: '2026-03-04' });

    const result = parseBlackhaul(onDelivery('Mobile - Card Left: 3/03/2026 11:20 AM AWST'), DELIVERED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Mobile - Card Left',
      last_update: '2026-03-03T11:20:00+08:00', expected_delivery: '2026-03-03' });
    expect(result.events![0]).toEqual({ time: '2026-03-03T11:20:00+08:00', description: 'Mobile - Card Left', stage: 'failed_attempt', stage_source: 'carrier_map' });
    // A dated status the history already reaches adds nothing.
    for (const heading of ['On Delivery: 3/03/2026 7:00 AM AWST', 'Depot In: 2/03/2026']) {
      expect(parseBlackhaul(onDelivery(heading), DELIVERED).events, heading).toHaveLength(4);
    }
  });

  it('keeps a row as its day when its panel address does not bind it, and an unknown zone as a wall clock', () => {
    const page = text('synthetic-delivered.html');
    const depot = (body: string) => parseBlackhaul(body, DELIVERED).events!.find((event) => event.description === 'Depot In');
    for (const changed of [
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('100000001', '100000002')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('%3aSAMPLEVILLE', '%3aSAMPLETON')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('2%2f03', '1%2f03')),
      // Ticks two days off the row's day, or in the wrong order.
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('639080256000000000', '639078528000000000').replace('639080256900000000', '639078528900000000')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace(/639080256900000000$/, '639080255000000000')),
      page.replace(`https://mydel.info/Public/Consignment/ConsignmentTrackingScanChild?id=${DEPOT_ROW}`, `not a url ${DEPOT_ROW}`),
    ]) {
      expect(depot(changed)).toEqual({ local_time: '2026-03-02', location: 'SAMPLEVILLE', description: 'Depot In', stage: 'in_transit', stage_source: 'carrier_map' });
    }
    const result = parseBlackhaul(page.replace('3/03/2026 10:05 AM AWST</td>', '3/03/2026 10:05 AM WIB</td>'), DELIVERED);
    expect(result).toMatchObject({ delivered_at: null, last_update: null, last_update_local: '2026-03-03T10:05:00' });
    expect(result.events![0]).toEqual({ local_time: '2026-03-03T10:05:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads the tracker’s “missing or incorrect” for the number asked as inconclusive, not as a missing consignment', async () => {
    expect(() => parseBlackhaul(text('not-found.html'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: UNKNOWN.toLowerCase() }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // The form's id repeats the address asked: another number's is not this number's answer.
    for (const number of [OTHER, `${UNKNOWN}0`, UNKNOWN.slice(0, -1)]) {
      expect(() => parseBlackhaul(text('not-found.html'), number), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Blackhaul answered for another number' }));
    }
    // Another notice, or another portal's form, is not the tracker's answer.
    expect(() => parseBlackhaul(text('not-found.html').replace('Missing or incorrect tracking number', 'Please try again later'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBlackhaul(text('not-found.html').replace('id="TvNumber" value="654472"', 'id="TvNumber" value="55010"'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only a page that names the whole number asked', () => {
    const page = text('synthetic-delivered.html');
    const label = `'label-Text'>${DELIVERED} `;
    expect(() => parseBlackhaul(page, 'ZZZ0000002'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Blackhaul answered for another consignment' }));
    expect(() => parseBlackhaul(page.replace(label, `'label-Text'>${DELIVERED}0 `), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Blackhaul answered for another consignment' }));
    expect(() => parseBlackhaul(page.replace(label, '\'label-Text\'> '), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Blackhaul did not name the consignment' }));
  });

  it('rejects a changed page or another portal\'s', () => {
    const page = text('synthetic-delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      page.replace('id="TvNumber" value="654472"', 'id="TvNumber" value="VTFE"'),
      page.replace('id="IdConsignment" value="100000001"', 'id="IdConsignment" value="sample"'),
      page.replace('Current Status: Delivered', 'Status: Delivered'),
      page.replace("<th class='Location'>Location</th>", "<th class='Location'>Place</th>"),
      page.replace('<td class="ScanDate" >2/03/2026 8:39 AM AWST</td>', '<td class="ScanDate" >2026-03-02</td>'),
      page.replace('<td class="ScanType" >Linehaul Out</td>', '<td class="ScanType" > </td>'),
    ].entries()) {
      expect(() => parseBlackhaul(body, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const empty = page.replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>');
    expect(() => parseBlackhaul(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps a browser check, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: DELIVERED });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://portal.transvirtual.com/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => new Response('{"Html":""}', { headers: { 'Content-Type': 'application/json' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    await expect(carrier(replying(() => new Response('', { status }))).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
  });

  it('refuses what the carrier does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZZ00', 'ZZZZZZZZZ', `ZZZ${'0'.repeat(28)}`, `${UNKNOWN},${OTHER}`, 'ZZZ/0000001', `${UNKNOWN}?`, '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: UNKNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBlackhaulNumber(' zzz-000 0001 ')).toBe(DELIVERED);
  });

  it('tries a read that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: UNKNOWN }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ended).toEqual([60, 120]);
  });

  it('declares no recognition: the tracker never says a number is unknown', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under Blackhaul to the adapter', async () => {
    const fetcher = replying(() => html(text('synthetic-delivered.html')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'blackhaul' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'blackhaul', source: 'blackhaul', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === blackhaulLookupUrl(DELIVERED))).toBe(true);
  });
});

describe('Blackhaul status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    expect(STATUS_MAPS.blackhaul).toBe(statusMap);
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'blackhaul', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(blackhaulStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves another wording to the shared rules', () => {
    expect(blackhaulMappedStage('card left')).toBeUndefined();
    expect(blackhaulStage('Card Left')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    expect(blackhaulStage('Sample Wording')).toBeNull();
    expect(statusMapAnswer({ carrier: 'blackhaul', description: 'Sample Wording' })).toEqual({ kind: 'unknown' });
  });
});
