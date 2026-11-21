import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SEKO_PAGE, SekoTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeSekoNumber, parseSekoPage } from './parser.js';
import { sekoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const DELIVERED = 'SMPLE0000001';
const IN_TRANSIT = 'SMP0000002';
const UNKNOWN = '000000003';
// The shipping number a Trustpilot review gives; public-delivered.html is SEKO's page for it.
const PUBLIC = numbers.records.find((record) => record.source.url.includes('trustpilot.com'))!.number;

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
/** The page with more rows at the end of its history table. */
const withRows = (html: string, rows: [string, string, string][]) => html.replace('</table>',
  `${rows.map(([date, time, text]) => `<tr><th>${date}</th><th style="white-space: nowrap;">${time}</th><th>${text}</th></tr>`).join('')}</table>`);
const withoutRows = (html: string) => html.replace(/<tr>[\s\S]*?<\/tr>/g, '');
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
// SEKO's page for a number it does not know.
const missingPage = (number: string) => `<!DOCTYPE html><html><head><title>Track My Shipment | SEKO Logistics</title></head><body>
<main data-site-id="1086" data-culture="en"><div class="package-tracking"><div class="container py-32"><div class="row"><div class="col-12 col-md-8">
<h1 class="text-uppercase">Track My Shipment</h1><form method="get">
<p class="text-danger">No results found for tracking number: &quot;${number}&quot;.</p>
<textarea class="form-control" rows="5" name="trackingNumbers" id="trackingNumberString"></textarea></form></div></div></div></div></main>
<footer class="footer"></footer></body></html>`;
const missing = (number = UNKNOWN) => reply(missingPage(number));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('SEKO HTTP adapter', () => {
  it('asks SEKO’s tracking page for the whole number in capitals once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SekoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' smp 000-0002 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SEKO_PAGE}${IN_TRANSIT}`);
    expect(String(url)).toBe('https://www.sekologistics.com/en/track/?trackingNumbers=SMP0000002');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.body).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'seko', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each milestone’s wall clock, newest first, and stages it by SEKO’s statuses', () => {
    const result = parseSekoPage(page('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Status Changed to [At Delivery Terminal]', last_update: null, last_update_local: '2026-05-07T09:55:00',
      expected_delivery: '2026-05-11', expected_delivery_from: '2026-05-09', service_name: 'SEKO 3-5 Day', destination_country: 'US' });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.description])).toEqual([
      ['2026-05-07T09:55:00', 'in_transit', 'Status Changed to [At Delivery Terminal]'],
      ['2026-05-06T10:25:00', 'in_transit', 'Status changed to [At Transfer Terminal]'],
      ['2026-05-04T23:40:00', 'in_transit', 'Status changed to [In Transit to Delivery Terminal]'],
      // The page lists the newer record first within a minute.
      ['2026-05-04T15:05:00', 'accepted', 'Status Changed to [At Pickup Terminal]'],
      ['2026-05-04T15:05:00', 'registered', 'Status Changed to [Arrived at PU location]'],
      ['2026-05-03T14:10:00', 'registered', 'Shipment Created'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined
      && event.stage_source === 'carrier_map')).toBe(true);
    // The page gives the weight without its unit.
    expect(result).not.toHaveProperty('weight_kg');
    expect(result).not.toHaveProperty('summary_only');
  });

  it('keeps the delivery without its proof-of-delivery records, the signer, the references or the postcodes', () => {
    const result = parseSekoPage(page('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Status Changed to [Shipment Delivered]', last_update_local: '2026-03-16T13:42:00', expected_delivery: null,
      service_name: 'SEKO 3-5 Day', destination_country: 'US' });
    expect(result).not.toHaveProperty('expected_delivery_from');
    expect(result.events!.map((event) => [event.stage, event.description])).toEqual([
      ['delivered', 'Status Changed to [Shipment Delivered]'],
      ['out_for_delivery', 'Status Changed to [Driver on site Delivery Location]'],
      ['out_for_delivery', 'Status Changed to [Shipment is Out for Delivery]'],
      ['in_transit', 'Status Changed to On Hand Destination Station-'],
      ['in_transit', 'Status Changed to [In Transit to Delivery Terminal]'],
      // The status change repeated in lower case at the same minute is kept once.
      ['accepted', 'Status Changed to [At Pickup Terminal]'],
      ['in_transit', 'Shipment in transit to Delivery Station.'],
      ['registered', 'Shipment information received'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Sample (?:Signer|Town|City)|SAMPLE|0000[01]\b|POD|11:42|150|Mar 16/i);
  });

  it('reads the page SEKO serves for a public shipment', () => {
    const result = parseSekoPage(page('public-delivered'), PUBLIC);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Status Changed to [Shipment Delivered]',
      last_update_local: '2025-12-18T11:06:00', expected_delivery: null, service_name: 'SEKO 3-5 Day', destination_country: 'US' });
    expect(result.events!.map((event) => [event.local_time, event.stage])).toEqual([
      ['2025-12-18T11:06:00', 'delivered'],
      ['2025-12-18T10:55:00', 'out_for_delivery'],
      ['2025-12-18T08:14:00', 'out_for_delivery'],
      ['2025-12-16T17:00:00', 'in_transit'],
      ['2025-12-13T01:29:00', 'in_transit'],
      ['2025-12-12T17:20:00', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Wolff|WALHALLA|SAN DIEGO|29691|92120|DOORS|331|12:06/i);
  });

  it('reads an expected day or window, and leaves out wording it does not know', () => {
    const transit = page('in-transit');
    const estimate = (wording: string) => parseSekoPage(transit.replace('Estimated delivery between: 5/9/2026 - 5/11/2026', wording), IN_TRANSIT);
    expect(estimate('Expected Arrival : May 11, 2026')).toMatchObject({ expected_delivery: '2026-05-11' });
    expect(estimate('Expected Arrival : May 11, 2026')).not.toHaveProperty('expected_delivery_from');
    expect(estimate('Estimated delivery between: 5/11/2026 - 5/11/2026')).not.toHaveProperty('expected_delivery_from');
    expect(estimate('Delivery date to be confirmed')).toMatchObject({ expected_delivery: null });
    expect(parseSekoPage(transit.replace(/<p class="due-date">[\s\S]*?<\/p>/, ''), IN_TRANSIT)).toMatchObject({ expected_delivery: null });
    for (const wording of ['Expected Arrival : Feb 30, 2026', 'Estimated delivery between: 5/9/2026 - 13/11/2026']) {
      expect(() => estimate(wording), wording).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('stages wording SEKO’s map does not know by the shared rules, and leaves the rest without a stage', () => {
    const result = parseSekoPage(withRows(page('in-transit'), [['5/8/2026', '08:00 AM', 'Synthetic &amp; note'],
      ['5/8/2026', '09:00 AM', 'Status Changed to [Delivery attempted]']]), IN_TRANSIT);
    expect(result.events!.slice(0, 2).map((event) => [event.description, event.stage ?? null])).toEqual([
      ['Status Changed to [Delivery attempted]', 'failed_attempt'],
      ['Synthetic & note', null],
    ]);
    expect(result.events![0]!.stage_source).toMatch(/^wording:/);
    expect(result).toMatchObject({ current_stage: 'failed_attempt' });
    // A hold is a milestone too.
    expect(parseSekoPage(withRows(page('in-transit'), [['5/8/2026', '10:00 AM', 'Status Changed to [Temporary Destination Hold]']]), IN_TRANSIT))
      .toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', expected_delivery: '2026-05-11' });
    // Wording without a stage leaves the newest staged milestone the say.
    expect(parseSekoPage(withRows(page('in-transit'), [['5/8/2026', '10:00 AM', 'Synthetic note']]), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic note' });
  });

  it('answers a shipment without milestones as no history', () => {
    expect(() => parseSekoPage(withoutRows(page('in-transit')), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseSekoPage(page('in-transit').replace(/<table[\s\S]*?<\/table>/, ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // Proof-of-delivery records alone are no history.
    expect(() => parseSekoPage(withRows(withoutRows(page('delivered')), [['3/16/2026', '01:42 PM', 'POD Image Attached'],
      ['3/18/2026', '05:00 PM', 'POD IMAGED']]), DELIVERED)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it names the number asked', () => {
    expect(() => parseSekoPage(page('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'SEKO answered for another shipment' }));
    expect(parseSekoPage(page('in-transit').replace('<h1 class="fw-bold m-0">SMP0000002</h1>', '<h1 class="fw-bold m-0"> smp0000002 </h1>'),
      IN_TRANSIT).events).toHaveLength(6);
    expect(() => parseSekoPage(page('in-transit').replace('<p class="mb-0 mt-8">SMP0000002</p>', '<p class="mb-0 mt-8">SMP0000009</p>'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A page for several numbers shows each shipment in turn.
    const both = page('in-transit').replace('<div class="package-tracking">',
      `<div class="package-tracking">${/<div class="container pt-32 shipment-details">[\s\S]*?(?=<div class="col-12 col-md-4)/.exec(page('delivered'))![0]}`);
    expect(parseSekoPage(both, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(parseSekoPage(both, IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    const twice = page('in-transit').replace('<div class="package-tracking">',
      `<div class="package-tracking">${/<div class="container pt-32 shipment-details">[\s\S]*?(?=<div class="col-12 col-md-4)/.exec(page('in-transit'))![0]}`);
    expect(() => parseSekoPage(twice, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSekoPage(missingPage('SMP0000009'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSekoPage(missingPage(IN_TRANSIT.toLowerCase()), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('rejects a changed page', () => {
    const transit = page('in-transit');
    for (const changed of [
      '<html><body><main></main></body></html>',
      transit.replace(/<div class="container pt-32 shipment-details">/, '<div class="container pt-32">'),
      transit.replace(/<h1 class="fw-bold m-0">[^<]*<\/h1>/, ''),
      transit.replace('<th style="white-space: nowrap;">02:10 PM</th>', ''),
      transit.replace('<th>5/3/2026</th>', '<th>2026-05-03</th>'),
      transit.replace('<th>5/3/2026</th>', '<th>2/30/2026</th>'),
      transit.replace('<th style="white-space: nowrap;">02:10 PM</th>', '<th style="white-space: nowrap;">14:10 PM</th>'),
      transit.replace('<th>Shipment Created</th>', '<th> </th>'),
      withRows(transit, Array.from({ length: 495 }, () => ['5/8/2026', '08:00 AM', 'Synthetic note'] as [string, string, string])),
      missingPage(IN_TRANSIT).replace(/<p class="text-danger">[\s\S]*?<\/p>/, ''),
    ]) {
      expect(() => parseSekoPage(changed, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved page, a browser check, a stopped site and a broken page apart', async () => {
    const lookup = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: UNKNOWN });
    await expect(lookup(missing())).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(reply('<html><title>Page not found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response(null, { status: 301, headers: { Location: 'https://www.sekologistics.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    const check = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    await expect(lookup(reply(check))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(reply(check, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // The hosting's page for a stopped site, as SEKO's former tracking lookup answers.
    const stopped = '<!DOCTYPE html><html><head><title>Web App - Unavailable</title></head><body><h1>Error 403 - This web app is stopped.</h1></body></html>';
    await expect(lookup(reply(stopped, { status: 403 }))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(lookup(reply('<html><title>SEKO</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(reply('null'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number SEKO does not issue', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('delivered'))).mockResolvedValueOnce(missing());
    // A local clock dates the last activity without an instant.
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-16T13:42:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('ABC123')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers SEKO does not issue, short references among them, and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ABC', 'SMP000002', 'SAMPLE123456', '1234567', `SMP${'0'.repeat(18)}`, 'SMP0000002/1', 'SMP_0000002']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSekoNumber('smple 000-0001')).toBe(DELIVERED);
    expect(normalizeSekoNumber(UNKNOWN)).toBe(UNKNOWN);
  });

  it('tries a request that fails to reach SEKO once more, and ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('delivered')));
    await clock.settle(expect(carrier(flaky).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' }));
    expect(flaky).toHaveBeenCalledTimes(2);

    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('routes a number filed under SEKO to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(page('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'seko' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'seko', source: 'seko', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${SEKO_PAGE}${DELIVERED}`)).toBe(true);
  });
});

describe('SEKO numbers', () => {
  it('leaves SEKO to an explicit choice, since its layouts are other carriers\' too', () => {
    for (const number of [IN_TRANSIT, DELIVERED, UNKNOWN]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('seko');
    }
  });
});

describe('SEKO status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    const entries = (statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean; confirmedBy: string }[])
      .filter((entry) => entry.code === undefined && entry.wording !== 'Received by Destination Customs');
    expect(entries.length).toBeGreaterThan(30);
    for (const entry of entries) {
      const answer = statusMapAnswer({ carrier: 'seko', providerCode: null, description: entry.wording });
      if (entry.unmapped) {
        expect(sekoStage(entry.wording), entry.wording).toBeNull();
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(sekoStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      // A milestone names the summary's statuses as the one it changed to.
      if (entry.confirmedBy === 'official-doc') expect(sekoStage(`Status Changed to [${entry.wording}]`)?.stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'seko', providerCode: null, description: 'Status Changed to [Return Data Received]' }))
      .toMatchObject({ kind: 'intentional_gap' });
    // The coded entries are OmniParcel's, which this tracker does not read.
    expect(statusMap.stage('OP-72', 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'seko', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
