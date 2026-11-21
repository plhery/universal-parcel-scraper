import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TP_HISTORY, TP_SEARCH, TpLogisticsTracker } from './adapter.js';
import { normalizeTpNumber, parseTpHistory, parseTpSearch, tpHistoryUrl, tpSearchUrl, type TpListing } from './parser.js';
import { statusMap, tpStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples whose replies the fixtures keep, and the made-up number of the not-found fixtures.
const DELIVERED = 'NRT032506030001';
const HELD = 'PTE052410280003';
const UNKNOWN = 'ZZZ999912319999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body,
  { status, headers: { 'Content-Type': 'text/html', ...headers } });
type Reply = string | (() => Response | Promise<Response>);
/** A site that answers each request in turn; the last answer repeats. */
const site = (...answers: Reply[]) => {
  let index = 0;
  return vi.fn<typeof fetch>().mockImplementation(async () => {
    const answer = answers[Math.min(index++, answers.length - 1)]!;
    return typeof answer === 'string' ? reply(answer) : answer();
  });
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

const listed = (name: string, number: string) => parseTpSearch(fixture(`search-${name}`), number);
/** The held parcel's history without its photos, which name the number. */
const withoutPhotos = (html: string) => html.replace(/<img [^>]*><\/img>/g, '');
/** The held parcel's history before its delivery: the two newest movements left out. */
const heldNow = () => fixture('history-held')
  .replace(/<tr {2}border='0' ><td > ส่งสินค้าถึงปลายทางเรียบร้อย<\/td>.*?<\/tr>/s, '')
  .replace(/<tr {2}border='0' ><td > ดำเนินการส่งสินค้าไปให้ลูกค้าปลายทาง<\/td>.*?<\/tr>/s, '');
const row = (detail: string, time: string, province = 'เชียงใหม่') =>
  `<tr  border='0' ><td >${detail}</td><td>${time}</td><td>${province}</td><td>N5</td></tr>`;
/** The held parcel's history with its movements replaced. */
const movements = (...rows: string[]) => fixture('history-held')
  .replace(/(<th>BranchID<\/th>\r?\n<\/tr>)[\s\S]*?(<\/table>)/, (_, open: string, close: string) => `${open}${rows.join('')}${close}`);

describe('TP Logistics HTTP adapter', () => {
  it('reads the search page, then the history page, through the supplied transport', async () => {
    const fetcher = site(fixture('search-delivered'), fixture('history-delivered'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TpLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' nrt0325 0603 0001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const headers = { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8', 'User-Agent': 'SyntheticHost/1.0' };
    expect(fetcher.mock.calls[0]).toEqual([`${TP_SEARCH}?id=${DELIVERED}&type=a1`,
      expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers })]);
    expect(fetcher.mock.calls[1]).toEqual([`${TP_HISTORY}?fn=a1&code=${DELIVERED}`,
      expect.objectContaining({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers })]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tp-logistics-th', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(tpSearchUrl(DELIVERED)).toBe('https://tptrack.info/ecom/dtrack.php?id=NRT032506030001&type=a1');
    expect(tpHistoryUrl(DELIVERED)).toBe('https://tptrack.info/ecom/tdetail.php?fn=a1&code=NRT032506030001');
  });

  it('reads a delivered parcel: its scans newest first on the branches’ wall clocks, at their provinces', () => {
    expect(listed('delivered', DELIVERED)).toEqual([{ item: 'ทีวี 1 เครื่อง', quantity: '1', destination: 'อำเภอเมือง สมุทรปราการ',
      status: 'Delivered' }]);
    const result = parseTpHistory(fixture('history-delivered'), DELIVERED, listed('delivered', DELIVERED));
    const scan = (local_time: string, location: string, description: string, stage: string) =>
      ({ local_time, location, description, stage, stage_source: 'carrier_map' });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2025-06-07T11:17:00', expected_delivery: null, timezone: 'Asia/Bangkok',
      sender_name: 'พี่เอก', receiver_name: 'ศักดิ์ดา ซับซ้อน',
      events: [
        scan('2025-06-07T11:17:00', 'กรุงเทพมหานคร', 'ส่งสินค้าถึงปลายทางเรียบร้อย', 'delivered'),
        scan('2025-06-07T09:15:00', 'กรุงเทพมหานคร', 'ดำเนินการส่งสินค้าไปให้ลูกค้าปลายทาง', 'out_for_delivery'),
        scan('2025-06-05T14:15:00', 'กรุงเทพมหานคร', 'รับสินค้าเข้าคลังรอจัดส่ง', 'in_transit'),
        scan('2025-06-05T14:11:00', 'กรุงเทพมหานคร', 'รับสินค้าเข้าคลังศูนย์กระจายสินค้า', 'in_transit'),
        scan('2025-06-05T13:49:00', 'กรุงเทพมหานคร', 'ดำเนินการส่งสินค้าไปที่ศูนย์กระจายสินค้า', 'in_transit'),
        scan('2025-06-05T11:41:00', 'กรุงเทพมหานคร', 'รับสินค้าเข้าคลังศูนย์กระจายสินค้า', 'in_transit'),
        scan('2025-06-04T02:19:00', 'นครศรีธรรมราช', 'ดำเนินการส่งสินค้าไปที่ศูนย์กระจายสินค้า', 'in_transit'),
        // Two scans of one minute keep the page's order, the newer above.
        scan('2025-06-03T11:44:00', 'นครศรีธรรมราช', 'รับสินค้าเข้าคลังรอจัดส่ง', 'in_transit'),
        scan('2025-06-03T11:44:00', 'นครศรีธรรมราช', 'ตรวจสอบสินค้าและคีย์เอกสาร', 'accepted'),
      ],
    });
    // No scan is an instant, and the result passes the shared checks as it is.
    expect(result.events!.some((event) => 'time' in event)).toBe(false);
    expect(normalizeCarrierResult(result)).toMatchObject({ current_stage: 'delivered', events: expect.any(Array) });
    expect(normalizeCarrierResult(result).events!.map((event) => event.description)).toEqual(result.events!.map((event) => event.description));
  });

  it('puts a hold reason above the hold it explains, and stages a held parcel by its newest scan', () => {
    const delivered = parseTpHistory(fixture('history-held'), HELD, listed('held', HELD));
    expect(delivered).toMatchObject({ current_stage: 'delivered', sender_name: 'ร้านบังโต อะไหล่ L200', receiver_name: 'คุณกิตติชัย ใจยะ' });
    expect(delivered.events!.slice(1, 5)).toEqual([
      { local_time: '2024-11-02T11:19:00', location: 'เชียงใหม่', description: 'ดำเนินการส่งสินค้าไปให้ลูกค้าปลายทาง', stage: 'out_for_delivery',
        stage_source: 'carrier_map' },
      { local_time: '2024-10-31T16:19:00', description: '3.ผู้รับขอเลื่อนวันรับสินค้า (ถ่ายรูปวันเลื่อนรับ)', stage: 'failed_attempt',
        stage_source: 'carrier_map' },
      { local_time: '2024-10-31T16:19:00', location: 'เชียงใหม่', description: 'พักสินค้า', stage: 'exception', stage_source: 'carrier_map' },
      { local_time: '2024-10-30T20:10:00', location: 'เชียงใหม่', description: 'รับสินค้าเข้าคลังรอจัดส่ง', stage: 'in_transit',
        stage_source: 'carrier_map' },
    ]);
    expect(delivered.events).toHaveLength(15);
    expect(delivered.events!.at(-1)).toMatchObject({ local_time: '2024-10-28T16:58:00', description: 'ตรวจสอบสินค้าและคีย์เอกสาร', stage: 'accepted' });

    // While held, a summary the map does not know leaves the newest scan to say where the parcel is.
    const waiting: TpListing[] = [{ ...listed('held', HELD)[0]!, status: 'Sample Status' }];
    expect(parseTpHistory(heldNow(), HELD, waiting)).toMatchObject({
      status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map', last_status_text: 'Sample Status',
      last_update_local: '2024-10-31T16:19:00',
    });
    // Out for delivery is not a delivery.
    const out = movements(row(' ดำเนินการส่งสินค้าไปให้ลูกค้าปลายทาง', '02/11/2024 11:19:00'), row(' ตรวจสอบสินค้าและคีย์เอกสาร', '28/10/2024 16:58:00'));
    expect(parseTpHistory(out, HELD, [{ ...waiting[0]!, status: '' }])).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'ดำเนินการส่งสินค้าไปให้ลูกค้าปลายทาง',
    });
  });

  it('reads clocks day first, a Buddhist Era year as the Common Era one, and keeps text it cannot read in place', () => {
    const result = parseTpHistory(movements(
      row(' ส่งสินค้าถึงปลายทางเรียบร้อย', '2/11/2567 9:05:00'),
      row(' ดำเนินการส่งสินค้าไปให้ลูกค้าปลายทาง', 'รอยืนยัน'),
      row(' รับสินค้าเข้าคลังรอจัดส่ง', '31/02/2024 10:00:00', ''),
      row(' ตรวจสอบสินค้าและคีย์เอกสาร', '13/10/2024 00:00'),
    ), HELD, listed('held', HELD));
    expect(result.events!.filter((event) => !event.description!.startsWith('3.')).map(({ local_time, provider_time_text, location }) =>
      ({ local_time, provider_time_text, location }))).toEqual([
      { local_time: '2024-11-02T09:05:00', provider_time_text: undefined, location: 'เชียงใหม่' },
      { local_time: undefined, provider_time_text: 'รอยืนยัน', location: 'เชียงใหม่' },
      // A midnight scan keeps its clock: line hauls scan through the night.
      { local_time: undefined, provider_time_text: '31/02/2024 10:00:00', location: undefined },
      { local_time: '2024-10-13T00:00:00', provider_time_text: undefined, location: 'เชียงใหม่' },
    ].map((event) => Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined))));
    // The hold reason of the 31st sorts between its neighbours by its clock.
    expect(result.events!.map((event) => event.description).indexOf('3.ผู้รับขอเลื่อนวันรับสินค้า (ถ่ายรูปวันเลื่อนรับ)')).toBe(3);
  });

  it('reads the code an archived history page printed before a wording', () => {
    const result = parseTpHistory(movements(row('(8) จัดส่งไม่ได้/รับสินค้ากลับคืนคลัง', '19/08/2024 16:09:00'),
      row('(6) ดำเนินการส่งสินค้าไปให้ลูกค้าปลายทาง', '19/08/2024 16:00:00')), HELD, listed('held', HELD));
    expect(result.events!.slice(0, 1).concat(result.events!.slice(-1))).toEqual([
      { local_time: '2024-10-31T16:19:00', description: '3.ผู้รับขอเลื่อนวันรับสินค้า (ถ่ายรูปวันเลื่อนรับ)', stage: 'failed_attempt',
        stage_source: 'carrier_map' },
      { local_time: '2024-08-19T16:00:00', location: 'เชียงใหม่', description: 'ดำเนินการส่งสินค้าไปให้ลูกค้าปลายทาง', provider_code: '6',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    expect(result.events![1]).toMatchObject({ description: 'จัดส่งไม่ได้/รับสินค้ากลับคืนคลัง', provider_code: '8', stage: 'failed_attempt' });
  });

  it('reads a listed parcel without scans by its summary, and one without a status either as listed', () => {
    const empty = movements().replace(/(<th>Time<\/th>\r?\n<\/tr>)[\s\S]*?(<\/table>)/, '$1$2');
    expect(parseTpHistory(empty, HELD, listed('held', HELD))).toEqual(expect.objectContaining({
      status: 'delivered', current_stage: 'delivered', summary_only: true, events: [],
    }));
    expect(() => parseTpHistory(empty, HELD, [{ ...listed('held', HELD)[0]!, status: '' }]))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
  });

  it('counts an answer only when it is tied to the number asked', () => {
    // The search page's button names the number.
    expect(() => listed('delivered', HELD)).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TP Logistics answered for another parcel' }));
    expect(() => parseTpSearch(fixture('search-delivered').replace(/onmousedown="[^"]*"/, ''), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The history page's photos are filed under the number.
    expect(() => parseTpHistory(fixture('history-delivered'), HELD, listed('delivered', DELIVERED)))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TP Logistics answered for another parcel' }));
    // Without photos, the goods must match the search page's.
    const bare = withoutPhotos(fixture('history-held'));
    expect(bare).not.toContain(HELD);
    expect(parseTpHistory(bare, HELD, listed('held', HELD))).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseTpHistory(bare, HELD, listed('delivered', DELIVERED)))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TP Logistics answered with a history it does not tie to the parcel' }));
    expect(() => parseTpHistory(bare, HELD, [{ ...listed('held', HELD)[0]!, quantity: '3' }])).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const nameless = bare.replace(/ประตูรถ(&nbsp; &nbsp; Qty:)/, '$1');
    expect(() => parseTpHistory(nameless, HELD, [{ ...listed('held', HELD)[0]!, item: '' }])).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the tracker’s answer for a number it holds nothing for as not found, without asking for its history', async () => {
    expect(() => parseTpSearch(fixture('search-not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = site(fixture('search-not-found'));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(carrier(site(fixture('search-not-found'))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    // The not-found script beside an answer is a changed page.
    const both = fixture('search-delivered').replace('<div id="false"></div>',
      "<script>$.get('false.php',function(data){})</script><div id=\"false\"></div>");
    expect(() => parseTpSearch(both, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a listed parcel whose history page is empty inconclusive', async () => {
    await expect(carrier(site(fixture('search-delivered'), fixture('history-not-found'))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps a browser check, a refusal, a moved page and a broken page apart from missing parcels', async () => {
    const lookup = (...answers: Reply[]) => carrier(site(...answers)).track({ number: DELIVERED });
    const found = fixture('search-delivered');
    await expect(lookup(() => reply(CHECK, 403))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => reply('Forbidden', 403))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(found, CHECK)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(found, () => reply(CHECK, 403))).rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(lookup(() => reply('', 302, { Location: '/ecom/index.php' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply(fixture('search-not-found'), 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(found, () => reply('', 410))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('<html><head><title>Thaiparcels</title></head><body>Site under maintenance</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(found, '')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(found, fixture('history-held').replace('<th>BranchID</th>', '<th>Branch</th>'))).rejects.toMatchObject({ kind: 'schema' });
    // The search page without the answer or the not-found script is not the not-found page.
    const bare = fixture('search-not-found').replace(/\$\.get\('false\.php'/, "$.get('menu1.php'");
    await expect(lookup(bare)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => new Response(new Uint8Array(600_000)))).rejects.toThrow('unexpectedly large');
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s without a retry', async (status, kind) => {
      const fetcher = site(() => reply('<html><title>Error</title></html>', status, { 'Retry-After': '30' }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind, status });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const late = site(fixture('search-delivered'), () => reply('<html><title>Error</title></html>', status));
      await expect(carrier(late).track({ number: DELIVERED })).rejects.toMatchObject({ kind, status });
      expect(late).toHaveBeenCalledTimes(2);
      await expect(carrier(fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind });
    });

  it('recognizes a known number, and asks nothing for a number of another shape', async () => {
    const fetcher = site(fixture('search-delivered'), fixture('history-delivered'));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true, lastActivityAt: null });
    await expect(carrier(fetcher).recognize!('TPLPU0001002131')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects other shapes and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['TPLPU0001002131', 'NRT03211005004', 'NR0032506030001', `${DELIVERED}1`, `${DELIVERED},${HELD}`, '', `N${'1'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTpNumber('ptn02-2410-100003')).toBe('PTN022410100003');
  });

  it('tries once more after a failed connection, and keeps a timeout a network failure', async () => {
    const flaky = site(fixture('search-delivered'), fixture('history-delivered'));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(3);
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

  it('leaves selection to the existing low-confidence rule', () => {
    for (const number of [DELIVERED, HELD]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['tp-logistics-th'] });
    }
  });
});

describe('TP Logistics status vocabulary', () => {
  it('maps every recorded wording to the stage it records', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(tpStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(entry.wording, entry.wording).toMatch(/^[ -~฀-๿]+$/);
    }
    expect(statusMap.gaps).toEqual([]);
    // A wording neither the map nor the shared rules know stays without a stage.
    expect(tpStage('สถานะตัวอย่าง')).toBeNull();
    expect(tpStage('Out for Delivery')?.stage).toBe('out_for_delivery');
  });
});
