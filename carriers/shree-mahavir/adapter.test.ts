import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MAHAVIR_DETAIL, MAHAVIR_FORM, MahavirTracker } from './adapter.js';
import { MAHAVIR_ORIGIN, mahavirDetailUrl, mahavirLookupFields, normalizeMahavirNumber, parseMahavir } from './parser.js';
import { mahavirMappedStage, mahavirStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples whose replies the fixtures keep, and the made-up number of the not-found reply.
const IN_TRANSIT = '123220046997';
const DISPATCHED = '123220047073';
const BOOKED = '212420029397';
const CONTACT = '160110005291';
const UNKNOWN = '904736218853';
// A key as the server writes it, raw, in the lookup's redirect.
const ENCRYPTED = 'AAAAAAAAAAAAAAAA+BBBBBBBBBBBBBBBB/CCCCCCCCC=';
const LIST = `/Frm_DocList.aspx?docnos=${ENCRYPTED}&Tmp=123456`;
const DETAIL = `${MAHAVIR_DETAIL}?docno=AAAAAAAAAAAAAAAA%2BBBBBBBBBBBBBBBBB%2FCCCCCCCCC%3D`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const TRACK = /(<table id="tblTrack"[^>]*>)[\s\S]*?(<\/table>)/;
const DELIVERY = /(<table id="tblDelivery"[^>]*>)[\s\S]*?(<\/table>)/;
const STATUS = /(<span id="lblStatus"[^>]*>)[\s\S]*?(<\/span>)/;
const TRACK_HEAD = '<tr><th>Job</th><th>Date</th><th>Transit Route</th><th>Time</th></tr>';
const DELIVERY_HEAD = '<tr><th>Date/Time</th><th>Delivery Branch</th><th>Receiver</th><th>Status</th></tr>';
type Job = [job: string, day: string, route: string, clock: string];
type Delivery = [when: string, branch: string, receiver: string, status: string];
const row = (cells: readonly string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
/** The in-transit reply with its jobs, its deliveries or its status line replaced. */
const page = ({ jobs, deliveries, status }: { jobs?: Job[]; deliveries?: Delivery[]; status?: string }) => {
  let html = fixture('in-transit');
  if (jobs) html = html.replace(TRACK, (_, open: string, close: string) => open + TRACK_HEAD + jobs.map(row).join('') + close);
  if (deliveries) html = html.replace(DELIVERY, (_, open: string, close: string) => open + DELIVERY_HEAD + deliveries.map(row).join('') + close);
  return status === undefined ? html : html.replace(STATUS, `$1${status}$2`);
};
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const moved = (location: string) => () => reply('<html><head><title>Object moved</title></head></html>', 302, { Location: location });
type Reply = string | (() => Response | Promise<Response>);
/** The site's three pages: the home page's tracking form, its post back and the tracking detail. */
const site = (detail: Reply, { form = fixture('form'), lookup = moved(LIST) }: { form?: Reply; lookup?: Reply } = {}) =>
  vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const answer = String(url) === MAHAVIR_FORM ? (init?.method === 'POST' ? lookup : form) : detail;
    return typeof answer === 'string' ? reply(answer) : answer();
  });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const scan = (local_time: string, location: string, description: string, provider_code: string) => (
  { local_time, location, description, provider_code, stage: 'in_transit', stage_source: 'carrier_map' });
const booking = (local_time: string) => (
  { local_time, location: 'MEHSANA - 2', description: 'Booked By MEHSANA - 2', stage: 'accepted', stage_source: 'carrier_map' });

