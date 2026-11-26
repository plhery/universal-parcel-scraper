import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GSM_NTON, gsmNtonTrackingUrl, normalizeGsmNtonNumber } from './adapter.js';
import { EXPRESSWEB_BOUND, EXPRESSWEB_EVENTS, EXPRESSWEB_HEADER } from './expressweb.js';
import { parseExpressweb } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's replies, with the people in them replaced; the tests derive invented bills from them.
const SAMPLE = '6078502763873';
const OTHER = '6000000000001';

type Reply = Record<string, unknown>;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const BOUND = fixture(`bound-${SAMPLE}`);
const HEADER = fixture(`header-${SAMPLE}`);
const EVENTS = fixture(`events-${SAMPLE}`);
const HEADER_FIELDS = HEADER.data as Record<string, unknown>;
const ROWS = EVENTS.rows as Record<string, unknown>[];

/** The sample's replies under another bill, with header fields and rows replaced when given. */
const bill = (number: string, changes: { bound?: string; header?: Record<string, unknown>; rows?: Record<string, unknown>[]; records?: number } = {}) => {
  const rows = changes.rows ?? ROWS;
  return {
    bound: { data: { HBLNO: number, bound: changes.bound ?? 'AI', seq: 1 } },
    header: { data: { ...HEADER_FIELDS, HBLNO: number, ...changes.header } },
    events: { ...EVENTS, records: changes.records ?? rows.length, rows },
  };
};
const parse = (number: string, changes?: Parameters<typeof bill>[1]) => parseExpressweb(bill(number, changes), number, GSM_NTON);

const SESSION = 'JSESSIONID=TestSession.Node1';
const json = (body: unknown, init: ResponseInit & { cookie?: string } = {}) => {
  const headers = new Headers({ 'Content-Type': 'application/json;charset=UTF-8' });
  if (init.cookie) headers.append('Set-Cookie', `${init.cookie}; Path=/; HttpOnly`);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A tracker answering each service with the given reply. */
const tracker = (replies: { bound: () => Response; header?: () => Response; events?: () => Response }) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => {
    if (String(url) === EXPRESSWEB_BOUND) return replies.bound();
    if (String(url) === EXPRESSWEB_HEADER && replies.header) return replies.header();
    if (String(url) === EXPRESSWEB_EVENTS && replies.events) return replies.events();
    throw new Error(`unexpected request ${String(url)}`);
  });
const formOf = (init: RequestInit | undefined) => new URLSearchParams(String(init?.body));

describe('GSM NtoN numbers', () => {
  it('takes a house bill number in letters and digits', () => {
    expect(normalizeGsmNtonNumber(` ${SAMPLE.slice(0, 6)} ${SAMPLE.slice(6)} `)).toBe(SAMPLE);
    expect(normalizeGsmNtonNumber('gsm12345678')).toBe('GSM12345678');
    for (const other of ['', '1234567', 'ABCDEFGHIJ', `${'1'.repeat(21)}`]) {
      expect(() => normalizeGsmNtonNumber(other), other).toThrow('Enter the GSM NtoN bill number');
    }
  });

  it('links the tracing page GSM NtoN’s site opens', () => {
    expect(gsmNtonTrackingUrl(SAMPLE.toLowerCase()))
      .toBe(`http://expressweb.co.kr/member/loginTracing.do?fwdCode=gexp&bound=ALL&langCode=KOR&HBLNO=${SAMPLE}`);
  });
});

