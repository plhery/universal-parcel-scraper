import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { PantosTracker } from './adapter.js';
import { normalizePantosNumber, pantosBody, pantosDetailRequest, pantosShipment, parsePantos } from './parser.js';
import { pantosStage, statusMap } from './status.js';

const NUMBER = 'PJP260065789';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name));
const response = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const statuses = JSON.parse(text('../statuses.json')) as { entries: { code: string; wording: string; stage: string }[] };
const listed = () => fixture('list.json').body;
const scans = () => fixture('detail.json').body as Record<string, unknown>[];
const shipment = () => pantosShipment(listed(), NUMBER);
const replying = (...bodies: unknown[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const body of bodies) fetcher.mockResolvedValueOnce(response(body));
  return fetcher;
};

describe('LX Pantos tracker', () => {
  it('searches the number, then asks for the shipment it lists, with the supplied transport and budget', async () => {
    const fetcher = replying(text('list.json'), text('detail.json'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new PantosTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(' pjp 2600-65789 ', { budgetMs: 4000 });
    expect(result.events).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[listUrl, listInit], [detailUrl, detailInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(listUrl).toBe('https://www.epantos.com/eCommerce/action/portal.TrackingPopup.retreiveTrackingList');
    expect(JSON.parse(listInit.body as string)).toEqual({ quickNo: NUMBER, locale: 'en' });
    expect(listInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Origin: 'https://www.epantos.com', 'User-Agent': 'SyntheticHost/1' } });
    expect(detailUrl).toBe('https://www.epantos.com/eCommerce/action/portal.TrackingPopup.retreiveTrackingListDtl');
    expect(JSON.parse(detailInit.body as string)).toEqual({ hblNo: NUMBER, mblNo: '88400026434', locale: 'en', expsBizTypeCd: 'PX' });
    expect(new Headers(listInit.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'lx-pantos', step: 'direct', outcome: 'ok' }));
  });

  it('reads the scans newest first on their wall clocks, with the courier that delivers the parcel', () => {
    const result = parsePantos(shipment(), scans());
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Destination Delivery', last_update: null, last_update_local: '2026-04-30T11:35:00', expected_delivery: null,
      receiver_name: 'NAWONSEOK', destination_country: 'KR', delivery_carrier: 'korea-post', delivery_tracking_number: '6094373183564' });
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      ['2026-04-30T11:35:00', 'DLI', 'delivered', 'KOREA, REPUBLIC OF'],
      ['2026-04-29T16:11:00', 'FST', 'out_for_delivery', null],
      ['2026-04-29T14:50:00', 'DCCC', 'customs', 'KOREA, REPUBLIC OF'],
      ['2026-04-29T14:50:00', 'DWHO', 'in_transit', 'KOREA, REPUBLIC OF'],
      ['2026-04-29T14:50:00', 'DWHI', 'in_transit', 'KOREA, REPUBLIC OF'],
      ['2026-04-28T16:15:00', 'ARR', 'in_transit', 'KOREA, REPUBLIC OF'],
      ['2026-04-28T13:35:00', 'DEP', 'in_transit', 'JAPAN'],
      ['2026-04-27T15:39:00', 'LWHO', 'in_transit', null],
      ['2026-04-27T13:39:00', 'LWHI', 'accepted', null],
      ['2026-04-27T13:22:00', 'CRT', 'registered', 'JAPAN'],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
  });

  it('finds the shipment by the delivering courier\'s number too', () => {
    expect(pantosShipment(listed(), '6094373183564').hblNo).toBe(NUMBER);
  });

  it('hands off only to a courier whose rules offer the number', () => {
    const list = listed();
    list.list[0].trkrSvcCd = 'H';
    const result = parsePantos(pantosShipment(list, NUMBER), scans());
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBeUndefined();
    list.list[0].trkrSvcCd = 'E';
    list.list[0].refBlNoCnt = 2;
    expect(parsePantos(pantosShipment(list, NUMBER), scans()).delivery_tracking_number).toBeUndefined();
  });

  it('passes the courier fields the search gives on to the detail request', () => {
    const list = listed();
    Object.assign(list.list[0], { carrSprCd: 'YMTD', wmDomCarr: 'QXP' });
    expect(pantosDetailRequest(pantosShipment(list, NUMBER))).toEqual({ hblNo: NUMBER, mblNo: '88400026434', locale: 'en',
      expsBizTypeCd: 'PX', carrSprCd: 'YMTD', wmDomCarr: 'QXP' });
  });

  it('reads an empty search as not found', async () => {
    expect(() => pantosShipment(pantosBody(text('not-found.json')), 'ZZQ000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = replying(text('not-found.json'));
    await expect(new PantosTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps the rate limit and other failures apart from a missing parcel', async () => {
    const limited = { header: { type: 'ERROR', message: 'Too Many Requests' } };
    expect(() => pantosBody(JSON.stringify(limited))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => pantosBody('<html><title>Just a moment...</title></html>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => pantosBody('<html>Error</html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => pantosBody('{"body":{"list":[]}}')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const status of [403, 429, 500, 503]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(limited, status));
      await expect(new PantosTracker({ fetcher }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
    }
    const failedDetail = replying(text('list.json'));
    failedDetail.mockResolvedValueOnce(response(limited, 429));
    await expect(new PantosTracker({ fetcher: failedDetail }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
  });

  it('binds a master bill only when it names one shipment', () => {
    expect(pantosShipment(listed(), '88400026434').hblNo).toBe(NUMBER);
    const two = listed();
    two.list.push({ ...two.list[0], hblNo: 'PJP000000001', refBlNo: '', refBlNoList: '' });
    expect(() => pantosShipment(two, '88400026434')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(pantosShipment(two, NUMBER).hblNo).toBe(NUMBER);
    expect(() => pantosShipment(listed(), 'PJP000000001')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a listed shipment without scans as listed without history', () => {
    expect(() => parsePantos(shipment(), [])).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('rejects scans for another shipment or with unreadable clocks', () => {
    const edited = (edit: (rows: Record<string, unknown>[]) => void) => { const rows = scans(); edit(rows); return rows; };
    expect(() => parsePantos(shipment(), edited(rows => { rows[0]!.hblNo = 'PJP000000001'; }))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePantos(shipment(), edited(rows => { rows[0]!.eventDt = '202602301135'; }))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePantos(shipment(), edited(rows => { delete rows[0]!.eventDt; }))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePantos(shipment(), edited(rows => { rows[0]!.evntDesc = ''; }))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePantos(shipment(), { list: [] })).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('classifies a code it does not map by the shared rules for its wording', () => {
    const rows = scans();
    Object.assign(rows[0]!, { evntCd: 'RTN', evntDesc: 'Returned to sender' });
    const result = parsePantos(shipment(), rows);
    expect(result.current_stage).toBe('returned');
    expect(result.current_stage_source).toMatch(/^wording:/);
    expect(pantosStage('ZZZZ', 'Something new')).toBeNull();
  });

  it('rejects malformed input before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new PantosTracker({ fetcher }).fetch('PJP1,PJP2')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(() => normalizePantosNumber('../x')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every code in statuses.json', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording)).toBe(entry.stage);
      expect(pantosStage(entry.code, entry.wording)?.stage).toBe(entry.stage);
    }
  });
});
