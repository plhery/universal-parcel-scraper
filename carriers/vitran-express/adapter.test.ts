import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, VITRAN_QUICK_TRACK, VitranTracker } from './adapter.js';
import { normalizeVitranNumber, parseVitran, vitranQuickTrackUrl } from './parser.js';
import { statusMap, vitranStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample whose reply delivered.html keeps, and the made-up number of not-found.html.
const DELIVERED = '51176258';
const UNKNOWN = '7302948165';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const span = (id: string) => new RegExp(`(<span id="${id}"[^>]*>)[^<]*(</span>)`);
type Fields = Partial<Record<'status' | 'number' | 'pickup' | 'label' | 'estimate' | 'delivery' | 'weight' | 'destination', string>>;
const IDS: Record<keyof Fields, string> = {
  status: 'Main_Lbl_status', number: 'Main_Lbl_pronumber', pickup: 'Main_Lbl_pickupdate', label: 'Main_Label10',
  estimate: 'Main_Label11', delivery: 'Main_lbl_Del', weight: 'Main_Lbl_weight', destination: 'Main_Lbl_Dest',
};
/** The delivered reply with some of its answer's values replaced. */
const page = (fields: Fields) => Object.entries(fields).reduce(
  (html, [key, value]) => html.replace(span(IDS[key as keyof Fields]), (_, open: string, close: string) => open + value + close),
  fixture('delivered'));
/** A reply for a shipment on its way, as the page would show it with an estimate; its label is invented. */
const travelling = (fields: Fields = {}) => page({ status: 'In-Transit', label: 'Estimated Delivery Date:', estimate: '04/09/2025',
  delivery: '', ...fields });
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
type Reply = string | (() => Response | Promise<Response>);
const site = (answer: Reply) => vi.fn<typeof fetch>().mockImplementation(async () => (typeof answer === 'string' ? reply(answer) : answer()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const pickup = { local_time: '2025-04-02', location: 'CALEDON, ON', description: 'Picked Up', stage: 'accepted', stage_source: 'carrier_map' };

describe('Vitran Express HTTP adapter', () => {
  it('reads the Quick Track page for the number in one GET, through the supplied transport', async () => {
    const fetcher = site(fixture('delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new VitranTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 5117 6258 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([`${VITRAN_QUICK_TRACK}?p=${DELIVERED}`, expect.objectContaining({
      method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-CA,en;q=0.8', 'User-Agent': 'SyntheticHost/1.0' },
    })]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'vitran-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(vitranQuickTrackUrl(DELIVERED)).toBe('https://www.vitran.com/quicktrack.aspx?p=51176258');
  });

  it('reads a delivered PRO bill: the delivery and the pickup as days, month first, newest first', () => {
    const result = parseVitran(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2025-04-10', expected_delivery: null, weight_kg: 72.575, destination_country: 'CA',
      summary_only: true, events: [
        { local_time: '2025-04-10', location: 'QUEBEC, QC', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        pickup,
      ],
    });
    // The days are bare dates, never instants, and the result passes the shared checks as it is.
    expect(result.events!.every((event) => !event.time)).toBe(true);
    expect(normalizeCarrierResult(result)).toMatchObject({ current_stage: 'delivered', summary_only: true, events: result.events });
  });

  it('reads a shipment on its way with its estimate, which is no event', () => {
    expect(parseVitran(travelling(), DELIVERED)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'In-Transit',
      last_update: null, last_update_local: '2025-04-02', expected_delivery: '2025-04-09', weight_kg: 72.575, destination_country: 'CA',
      summary_only: true, events: [pickup],
    });
    // ASP.NET leaves hidden labels out of the page; the answer stands without them.
    const hidden = travelling().replace(span('Main_lbl_Del'), '').replace(span('Main_Label12'), '');
    expect(parseVitran(hidden, DELIVERED)).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2025-04-09', events: [pickup] });
    expect(parseVitran(hidden.replace(span('Main_Label10'), '').replace(span('Main_Label11'), ''), DELIVERED))
      .toMatchObject({ expected_delivery: null, events: [pickup] });
    expect(parseVitran(hidden, DELIVERED)).not.toHaveProperty('unread_estimates');
  });

  it('dates the delivery only once the status says delivered, and names a day it cannot read yet', () => {
    // A delivery day under another status, or an estimate under another label, is no delivery and no estimate.
    const early = parseVitran(travelling({ delivery: '04/10/2025' }), DELIVERED);
    expect(early).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2025-04-09', events: [pickup], unread_estimates: ['Main_lbl_Del'] });
    const other = parseVitran(travelling({ label: 'Appointment:' }), DELIVERED);
    expect(other).toMatchObject({ expected_delivery: null, events: [pickup], unread_estimates: ['Main_Label11'] });
    expect(parseVitran(travelling({ estimate: 'Next week' }), DELIVERED)).toMatchObject({ expected_delivery: null, unread_estimates: ['Main_Label11'] });
    // Out for delivery is not a delivery.
    const out = parseVitran(page({ status: 'Out for Delivery' }), DELIVERED);
    expect(out).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', events: [pickup], unread_estimates: ['Main_lbl_Del'] });
    expect(out.current_stage_source).toMatch(/^wording:/);
  });

  it('keeps the page’s order on one day and a day it cannot read as printed', () => {
    const sameDay = parseVitran(page({ pickup: '04/10/2025' }), DELIVERED).events!.map((event) => event.description);
    expect(sameDay).toEqual(['Delivered', 'Picked Up']);
    // A single-digit month or day is read as one.
    expect(parseVitran(page({ pickup: '4/2/2025' }), DELIVERED).events![1]).toEqual(pickup);
    const unread = parseVitran(page({ delivery: 'TBD' }), DELIVERED);
    expect(unread.events).toEqual([{ provider_time_text: 'TBD', location: 'QUEBEC, QC', description: 'Delivered', stage: 'delivered',
      stage_source: 'carrier_map' }, pickup]);
    // The newest milestone has no day, so the answer names none.
    expect(unread).not.toHaveProperty('last_update_local');
    // A day that is not on the calendar is not a day.
    expect(parseVitran(page({ pickup: '13/02/2025' }), DELIVERED).events![1]).toMatchObject({ provider_time_text: '13/02/2025' });
  });

  it('reads the weight and destination only when they are what they look like', () => {
    expect(parseVitran(page({ weight: '20.5 kg', destination: 'BUFFALO, NY' }), DELIVERED))
      .toMatchObject({ weight_kg: 20.5, destination_country: 'US' });
    const blank = parseVitran(page({ weight: '', destination: '' }), DELIVERED);
    expect(blank).not.toHaveProperty('weight_kg');
    expect(blank).not.toHaveProperty('destination_country');
    expect(blank.events![0]).not.toHaveProperty('location');
  });

  it('stages a status it does not know by the pickup, and reads one without a status or day as listed', () => {
    expect(parseVitran(page({ status: 'Sample Notice' }), DELIVERED)).toMatchObject({
      status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
      last_status_text: 'Sample Notice', events: [pickup],
    });
    expect(() => parseVitran(page({ status: '', pickup: '', delivery: '' }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
    expect(parseVitran(page({ pickup: '', delivery: '', status: 'In-Transit' }), DELIVERED))
      .toMatchObject({ current_stage: 'in_transit', events: [], summary_only: true });
  });

  it('counts an answer only when it names the number asked', () => {
    expect(() => parseVitran(fixture('delivered'), '51176259'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Vitran answered for another PRO bill' }));
    expect(() => parseVitran(page({ number: '' }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The page for a number it holds nothing for names it only in the form's address.
    expect(() => parseVitran(fixture('not-found'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Vitran answered for another PRO bill' }));
    expect(() => parseVitran(fixture('not-found').replace(`?p=${UNKNOWN}`, ''), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the page’s "Not found." answer as not found', async () => {
    expect(() => parseVitran(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(site(fixture('not-found'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site(fixture('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('keeps a browser check, a moved page, another notice and a broken page apart from missing shipments', async () => {
    const lookup = (answer: Reply) => carrier(site(answer)).track({ number: UNKNOWN });
    const notFound = fixture('not-found');
    await expect(lookup(() => reply(CHECK, 403))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => reply('Forbidden', 403))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('', 302, { Location: '/Error.aspx' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(notFound, 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', 410))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><head><title>Vitran</title></head><body>Site under maintenance</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    // The form alone, without the answer or the notice, is not the not-found page.
    await expect(lookup(notFound.replace(/<span id="Main_Lbl_notvalid"[^>]*>[^<]*<\/span>/, ''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(notFound.replace('Not found.', ''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(notFound.replace('Not found.', 'Please try again later.'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(notFound.replace('id="form1"', 'id="form2"'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response(new Uint8Array(600_000)))).rejects.toThrow('unexpectedly large');
    // An answer beside a notice, or a repeated field, is a changed page.
    const delivered = fixture('delivered');
    expect(() => parseVitran(delivered.replace('<div id="Main_div_content"', '<span id="Main_Lbl_notvalid">Not found.</span><div id="Main_div_content"'),
      DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseVitran(delivered.replace('<span id="Main_Label4"', '<span id="Main_Lbl_status">Delivered</span><span id="Main_Label4"'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s without a retry', async (status, kind) => {
      const fetcher = site(() => reply('<html><title>Error</title></html>', status, { 'Retry-After': '30' }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind, status });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('recognizes a known number by its newest day, and asks nothing for a number Vitran does not issue', async () => {
    const fetcher = site(fixture('delivered'));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!('5117-ABC')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects numbers Vitran does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['511', 'ABC51176258', '1'.repeat(21), `${DELIVERED},${UNKNOWN}`, '', `1${'2'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeVitranNumber(' 5117-6258 ')).toBe(DELIVERED);
  });

  it('tries once more after a failed connection, and keeps a timeout a network failure', async () => {
    const flaky = site(fixture('delivered'));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('leaves its PRO bill numbers unclaimed by detection', () => {
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('vitran-express');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('vitran-express');
  });
});

describe('Vitran Express status vocabulary', () => {
  it('maps every recorded wording to the stage it records, and leaves the rest open', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage?: string }[];
    for (const entry of entries) {
      expect(vitranStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
    }
    expect(statusMap.gaps.map((gap) => gap.wording)).toEqual(['no shipment history']);
    // Out for delivery is not a delivery, and a return is an exception until it is back with the shipper.
    expect(vitranStage('Out for Delivery')?.stage).toBe('out_for_delivery');
    expect(vitranStage('Return to Shipper')?.stage).toBe('exception');
    expect(vitranStage('Returned to Shipper')?.stage).toBe('returned');
    expect(vitranStage('Sample Notice')).toBeNull();
  });
});
