import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MARK_DETAIL, MarkTracker } from './adapter.js';
import { isMarkErrorPage, normalizeMarkNumber, parseMark } from './parser.js';
import { markMappedStage, markStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample whose reply the fixture keeps, and the made-up number of the not-found reply.
const DELIVERED = '200633738';
const UNKNOWN = '999999990';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const TRACK = /(<table id="tblTrack1"[^>]*>)[\s\S]*?(<\/table>)/;
const DELIVERY = /(<table id="tblDelivery"[^>]*>)[\s\S]*?(<\/table>)/;
const STATUS = /(<span id="lblStatus"[^>]*>)[\s\S]*?(<\/span>)/;
const DATE = /(<span id="txtDate"[^>]*>)[\s\S]*?(<\/span>)/;
const TRACK_HEAD = '<tr><th>T.Type</th><th>Date</th><th>Time</th><th>Transit Route</th></tr>';
const DELIVERY_HEAD = '<tr><th>Date/Time</th><th>Delivery Branch</th><th>Receiver</th><th>Status</th><th>Scan</th></tr>';
type Scan = [type: string, day: string, clock: string, route: string];
type Delivery = [when: string, branch: string, receiver: string, status: string, scan: string];
const row = (cells: readonly string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
/** The delivered reply with its scans, its deliveries, its booking time or its status line replaced. */
const page = ({ scans, deliveries, status, booked }: { scans?: Scan[]; deliveries?: Delivery[]; status?: string; booked?: string }) => {
  let html = fixture('delivered');
  if (scans) html = html.replace(TRACK, (_, open: string, close: string) => open + TRACK_HEAD + scans.map(row).join('') + close);
  if (deliveries) html = html.replace(DELIVERY, (_, open: string, close: string) => open + DELIVERY_HEAD + deliveries.map(row).join('') + close);
  if (booked !== undefined) html = html.replace(DATE, `$1${booked}$2`);
  return status === undefined ? html : html.replace(STATUS, `$1${status}$2`);
};
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => answer());
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const scan = (local_time: string, location: string, description: string, provider_code: string) => (
  { local_time, location, description, provider_code, stage: 'in_transit', stage_source: 'carrier_map' });

describe('Mark Express HTTP adapter', () => {
  it('opens the tracking page for the number through the supplied transport', async () => {
    const fetcher = answering(() => reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MarkTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 2006 33738 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([`${MARK_DETAIL}?docno=${DELIVERED}`, expect.objectContaining({ method: 'GET', redirect: 'manual',
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' }, signal: expect.any(AbortSignal) })]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'mark-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered air waybill: the booking, the scans and the delivery newest first, on the offices’ wall clocks', () => {
    const result = parseMark(fixture('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'DELIVERED ON 26/06/26 BY THANE-HUB (MUMBAI)', last_update: null, last_update_local: '2026-06-26T14:57:00',
      expected_delivery: null, timezone: 'Asia/Kolkata', receiver_name: 'HARESH VIVIANA MALL MUMBAI',
      events: [
        { local_time: '2026-06-26T14:57:00', location: 'THANE-HUB (MUMBAI)', description: 'DELIVERED', stage: 'delivered',
          stage_source: 'carrier_map' },
        scan('2026-06-24T11:48:00', 'THANE-HUB (MUMBAI)', 'Inward At THANE-HUB (MUMBAI)', 'IN-SCAN'),
        scan('2026-06-24T08:53:00', 'MUMBAI-R.O', 'Out To THANE-HUB (MUMBAI)', 'OUT-SCAN'),
        scan('2026-06-24T05:37:00', 'MUMBAI-R.O', 'Inward At MUMBAI-R.O', 'IN-SCAN'),
        scan('2026-06-23T22:29:00', 'PUNE-R.O', 'Out To MUMBAI-R.O', 'OUT-SCAN'),
        scan('2026-06-23T21:59:00', 'PUNE-R.O', 'Inward At PUNE-R.O', 'IN-SCAN'),
        { local_time: '2026-06-23T21:30:00', location: 'MANGALWAR PETH-PUNE', description: 'Booked By MANGALWAR PETH-PUNE',
          stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The offices' addresses and phone numbers, in the names' tooltips, and the delivery's receiver column stay out.
    expect(JSON.stringify(result.events)).not.toMatch(/MAHARASHTRA|Ph:|\d{9}|HARESH/);
  });

  it('keeps an air waybill on its way in transit, from its newest scan, and a booking alone as accepted', () => {
    const moving = parseMark(page({ deliveries: [], status: 'Out To MUMBAI-R.O Dated 23/06/26' }), DELIVERED);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Out To MUMBAI-R.O Dated 23/06/26',
      last_update_local: '2026-06-24T11:48:00' });
    const booked = parseMark(page({ scans: [], deliveries: [], status: '' }), DELIVERED);
    expect(booked).toMatchObject({ current_stage: 'accepted', last_status_text: 'Booked By MANGALWAR PETH-PUNE',
      last_update_local: '2026-06-23T21:30:00', events: [{ description: 'Booked By MANGALWAR PETH-PUNE' }] });
  });

  it('keeps a midnight or missing clock as the day, text it cannot read as printed, and an unknown scan type as its code alone', () => {
    const result = parseMark(page({
      booked: '23/06/26',
      scans: [
        ['IN-Scan', '23/06/26', '12:00 AM', 'From: <a>MANGALWAR PETH-PUNE</a> To: <a>PUNE-R.O</a>'],
        ['RTO-Scan', '24/06/26', '09:15 AM', 'Return to A PERSON 9876543210'],
        ['OUT-Scan', '24/06/26', 'late', 'Out To <a>MUMBAI-R.O</a> From: <a>PUNE-R.O</a>'],
      ],
      deliveries: [],
      status: 'CONTACT 98765 43210',
    }), DELIVERED);
    expect(result.events).toEqual([
      { provider_time_text: '24/06/26 late', location: 'PUNE-R.O', description: 'Out To MUMBAI-R.O', provider_code: 'OUT-SCAN',
        stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-06-24T09:15:00', description: 'RTO-SCAN', provider_code: 'RTO-SCAN' },
      scan('2026-06-23', 'PUNE-R.O', 'Inward At PUNE-R.O', 'IN-SCAN'),
      { local_time: '2026-06-23', location: 'MANGALWAR PETH-PUNE', description: 'Booked By MANGALWAR PETH-PUNE', stage: 'accepted',
        stage_source: 'carrier_map' },
    ]);
    // A status line without a known wording leaves the stage to the newest staged row; its phone number is dropped.
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'CONTACT' });
  });

  it('reads the made-up number’s reply, its fields and tables empty under the not-found notice, as not found', async () => {
    expect(() => parseMark(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(answering(() => reply(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a reply for another number, an empty page without the notice and a changed page', () => {
    expect(() => parseMark(fixture('delivered'), '200633739')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = fixture('not-found').replace(STATUS, '$1$2');
    expect(() => parseMark(empty, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMark(fixture('delivered').replace('id="tblTrack1"', 'id="tblTrack2"'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMark(page({ scans: [['IN-Scan', '23/06/26', '09:59 PM', 'PUNE-R.O']] }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMark(page({ scans: [['IN-Scan', '23/06/26', '09:59 PM']] as unknown as Scan[] }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMark(CHECK, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps refusals, the error page, moved routes and missing pages apart from a missing parcel', async () => {
    await expect(carrier(answering(() => reply(CHECK, 403))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(carrier(answering(() => reply('Forbidden', 403))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(answering(() => reply(CHECK))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(answering(() => reply('', 302, { Location: '/_NotAvailable.aspx' }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(answering(() => reply('', 302, { Location: 'https://markexpress.co.in/' }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(answering(() => reply('Not Found', 404))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(answering(() => reply('Busy', 429))).track({ number: DELIVERED })).rejects.not.toMatchObject({ kind: 'not_found' });
    expect(isMarkErrorPage('https://crm.markerp.in/_NotAvailable.aspx')).toBe(true);
    expect(isMarkErrorPage('https://example.com/_NotAvailable.aspx')).toBe(false);
    expect(isMarkErrorPage(null)).toBe(false);
  });

  it('retries one attempt that fails to reach the site, and never an HTTP status', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const busy = answering(() => reply('Busy', 503));
    await expect(carrier(busy).track({ number: DELIVERED })).rejects.toBeDefined();
    expect(busy).toHaveBeenCalledTimes(1);
  });

  it('recognizes a found air waybill and not a missing one', async () => {
    await expect(carrier(answering(() => reply(fixture('delivered')))).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(answering(() => reply(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toMatchObject({ known: false });
  });

  it('takes six to twelve digits and nothing else', () => {
    expect(normalizeMarkNumber(' 200-633-738 ')).toBe(DELIVERED);
    for (const bad of ['12345', '1234567890123', 'M200633738', '']) {
      expect(() => normalizeMarkNumber(bad)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('leaves its nine-digit numbers unclaimed by detection', () => {
    expect(detectCarrierMatch(DELIVERED).carrier).not.toBe('mark-express');
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('mark-express');
  });
});

describe('Mark Express status vocabulary', () => {
  it('maps every recorded scan type and wording to the stage it records', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    for (const entry of entries) {
      const code = entry.code ?? null;
      expect(markStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(markMappedStage(code, entry.wording), entry.wording).toBe(entry.stage);
    }
    // An inward scan at the delivering hub is not a delivery, and out for delivery comes from the shared wordings.
    expect(markStage('IN-SCAN', 'Inward At THANE-HUB (MUMBAI)')?.stage).toBe('in_transit');
    expect(markStage(null, 'OUT FOR DELIVERY')?.stage).toBe('out_for_delivery');
    expect(markStage(null, 'SAMPLE NOTICE')).toBeNull();
  });
});