describe('GSM NtoN tracking adapter', () => {
  it('asks the bound, the header and the event list as the tracing page does, carrying its session', async () => {
    const fetcher = tracker({ bound: () => json(BOUND, { cookie: SESSION }), header: () => json(HEADER), events: () => json(EVENTS) });
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(carrier(fetcher)).toMatchObject({ id: 'gsm-nton', recordsSteps: true, steps: ['direct', 'retry'] });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([EXPRESSWEB_BOUND, EXPRESSWEB_HEADER, EXPRESSWEB_EVENTS]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }) });
    }
    const [bound, header, events] = fetcher.mock.calls.map(([, init]) => init!) as [RequestInit, RequestInit, RequestInit];
    expect((bound.headers as Record<string, string>).Cookie).toBeUndefined();
    expect(JSON.parse(formOf(bound).get('params')!)).toEqual({ DeliveryCode: '', HBLNO: SAMPLE, PONO: '', REFNO: '', tableTag: 'ALL', fwdCode: 'gexp' });
    expect((header.headers as Record<string, string>).Cookie).toBe(SESSION);
    expect(JSON.parse(formOf(header).get('params')!)).toEqual({ DeliveryCode: '', HBLNO: SAMPLE, PONO: '', REFNO: '', tableTag: 'AI',
      tableName: 'WTEDAI_STATUS', tableNameHbl: 'WTEDAI_HBL', tableCSNameHbl: 'TEDAI_HBL', tableNameAdd: 'TEDAI_HBL_Additional', FlightNo: 'Y',
      langCode: 'ENG', fwdCode: 'gexp' });
    // The event list takes the keys as plain fields, with the header's reference.
    expect((events.headers as Record<string, string>).Cookie).toBe(SESSION);
    const list = formOf(events);
    expect(list.has('params')).toBe(false);
    expect(Object.fromEntries(list)).toMatchObject({ HBLNO: SAMPLE, REFNO: HEADER_FIELDS.REFNO, tableTag: 'AI', tableName: 'WTEDAI_STATUS',
      langCode: 'ENG', fwdCode: 'gexp', rows: '100', page: '1', sord: 'asc' });
  });

  it('reads the bound’s empty answer as not found', async () => {
    const fetcher = tracker({ bound: () => json(fixture('not-found')) });
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts only the bill asked for', async () => {
    const answer = (replies: Parameters<typeof tracker>[0]) => carrier(tracker(replies)).track({ number: OTHER }).catch((error: unknown) => error);
    expect(await answer({ bound: () => json(BOUND) })).toMatchObject({ kind: 'indeterminate' });
    const { bound, header } = bill(OTHER);
    expect(await answer({ bound: () => json(bound), header: () => json(HEADER) })).toMatchObject({ kind: 'indeterminate' });
    // A bound without its bill is no answer about the parcel.
    expect(await answer({ bound: () => json(bound), header: () => json({ data: 'null' }) })).toMatchObject({ kind: 'indeterminate' });
    expect(await answer({ bound: () => json(bound), header: () => json(header), events: () => json(EVENTS) })).toMatchObject({ current_stage: 'delivered' });
  });

  it('keeps refusals, error pages and redirects apart from a missing bill', async () => {
    const answer = async (response: () => Response) => carrier(tracker({ bound: response }))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('<title>Error</title>', { status: 500, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<html><body>login</body></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('<title>Just a moment...</title>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'http://expressweb.co.kr/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ result: 'null' }))).toMatchObject({ kind: 'schema' });
  });
});

describe('GSM NtoN replies', () => {
  it('reads the public sample: its rows on their wall clock, its airports and post offices, and Korea Post’s delivery', () => {
    const result = parseExpressweb({ bound: BOUND, header: HEADER, events: EVENTS }, SAMPLE, GSM_NTON);
    const row = (local_time: string, description: string, provider_code: string, stage: string, location?: string) =>
      ({ local_time, description, provider_code, ...(location ? { location } : {}), stage, stage_source: 'carrier_map' });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivery Complete',
      last_update: null, last_update_local: '2024-10-07T12:45:00', expected_delivery: null, destination_country: 'KR',
      delivery_carrier: 'korea-post', delivery_tracking_number: SAMPLE,
      events: [
        row('2024-10-07T12:45:00', 'Delivery Complete', 'HTJ', 'delivered', '울산우체국'),
        row('2024-10-05T11:15:00', 'Delivery Accept', 'HTI', 'in_transit', '국제우편물류센터'),
        row('2024-10-05T10:50:00', 'CarryOut', 'HTF_O', 'in_transit'),
        row('2024-10-04T16:05:00', 'Clearance Complete', 'HTH', 'in_transit'),
        row('2024-10-04T16:05:00', 'Acceptance of Declaration', 'HTH', 'in_transit'),
        row('2024-10-02T11:05:00', 'clearance', 'HTG', 'customs'),
        row('2024-10-02T11:05:00', 'CarryIn', 'HTF', 'in_transit'),
        row('2024-09-30T18:55:00', 'Arrival(ICN)', 'HTE', 'in_transit', 'ICN'),
        row('2024-09-30T14:31:00', 'Clearance Accept', 'HTG', 'customs'),
        row('2024-09-29T23:55:00', 'Departure(MXP)', 'HTD', 'in_transit', 'MXP'),
        row('2024-09-27T19:07:00', 'Departure W/H In', 'HTC', 'accepted'),
        row('2024-09-27T19:03:00', 'Accept', 'HTA', 'accepted'),
      ],
    });
    // The consignee, the postman, the phone, the staff, the shipper and the order stay behind.
    expect(JSON.stringify(result)).not.toMatch(/hongkildong|홍길동|김집배|김담당|010-|MXN|KE514/);
  });

  it('names a changed delivery’s own carrier and number, and no number for a split one', () => {
    const changed = (header: Record<string, unknown>) => parse(OTHER, { header });
    expect(changed({ ChangeDeliveryCode: 'KOREX', ChangeDeliveryName: 'CJ대한통운', ChangeDeliveryNo: '6000 1234 5678' }))
      .toMatchObject({ delivery_carrier: 'cj-logistics', delivery_tracking_number: '600012345678' });
    expect(changed({ ChangeDeliveryCode: '', ChangeDeliveryName: '한진택배(HANJIN)', ChangeDeliveryNo: '412345678901' }))
      .toMatchObject({ delivery_carrier: 'hanjin', delivery_tracking_number: '412345678901' });
    for (const header of [{ ChangeDeliveryCode: 'KOREX', ChangeDeliveryNo: '600012345678,600012345679' }, { ChangeDeliveryCode: 'KOREX', ChangeDeliveryNo: '' },
      { ChangeDeliveryCode: 'XPRESS', ChangeDeliveryNo: '600012345678' }, { DeliveryCode: '', DeliveryName: '자체배송' }, { DeliveryCode: 'XPRESS', DeliveryName: '자체배송' }]) {
      const result = changed(header);
      expect(result.delivery_carrier, JSON.stringify(header)).toBeUndefined();
      expect(result.delivery_tracking_number, JSON.stringify(header)).toBeUndefined();
    }
    // A bill in letters is not the delivering carrier's number.
    expect(parse('GSM12345678').delivery_tracking_number).toBeUndefined();
  });

  it('keeps an export’s destination open and marks a list longer than its first page', () => {
    expect(parse(OTHER, { bound: 'OO' }).destination_country).toBeUndefined();
    expect(parse(OTHER, { bound: 'OI' }).destination_country).toBe('KR');
    expect(parse(OTHER, { records: 140 })).toMatchObject({ history_truncated: true });
    expect(parse(OTHER).history_truncated).toBeUndefined();
  });

  it('answers a bill without rows by the header’s status, or as listed without history', () => {
    expect(parse(OTHER, { rows: [] })).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivery Complete',
      last_update: null, last_update_local: '2024-10-07T12:45:00', expected_delivery: null, destination_country: 'KR',
      delivery_carrier: 'korea-post', delivery_tracking_number: OTHER, summary_only: true, events: [],
    });
    expect(() => parse(OTHER, { rows: [], header: { STATUSNAME: null } }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed', deliveryCarrier: 'korea-post', deliveryTrackingNumber: OTHER }));
  });

  it('refuses a changed reply', () => {
    const replies = [
      { ...bill(OTHER), bound: { data: { HBLNO: OTHER, bound: 'XX' } } },
      { ...bill(OTHER), bound: { HBLNO: OTHER } },
      { ...bill(OTHER), header: { data: [] } },
      { ...bill(OTHER), events: { rows: {} } },
      { ...bill(OTHER), events: { rows: Array.from({ length: 101 }, () => ROWS[0]) } },
      bill(OTHER, { rows: [{ ...ROWS[0], CONFIRMDATE: '2024-02-31' }] }),
      bill(OTHER, { rows: [{ ...ROWS[0], CONFIRMTIME: '7:03' }] }),
      bill(OTHER, { rows: [{ ...ROWS[0], STATUSCODE: 'accept' }] }),
      bill(OTHER, { rows: [{ ...ROWS[0], STATUSNAME: 7 }] }),
      bill(OTHER, { rows: [7 as unknown as Record<string, unknown>] }),
    ];
    for (const reply of replies) {
      expect(() => parseExpressweb(reply, OTHER, GSM_NTON), JSON.stringify(reply).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('GSM NtoN statuses', () => {
  it('maps each code in English and Korean, and a header’s wording without its code', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMap.stage('', entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'gsm-nton', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('', 'Arrival(PUS)')).toBe('in_transit');
    expect(statusMap.stage('XYZ', 'anything')).toBeUndefined();
  });
});