describe('Shree Mahavir HTTP adapter', () => {
  it('posts the number through the home page’s tracking form and opens the detail its answer points to, through the supplied transport', async () => {
    const fetcher = site(fixture('in-transit'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MahavirTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1232 2004 6997 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const headers = { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' };
    expect(fetcher.mock.calls[0]).toEqual([MAHAVIR_FORM, expect.objectContaining({ method: 'GET', redirect: 'manual', headers,
      signal: expect.any(AbortSignal) })]);
    expect(fetcher.mock.calls[1]).toEqual([MAHAVIR_FORM, expect.objectContaining({ method: 'POST', redirect: 'manual',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } })]);
    // The form's state, the number and the Tracking button; the outlet search and the pickup request with its captcha stay out.
    expect(Object.fromEntries(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)))).toEqual({
      __EVENTTARGET: '', __EVENTARGUMENT: '', __VIEWSTATE: 'U3ludGhldGljIHZpZXcgc3RhdGUgKyBzbGFzaC8=', __VIEWSTATEGENERATOR: '0A1B2C3D',
      __EVENTVALIDATION: 'U3ludGhldGljIGV2ZW50IHZhbGlkYXRpb24=', txtAWBNo: IN_TRANSIT, cmdTrack: 'Tracking',
    });
    // The key's + and / are encoded, so the server reads them back unchanged.
    expect(fetcher.mock.calls[2]).toEqual([DETAIL, expect.objectContaining({ method: 'GET', redirect: 'manual', headers })]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shree-mahavir', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a consignment on its way: the booking and the jobs newest first, on the offices’ wall clocks', () => {
    const result = parseMahavir(fixture('in-transit'), IN_TRANSIT);
    // The status line repeats the newest job, which is kept once.
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Inward At HAZIRA SURAT Dated 21/08/26', last_update: null, last_update_local: '2026-08-21T10:14:00',
      expected_delivery: null, timezone: 'Asia/Kolkata', receiver_name: 'JAY SHAH', events: [
        scan('2026-08-21T10:14:00', 'HAZIRA SURAT', 'Inward At HAZIRA SURAT', 'IN'),
        scan('2026-08-21T09:10:00', 'SURAT R.O.', 'Out To HAZIRA SURAT', 'OUT'),
        scan('2026-08-21T03:57:00', 'SURAT R.O.', 'Inward At SURAT R.O.', 'IN'),
        scan('2026-08-20T19:07:00', 'MEHSANA R.O.', 'Out To AHMEDABAD R.O.', 'OUT'),
        booking('2026-08-20T18:29:00'),
      ] });
    // The offices' tooltips hold their addresses and phone numbers, and the destination center is not kept.
    expect(JSON.stringify(result)).not.toMatch(/Ph:|PVT|PRATHAM|Gujarat|\d{6}/);
    expect(parseMahavir(fixture('dispatched'), DISPATCHED)).toEqual({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'Out To DEODAR Dated 20/08/26', last_update: null,
      last_update_local: '2026-08-20T21:58:00', expected_delivery: null, timezone: 'Asia/Kolkata', receiver_name: 'ITI SIHORI', events: [
        scan('2026-08-20T21:58:00', 'MEHSANA R.O.', 'Out To DEODAR', 'OUT'),
        booking('2026-08-20T20:37:00'),
      ] });
  });

  it('adds a status line newer than the jobs as a day, and passes over one older than them', () => {
    const newer = parseMahavir(page({ status: 'Out To SAMPLE HUB Dated 22/08/26<br/>Ph: 9000000301' }), IN_TRANSIT);
    expect(newer).toMatchObject({ last_status_text: 'Out To SAMPLE HUB Dated 22/08/26', last_update_local: '2026-08-22' });
    expect(newer.events!.slice(0, 2)).toEqual([
      { local_time: '2026-08-22', description: 'Out To SAMPLE HUB', stage: 'in_transit', stage_source: 'carrier_map' },
      scan('2026-08-21T10:14:00', 'HAZIRA SURAT', 'Inward At HAZIRA SURAT', 'IN'),
    ]);
    const older = parseMahavir(page({ status: 'Booked By SAMPLEPUR Dated 19/08/26' }), IN_TRANSIT);
    expect(older).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Inward At HAZIRA SURAT' });
    expect(older.events).toHaveLength(5);
  });

  it('reads delivery rows by their status, at the delivering branch, without the receiver', () => {
    const delivered = parseMahavir(page({ status: 'DELIVERED Dated 22/08/26',
      deliveries: [['22/08/26 - 11:30 AM', 'HAZIRA SURAT', 'ASHA EXAMPLE', 'DELIVERED']] }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-08-22T11:30:00' });
    expect(delivered.events![0]).toEqual({ local_time: '2026-08-22T11:30:00', location: 'HAZIRA SURAT', description: 'DELIVERED',
      stage: 'delivered', stage_source: expect.stringMatching(/^wording:/) });
    expect(delivered.events).toHaveLength(6);
    expect(JSON.stringify(delivered)).not.toContain('ASHA');
    const returned = parseMahavir(page({ deliveries: [
      ['22/08/26 - 11:30 AM', 'HAZIRA SURAT', '', 'DELIVERY ATTEMPTED BY HAZIRA SURAT BUT NOT SUCCEED...'],
      ['23/08/26', 'HAZIRA SURAT', '', 'RETURN TO ORIGIN'],
    ] }), IN_TRANSIT);
    // The status line, a day older than the deliveries, is not the current one.
    expect(returned).toMatchObject({ current_stage: 'exception', current_stage_source: 'carrier_map', last_status_text: 'RETURN TO ORIGIN' });
    expect(returned.events!.slice(0, 2)).toEqual([
      { local_time: '2026-08-23', location: 'HAZIRA SURAT', description: 'RETURN TO ORIGIN', stage: 'exception', stage_source: 'carrier_map' },
      { local_time: '2026-08-22T11:30:00', location: 'HAZIRA SURAT', description: 'DELIVERY ATTEMPTED BY HAZIRA SURAT BUT NOT SUCCEED...',
        stage: 'failed_attempt', stage_source: 'carrier_map' },
    ]);
  });

  it('keeps a clock it cannot read as printed, a missing or midnight clock as the day, and day first', () => {
    const route = 'Out To SAMPLE HUB From: SAMPLE R.O.';
    const first = (day: string, clock: string) => parseMahavir(page({ status: '', jobs: [['OUT', day, route, clock]] }), IN_TRANSIT).events![0];
    expect(first('02/09/26', '')).toMatchObject({ local_time: '2026-09-02' });
    expect(first('02/09/26', '12:00 AM')).toMatchObject({ local_time: '2026-09-02' });
    expect(first('02/09/26', '12:30 AM')).toMatchObject({ local_time: '2026-09-02T00:30:00' });
    expect(first('2/9/2026', '12:05 PM')).toMatchObject({ local_time: '2026-09-02T12:05:00' });
    for (const [day, clock] of [['31/02/26', '10:00 AM'], ['02/09/26', '10.00'], ['02/09/26', '13:00 PM'], ['2026-09-02', '']] as const) {
      const event = parseMahavir(page({ status: '', jobs: [['OUT', day, route, clock]] }), IN_TRANSIT).events!
        .find((candidate) => candidate.provider_code === 'OUT');
      expect(event, `${day} ${clock}`).toMatchObject({ provider_time_text: `${day} ${clock}`.trim(), description: 'Out To SAMPLE HUB' });
      expect(event).not.toHaveProperty('local_time');
      expect(event).not.toHaveProperty('time');
    }
  });

  it('orders jobs by their clocks, keeps rows that share one or a day in their order, and drops a row listed twice', () => {
    const descriptions = (jobs: Job[]) => parseMahavir(page({ status: '', jobs }), IN_TRANSIT).events!.map((event) => event.description);
    expect(descriptions([['IN', '23/08/26', 'From: SAMPLE R.O. To: SAMPLE HUB', '10:00 AM'], ['OUT', '21/08/26', 'Out To SAMPLE R.O. From: SAMPLEPUR', '09:00 AM'],
      ['OUT', '23/08/26', 'Out To SAMPLE HUB From: SAMPLE R.O.', '08:00 AM']]))
      .toEqual(['Inward At SAMPLE HUB', 'Out To SAMPLE HUB', 'Out To SAMPLE R.O.', 'Booked By MEHSANA - 2']);
    expect(descriptions([['OUT', '21/08/26', 'Out To SAMPLE HUB From: SAMPLE R.O.', '09:10 AM'], ['IN', '21/08/26', 'From: SAMPLE R.O. To: SAMPLE HUB', '09:10 AM'],
      ['OUT', '21/08/26', 'Out To SAMPLEPUR From: SAMPLE HUB', '']]))
      .toEqual(['Out To SAMPLEPUR', 'Inward At SAMPLE HUB', 'Out To SAMPLE HUB', 'Booked By MEHSANA - 2']);
    const twice: Job = ['OUT', '21/08/26', 'Out To SAMPLE HUB From: SAMPLE R.O.', '09:10 AM'];
    expect(descriptions([twice, twice])).toEqual(['Out To SAMPLE HUB', 'Booked By MEHSANA - 2']);
  });

  it('reads a job not seen yet by its code alone, and caps a long history', () => {
    const other = parseMahavir(page({ status: '', jobs: [['RTB', '22/08/26', 'From: SAMPLE R.O. To: ASHA EXAMPLE', '11:00 AM']] }), IN_TRANSIT);
    expect(other.events![0]).toMatchObject({ local_time: '2026-08-22T11:00:00', description: 'RTB', provider_code: 'RTB' });
    expect(other.events![0]).not.toHaveProperty('location');
    expect(JSON.stringify(other.events)).not.toContain('ASHA');
    const jobs = Array.from({ length: 120 }, (_, index): Job => ['OUT',
      `${String(1 + (index % 28)).padStart(2, '0')}/0${1 + Math.floor(index / 28)}/27`, `Out To SAMPLE HUB ${index} From: SAMPLE R.O.`, '10:00 AM']);
    const long = parseMahavir(page({ status: '', jobs }), IN_TRANSIT);
    expect(long.events).toHaveLength(100);
    expect(long).toMatchObject({ history_truncated: true, last_update_local: '2027-05-08T10:00:00' });
  });

  it('reads a number shown with its booking office and no dated scan as listed without history', () => {
    for (const [name, number] of [['booked', BOOKED], ['contact', CONTACT]] as const) {
      expect(() => parseMahavir(fixture(name), number), name)
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
    }
  });

  it('counts a page only when it names the number asked', () => {
    expect(() => parseMahavir(fixture('in-transit'), DISPATCHED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Shree Mahavir answered for another consignment' }));
    expect(() => parseMahavir(fixture('not-found'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the page for a number without a booking as not found', async () => {
    await expect(carrier(site(fixture('not-found'))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site(fixture('not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('rejects a changed tracking detail', () => {
    const transit = fixture('in-transit');
    for (const html of [
      transit.replace('id="lblDocNumber"', 'id="lblNumber"'),
      transit.replace('id="lblStatus"', 'id="lblState"'),
      transit.replace('id="txtReceiver"', 'id="txtConsignee"'),
      page({ status: '' }).replace(TRACK, '').replace(DELIVERY, '').replace(/(id="txt\w+">)[^<]+</g, '$1<'),
      '',
      '<html><head><title>Courier Tracking</title></head><body>Site under maintenance</body></html>',
      page({ jobs: [['OUT', '21/08/26', 'SAMPLE R.O. - SAMPLE HUB', '10:00 AM']] }),
      page({ jobs: [['IN', '21/08/26', 'Received', '10:00 AM']] }),
      page({ jobs: [['', '21/08/26', 'Out To SAMPLE HUB From: SAMPLE R.O.', '10:00 AM']] }),
      page({ jobs: [['OUT', '21/08/26', 'Out To SAMPLE HUB From: SAMPLE R.O.', '10:00 AM']] }).replace('<td>10:00 AM</td>', ''),
      page({ deliveries: [['22/08/26 - 11:30 AM', 'HAZIRA SURAT', '', '']] }),
      page({ jobs: Array.from({ length: 301 }, (): Job => ['OUT', '21/08/26', 'Out To SAMPLE HUB From: SAMPLE R.O.', '10:00 AM']) }),
    ]) {
      expect(() => parseMahavir(html, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // The page for a number without a booking keeps both tables; without them it is not that page.
    expect(() => parseMahavir(fixture('not-found').replace(TRACK, ''), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMahavir(CHECK, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects a changed tracking form or answer', () => {
    const form = fixture('form');
    expect(() => mahavirLookupFields(form.replace('id="txtAWBNo"', 'id="awb"'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => mahavirLookupFields(form.replace('id="cmdTrack"', 'id="cmdGo"'), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => mahavirLookupFields(form.replace(/<input type="hidden" name="__EVENTVALIDATION"[^>]*>/, ''), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'Shree Mahavir returned a tracking form without its state' }));
    expect(() => mahavirLookupFields(CHECK, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(mahavirDetailUrl(LIST)).toBe(DETAIL);
    expect(mahavirDetailUrl(`${MAHAVIR_ORIGIN}/Frm_DocList.aspx?docnos=AAAAAAAAAAAAAAAA%2BBBBBBBBBBBBBBBBB%2FCCCCCCCCC%3D`)).toBe(DETAIL);
    for (const location of ['/Frm_DocList.aspx?docnos=', '/Frm_DocList.aspx?docnos=%E0%A4%A', '/Frm_DocList.aspx?docnos=AAAA%3Cscript%3E',
      '/Frm_DocList.aspx?docno=AAAAAAAAAAAA']) {
      expect(() => mahavirDetailUrl(location), location).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => mahavirDetailUrl('/_NotAvailable.aspx')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const location of [null, '/', 'https://elsewhere.example/Frm_DocList.aspx?docnos=AAAAAAAA', 'http://[']) {
      expect(() => mahavirDetailUrl(location)).toThrow(expect.objectContaining({ kind: 'transport' }));
    }
  });

  it('keeps a browser check, the error page, a moved route and a broken page apart from missing parcels', async () => {
    const lookup = (detail: Reply, pages: Parameters<typeof site>[1] = {}) => carrier(site(detail, pages)).track({ number: UNKNOWN });
    const notFound = fixture('not-found');
    await expect(lookup(notFound, { form: () => reply(CHECK, 403) })).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(notFound, { form: CHECK })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(notFound, { lookup: CHECK })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHECK, 403))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(notFound, { lookup: fixture('form') }))
      .rejects.toMatchObject({ kind: 'schema', message: 'Shree Mahavir did not take the tracking lookup' });
    // The site sends a request it fails to its blank error page, which is no answer.
    await expect(lookup(notFound, { lookup: moved('/_NotAvailable.aspx') })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(moved('/_NotAvailable.aspx'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(notFound, { form: moved('/Default.aspx') })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(notFound, { lookup: moved('/Default.aspx') })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(moved('/Default.aspx'))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><title>Courier Tracking</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response(new Uint8Array(600_000)))).rejects.toThrow('unexpectedly large');
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s without a retry, and without the request that carries the key', async (status, kind) => {
      const fetcher = site(() => reply('<html><title>Error</title></html>', status, { 'Retry-After': '30' }));
      const error = await carrier(fetcher).track({ number: IN_TRANSIT }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind, status });
      expect(error).not.toHaveProperty('request', expect.anything());
      expect(error).not.toHaveProperty('diagnostics', expect.anything());
      expect(JSON.stringify(error)).not.toContain('CCCCCCCCC');
      expect(fetcher).toHaveBeenCalledTimes(3);
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
    });

  it('recognizes a known number by its newest scan’s wall clock, and asks nothing for one Shree Mahavir does not issue', async () => {
    const fetcher = site(fixture('in-transit'));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT))
      .resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-08-21T10:14:00' });
    await expect(carrier(fetcher).recognize!('12322004699')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects numbers Shree Mahavir does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['12322004699', '1232200469970', 'ABCDEFGHIJKL', `${IN_TRANSIT},${DISPATCHED}`, '', `1${'2'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMahavirNumber(' 1232-2004-6997 ')).toBe(IN_TRANSIT);
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = site(fixture('in-transit'));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(flaky).track({ number: IN_TRANSIT })).resolves.toMatchObject({ status: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(4);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const started = Date.now();
    await expect(carrier(slow).track({ number: IN_TRANSIT }, { budgetMs: 60.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('leaves its twelve-digit numbers unclaimed by detection', () => {
    for (const number of [IN_TRANSIT, DISPATCHED]) {
      expect(detectCarrierMatch(number).carrier).not.toBe('shree-mahavir');
      expect(recognitionAskedCarriers(number)).not.toContain('shree-mahavir');
    }
  });
});

describe('Shree Mahavir status vocabulary', () => {
  it('maps every recorded job and wording to the stage it records', () => {
    const entries = statuses.entries as { code?: string; wording: string; stage: string }[];
    for (const entry of entries) {
      const code = entry.code ?? null;
      expect(mahavirStage(code, entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(mahavirMappedStage(code, entry.wording), entry.wording).toBe(entry.stage);
    }
    // Out for delivery is not a delivery, and a return is an exception.
    expect(mahavirStage(null, 'OUT FOR DELIVERY')?.stage).toBe('out_for_delivery');
    expect(mahavirStage(null, 'SAMPLE NOTICE')).toBeNull();
  });
});
