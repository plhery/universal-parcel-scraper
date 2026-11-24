import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, VT_FREIGHT_EXPRESS_TRACKER, VtFreightExpressTracker, vtFreightExpressLookupUrl } from './adapter.js';
import { normalizeVtFreightExpressNumber, parseVtFreightExpress } from './parser.js';
import { statusMap, vtFreightExpressMappedStage, vtFreightExpressStage } from './status.js';
import corpus from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// The public sample, whose page is `fixtures/delivered.html`.
const SAMPLE = (corpus.records as { number: string; source?: { url: string }; context?: { assessment?: string } }[])
  .find((record) => record.context?.assessment === 'confirmed' && record.source?.url.includes('parcelpanel'))!.number;
// The synthetic number of the sample's shape that `fixtures/not-found.html` answers.
const UNKNOWN = 'ZZZ5830291746';
const OTHER = 'ZZZ5830291747';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const thrown = (run: () => unknown): { reason?: string } => {
  try {
    run();
  } catch (error) {
    return error as { reason?: string };
  }
  throw new Error('nothing thrown');
};
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';
// The detail-panel address of the sample's depot row, and its ticks.
const DEPOT_ROW = 'Depot+In%3aM1%7c%7c17%2f06%2f2026%7c%7c878040964%7c%7c639172824269770000%7c%7c639172824269770000';
const DELIVERY_ROWS = /<tr>\n<td><\/td>\n<td class="ScanType" >Delivered<\/td>[\s\S]*?<\/tbody>/;

/** The sample's page before its delivery: on board, with the heading `current`. */
function onBoard(current = 'On Board'): string {
  return text('delivered.html').replace(DELIVERY_ROWS, '</tbody>').replace('Current Status: Delivered', `Current Status: ${current}`);
}

describe('VT Freight Express HTTP adapter', () => {
  it('opens the tracker with the number in its address, as the search box does', async () => {
    const fetcher = replying(() => html(text('delivered.html')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new VtFreightExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${SAMPLE.slice(0, 3).toLowerCase()} ${SAMPLE.slice(3)} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://portal.vtfe.com.au/Track/VTFE/${SAMPLE}`);
    expect(url).toBe(`${VT_FREIGHT_EXPRESS_TRACKER}${SAMPLE}`);
    expect(url).toBe(vtFreightExpressLookupUrl(SAMPLE));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'vt-freight-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s delivered history, newest first, with the instants its ticks and its delivery clock give', () => {
    const result = parseVtFreightExpress(text('delivered.html'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-06-19T01:46:43Z', delivered_at: '2026-06-19T01:46:43Z',
      expected_delivery: null, weight_kg: 1 });
    expect(result.events).toEqual([
      { time: '2026-06-19T01:46:43Z', location: 'QLDM', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-06-19T11:46:00+10:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
      // Loaded at 07:27 in Queensland, which is the evening before in UTC.
      { time: '2026-06-18T21:27:48Z', location: 'QLDM', description: 'On Board', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-06-17T08:40:26Z', location: 'M1', description: 'Depot In', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result).not.toHaveProperty('last_update_local');
  });

  it('never reads the receiver\'s suburb, postcode or name', () => {
    const result = parseVtFreightExpress(text('delivered.html'), SAMPLE);
    for (const field of ['receiver_address', 'receiver_name', 'signed_by', 'sender_name']) expect(result).not.toHaveProperty(field);
    expect(JSON.stringify(result)).not.toMatch(/Sampletown|SAMPLE|0000|878040964|mydel/);
  });

  it('reads the estimate before the delivery, and a dated status above the history that is newer than every scan', () => {
    expect(parseVtFreightExpress(onBoard(), SAMPLE)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'On Board', last_update: '2026-06-18T21:27:48Z', delivered_at: null, expected_delivery: '2026-06-19' });
    const window = onBoard().replace('2 Business Days <br/><small>19/06/2026</small>', '18/06/2026 - 19/06/2026');
    expect(parseVtFreightExpress(window, SAMPLE)).toMatchObject({ expected_delivery_from: '2026-06-18', expected_delivery: '2026-06-19' });
    for (const estimate of ['19/06/2026 - 18/06/2026', '31/06/2026', 'Sample', '']) {
      const page = onBoard().replace('2 Business Days <br/><small>19/06/2026</small>', estimate);
      expect(parseVtFreightExpress(page, SAMPLE), estimate).toMatchObject({ expected_delivery: null });
    }

    const result = parseVtFreightExpress(onBoard('On Delivery: 19/06/2026 8:05 AM AEST'), SAMPLE);
    expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'On Delivery', last_update: '2026-06-19T08:05:00+10:00' });
    expect(result.events![0]).toEqual({ time: '2026-06-19T08:05:00+10:00', description: 'On Delivery' });
    // A dated status the history already reaches adds nothing.
    for (const heading of ['On Board: 19/06/2026 7:00 AM AEST', 'Depot In: 17/06/2026']) {
      expect(parseVtFreightExpress(onBoard(heading), SAMPLE).events, heading).toHaveLength(2);
    }
  });

  it('keeps a row as its day when its panel address does not bind it, and an unknown zone as a wall clock', () => {
    const page = text('delivered.html');
    const depot = (body: string) => parseVtFreightExpress(body, SAMPLE).events!.find((event) => event.description === 'Depot In');
    for (const changed of [
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('878040964', '878040965')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('%3aM1', '%3aM2')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('Depot+In', 'Depot+Out')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace('17%2f06', '16%2f06')),
      // Ticks two days off the row's date, or in the wrong order.
      page.replace(DEPOT_ROW, DEPOT_ROW.replaceAll('639172824269770000', '639171096269770000')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace(/639172824269770000$/, '639172824269760000')),
      page.replace(DEPOT_ROW, DEPOT_ROW.replace(/%7c%7c639172824269770000$/, '')),
      page.replace(`<td childSectionUrl='https://mydel.info/Public/Consignment/ConsignmentTrackingScanChild?id=${DEPOT_ROW}'>`, '<td>'),
      page.replace(`https://mydel.info/Public/Consignment/ConsignmentTrackingScanChild?id=${DEPOT_ROW}`, `not a url ${DEPOT_ROW}`),
    ]) {
      expect(depot(changed)).toEqual({ local_time: '2026-06-17', location: 'M1', description: 'Depot In', stage: 'in_transit', stage_source: 'carrier_map' });
    }
    const result = parseVtFreightExpress(page.replace('19/06/2026 11:46 AM AEST</td>', '19/06/2026 11:46 AM NZST</td>'), SAMPLE);
    expect(result.events![1]).toEqual({ local_time: '2026-06-19T11:46:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    // Daylight saving's abbreviation gives its own offset.
    expect(parseVtFreightExpress(page.replace('19/06/2026 11:46 AM AEST</td>', '19/06/2026 11:46 AM AEDT</td>'), SAMPLE).events![1])
      .toMatchObject({ time: '2026-06-19T11:46:00+11:00' });
    // A newest scan without an instant leaves the delivery without one.
    const unbound = page.replace(/639174304031970000/g, '639171096269770000');
    expect(parseVtFreightExpress(unbound, SAMPLE)).toMatchObject({ delivered_at: null, last_update: null, last_update_local: '2026-06-19' });
  });

  it('reads the tracker’s “missing or incorrect” for the number asked as inconclusive, not as a missing consignment', async () => {
    expect(() => parseVtFreightExpress(text('not-found.html'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    await expect(carrier(replying(() => html(text('not-found.html')))).track({ number: UNKNOWN.toLowerCase() }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    // The form's id repeats the address asked: another number's, or none, is not this number's answer.
    for (const number of [OTHER, `${UNKNOWN}0`, UNKNOWN.slice(0, -1)]) {
      const error = thrown(() => parseVtFreightExpress(text('not-found.html'), number));
      expect(error, number).toMatchObject({ kind: 'indeterminate', message: 'VT Freight Express answered for another number' });
      expect(error.reason, number).toBeUndefined();
    }
    expect(() => parseVtFreightExpress(text('not-found.html').replace(`TrackVTFE${UNKNOWN}_`, 'TrackVTFE_'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'VT Freight Express answered for another number' }));
    // The empty form with another notice, or another portal's, is not the tracker's answer.
    expect(() => parseVtFreightExpress(text('not-found.html').replace('Missing or incorrect tracking number', 'Please try again later'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseVtFreightExpress(text('not-found.html').replace('id="TvNumber" value="VTFE"', 'id="TvNumber" value="55010"'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps only a page that names the whole number asked', () => {
    const page = text('delivered.html');
    const label = `'label-Text'>${SAMPLE} `;
    expect(() => parseVtFreightExpress(page, OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'VT Freight Express answered for another consignment' }));
    expect(() => parseVtFreightExpress(page.replace(label, `'label-Text'>${SAMPLE}0 `), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'VT Freight Express answered for another consignment' }));
    expect(() => parseVtFreightExpress(page.replace(label, '\'label-Text\'> '), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'VT Freight Express did not name the consignment' }));
    expect(parseVtFreightExpress(page.replace(label, `'label-Text'>${SAMPLE.toLowerCase()} `), SAMPLE))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed page', () => {
    const page = text('delivered.html');
    for (const [index, body] of [
      '',
      '<html><body><main>Sample maintenance page</main></body></html>',
      page.replace('id="IdConsignment" value="878040964"', 'id="IdConsignment" value="sample"'),
      page.replace('<input type="hidden" name="IdConsignment"', '<input type="hidden" id="IdConsignment" value="1"><input type="hidden" name="IdConsignment"'),
      page.replace('id="TvNumber" value="VTFE"', 'id="TvNumber" value="55010"'),
      page.replace('Current Status: Delivered', 'Status: Delivered'),
      page.replace('GridScansAdv GridScansAdv', 'GridScans'),
      page.replace("<th class='Location'>Location</th>", "<th class='Location'>Place</th>"),
      page.replace('<td class="Location" >M1</td>', ''),
      page.replace('<td class="ScanType" >Depot In</td>', '<td class="ScanType" > </td>'),
      page.replace('<td class="ScanDate" >17/06/2026</td>', '<td class="ScanDate" >2026-06-17</td>'),
      page.replace('<td class="ScanDate" >17/06/2026</td>', '<td class="ScanDate" >31/06/2026</td>'),
      page.replace('>19/06/2026 11:46 AM AEST</td>', '>19/06/2026 13:46 PM AEST</td>'),
      page.replace('>19/06/2026 11:46 AM AEST</td>', '>19/06/2026 11:76 AM AEST</td>'),
      page.replace(/<tbody>\n/, `<tbody>\n${'<tr><td></td><td class="ScanType" >Depot In</td><td class="Location" >X</td><td class="ScanDate" >17/06/2026</td></tr>'.repeat(501)}`),
    ].entries()) {
      expect(() => parseVtFreightExpress(body, SAMPLE), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('has no history for a consignment whose table holds no scan', () => {
    const empty = text('delivered.html').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>');
    expect(() => parseVtFreightExpress(empty, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('reads no weight it cannot parse', () => {
    const page = text('delivered.html');
    expect(parseVtFreightExpress(page.replace('1kgs', 'Sample'), SAMPLE)).not.toHaveProperty('weight_kg');
    expect(parseVtFreightExpress(page.replace('1kgs', '0kgs'), SAMPLE)).not.toHaveProperty('weight_kg');
    expect(parseVtFreightExpress(page.replace('1kgs', '2.5kg'), SAMPLE)).toMatchObject({ weight_kg: 2.5 });
  });

  it('keeps a browser check, a refusal, a moved route and a broken page apart from an unknown number', async () => {
    const lookup = (response: () => Response) => carrier(replying(response)).track({ number: SAMPLE });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://portal.vtfe.com.au/' } })))
      .rejects.toMatchObject({ kind: 'transport', status: 302 });
    await expect(lookup(() => html('<html><body>Sample maintenance page</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response('{"sample":true}', { headers: { 'Content-Type': 'application/json' } }))).rejects.toMatchObject({ kind: 'schema' });
    // A page that carries the consignment is the tracker's, whatever else it embeds.
    await expect(lookup(() => html(text('delivered.html').replace('</body>', '<div class="g-recaptcha"></div></body>'))))
      .resolves.toMatchObject({ current_stage: 'delivered' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = replying(() => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: SAMPLE })).rejects.toMatchObject({ kind });
  });

  it('refuses what the carrier does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZZ00', 'ZZZZZZZZZ', `ZZZ${'0'.repeat(28)}`, `${UNKNOWN},${OTHER}`, 'ZZZ/5830291746', `${UNKNOWN}?`, '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: UNKNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeVtFreightExpressNumber(' zzz-583 029 1746 ')).toBe(UNKNOWN);
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

  it('declares no recognition: the tracker never says a number is unknown', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });
});

describe('VT Freight Express status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    expect(STATUS_MAPS['vt-freight-express']).toBe(statusMap);
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(vtFreightExpressStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves another wording to the shared rules', () => {
    expect(vtFreightExpressMappedStage('card left')).toBeUndefined();
    expect(vtFreightExpressStage('Card Left')).toEqual({ stage: 'failed_attempt', source: 'wording:language' });
    expect(vtFreightExpressStage('Sample Wording')).toBeNull();
    expect(statusMap.stage(null, 'on board')).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('Sample Wording'))).toBeUndefined();
  });
});
