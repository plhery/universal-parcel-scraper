import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, NHAT_TIN_API, nhatTinKeyDays, nhatTinLookupKey, NhatTinTracker } from './adapter.js';
import { nhatTinOperation, normalizeNhatTinNumber, parseNhatTin } from './parser.js';
import { nhatTinStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

type Row = Record<string, unknown>;
type Bill = Row & { histories: Row[] };
type Reply = Row & { data: Bill[] };

const DELIVERED = 'CP12446495887';
const LEGACY = '1174350186';
const UNKNOWN = 'CP17412845';
// 17:26 in Vietnam on 16 November 2026.
const AFTERNOON = Date.parse('2026-11-16T10:26:00Z');

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** A fixture whose only bill is changed in place by `change`. */
const changed = (name: string, change: (bill: Bill, reply: Reply) => void): Reply => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const service = (...replies: (() => Response)[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const reply of replies) fetcher.mockImplementationOnce(async () => reply());
  return fetcher;
};
const refused = () => json({ success: false, data: [], message: 'Auth Token không đúng' }, { status: 403 });
const tracker = (fetcher: typeof fetch, now = AFTERNOON) => new NhatTinTracker({ fetcher, now: () => now });

describe('Nhat Tin Logistics numbers and lookup key', () => {
  it('sends one whole number in capitals, which the service needs', () => {
    expect(normalizeNhatTinNumber(' cp1244 6495887 ')).toBe(DELIVERED);
    expect(normalizeNhatTinNumber(LEGACY)).toBe(LEGACY);
    for (const input of ['CP1234', 'CP12446495887,1174350186', 'CPABCDEFGH', `CP${'1'.repeat(30)}`]) {
      expect(() => normalizeNhatTinNumber(input), input).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keys a lookup with the day in Vietnam, and the next or previous day only next to its midnight', () => {
    // The key the service took on 16 November 2026.
    expect(nhatTinLookupKey(DateTime.fromISO('2026-11-16', { zone: 'Asia/Ho_Chi_Minh' }))).toBe('a06db9267696c87c9949d74d879bf75f');
    const days = (instant: string) => nhatTinKeyDays(Date.parse(instant)).map((day) => day.toFormat('dd-MM-yyyy'));
    expect(days('2026-11-16T10:26:00Z')).toEqual(['16-11-2026']);
    // 23:55 on the 16th and 00:05 on the 17th in Vietnam, still the 16th in UTC.
    expect(days('2026-11-16T16:55:00Z')).toEqual(['16-11-2026', '17-11-2026']);
    expect(days('2026-11-16T17:05:00Z')).toEqual(['17-11-2026', '16-11-2026']);
  });
});

describe('Nhat Tin Logistics replies', () => {
  it('reads a delivered bill newest first, on wall clocks, without the people and phones it names', () => {
    const result = parseNhatTin(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Đã giao hàng', provider_code: 'FBC', last_update: null, last_update_local: '2025-12-20T09:59:00',
      expected_delivery: null, service_name: 'MES' });
    expect(result.events).toHaveLength(8);
    expect(result.events![0]).toEqual({ local_time: '2025-12-20T09:59:00', location: 'Huyện Ba Vì, Hà Nội',
      description: 'Trả vận đơn cho ***', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit',
      'in_transit', 'in_transit', 'in_transit', 'accepted']);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2025-12-19T12:48:00', description: 'Nhận vận đơn từ ***' });
    expect(result.events![1]!.description).toBe('Xuất kho trả hàng');
    expect(result.events![2]!.description).toBe('Nhập kho: 3001-Kho Sơn Tây');
    expect(JSON.stringify(result)).not.toMatch(/Nguyễn|Kiên|cho Anh|886|Người Gửi|receiver|sender/);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
  });

  it('reads the older layout of warehouse operations', () => {
    const result = parseNhatTin(fixture('delivered-legacy'), LEGACY);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', service_name: 'Đường bộ' });
    expect(result.events!.map((event) => [event.description, event.stage])).toEqual([
      ['Trả vận đơn cho ***', 'delivered'],
      ['Xuất vận đơn từ Kho Bưu Cục Đắc Lắc', 'in_transit'],
      ['Nhập vận đơn vào Kho Bưu Cục Đắc Lắc', 'in_transit'],
      ['Xuất vận đơn từ Kho Văn Giang', 'in_transit'],
      ['Nhập vận đơn vào Kho Văn Giang', 'in_transit'],
      ['Xuất vận đơn từ Kho BC Hoàng Mai', 'in_transit'],
      ['Nhập vận đơn vào Kho BC Hoàng Mai', 'in_transit'],
      ['Nhận vận đơn từ ***', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Đào|Bảo|cho Hà/);
  });

  it('gives a bill on its way its estimate day, and stages an unknown status by its newest scan', () => {
    const moving = changed('delivered', (bill) => {
      Object.assign(bill, { billstatus: 'DIT', billstatus_desc: 'Đang vận chuyển' });
      bill.histories = bill.histories.slice(0, 5);
    });
    expect(parseNhatTin(moving, DELIVERED)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'Đang vận chuyển', provider_code: 'DIT', expected_delivery: '2025-12-22',
      last_update_local: '2025-12-20T02:32:00' });
    const unknown = changed('delivered', (bill) => {
      Object.assign(bill, { billstatus: 'ZZZ', billstatus_desc: 'Synthetic status' });
      bill.histories = bill.histories.slice(0, 1);
    });
    expect(parseNhatTin(unknown, DELIVERED)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Synthetic status' });
    const unstaged = changed('delivered', (bill) => {
      Object.assign(bill, { billstatus: 'ZZZ', billstatus_desc: '' });
      bill.histories = [{ operation: 'Synthetic note', loc_time: '19/12/2025 12:48' }];
    });
    expect(parseNhatTin(unstaged, DELIVERED)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
  });

  it('reports the tracker’s own not-found answer and a known bill without scans', () => {
    expect(() => parseNhatTin(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const listed = changed('delivered', (bill) => { bill.histories = []; });
    expect(() => parseNhatTin(listed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('rejects another bill, malformed clocks and changed envelopes, and keeps the service’s failure inconclusive', () => {
    expect(() => parseNhatTin(fixture('delivered'), LEGACY)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseNhatTin(changed('delivered', (_, reply) => { reply.data.push(reply.data[0]!); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const reply of [
      {}, { success: true, data: {} }, { success: true, data: [{ found: false }] }, { success: true, data: [] },
      changed('delivered', (bill) => { bill.found = 'yes'; }),
      changed('delivered', (bill) => { bill.histories = 'none' as never; }),
      changed('delivered', (bill) => { bill.histories[0]!.loc_time = '2025-12-19 12:48'; }),
      changed('delivered', (bill) => { bill.histories[0]!.loc_time = '31/02/2025 12:48'; }),
      changed('delivered', (bill) => { bill.histories[0]!.operation = { text: 'Nhập kho' }; }),
    ]) {
      expect(() => parseNhatTin(reply, DELIVERED), JSON.stringify(reply).slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const failed = { success: false, data: {}, message: 'Lỗi hệ thống: TypeError' };
    expect(() => parseNhatTin(failed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('masks the people an operation names, and phones anywhere', () => {
    expect(nhatTinOperation('Nhận vận đơn từ  Nguyễn Văn A')).toBe('Nhận vận đơn từ ***');
    expect(nhatTinOperation('Trả vận đơn cho Anh')).toBe('Trả vận đơn cho ***');
    expect(nhatTinOperation('Xuất kho trả hàng: Bưu tá Nguyễn Văn B')).toBe('Xuất kho trả hàng: ***');
    expect(nhatTinOperation('Xuất kho trả hàng: ')).toBe('Xuất kho trả hàng');
    expect(nhatTinOperation('Giao hàng không thành công, gọi 0912 345 678')).toBe('Giao hàng không thành công, gọi ***');
    expect(nhatTinOperation('Xuất kho - kho: Từ 2951-29- Kho An Hưng  Đến 2968-Kho Văn Giang'))
      .toBe('Xuất kho - kho: Từ 2951-29- Kho An Hưng Đến 2968-Kho Văn Giang');
  });
});

describe('Nhat Tin Logistics lookup', () => {
  it('asks the page’s lookup for the whole number with the day’s key, through the supplied transport', async () => {
    const fetcher = service(() => json(fixture('delivered')));
    await expect(new NhatTinTracker({ fetcher, now: () => AFTERNOON, userAgent: 'SyntheticHost/1.0' }).fetch('cp12446495887', { budgetMs: 1000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${NHAT_TIN_API}?q=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Authorization: 'a06db9267696c87c9949d74d879bf75f', 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('tries the other day’s key only next to midnight in Vietnam', async () => {
    const lateFetcher = service(refused, () => json(fixture('delivered')));
    await expect(tracker(lateFetcher, Date.parse('2026-11-16T17:05:00Z')).fetch(DELIVERED)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(lateFetcher.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).Authorization)).toEqual([
      nhatTinLookupKey(DateTime.fromISO('2026-11-17', { zone: 'Asia/Ho_Chi_Minh' })),
      nhatTinLookupKey(DateTime.fromISO('2026-11-16', { zone: 'Asia/Ho_Chi_Minh' })),
    ]);
    const fetcher = service(refused, () => json(fixture('delivered')));
    await expect(tracker(fetcher).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'challenge', reason: 'api_denied' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps refusals, block pages, throttling and moved routes apart from a missing bill', async () => {
    await expect(tracker(service(() => json(fixture('not-found')))).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(tracker(service(() => new Response('<html>Forbidden</html>', { status: 403 }))).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'challenge', reason: 'api_denied' });
    await expect(tracker(service(() => new Response('<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>'))).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker(service(() => new Response('<html>maintenance</html>'))).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'schema' });
    await expect(tracker(service(() => new Response(null, { status: 429 }))).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(tracker(service(() => new Response('Not Found', { status: 404 }))).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'transport' });
    await expect(tracker(service(() => new Response(null, { status: 302, headers: { Location: '/' } }))).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'transport' });
    const unreachable = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(tracker(unreachable).fetch(DELIVERED)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('registers one direct step and starts no request for a number it does not take', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    expect(provider).toMatchObject({ id: 'nhat-tin', steps: ['direct'], recordsSteps: true });
    expect(provider.recognize).toBeUndefined();
    await expect(provider.track({ number: 'CP1' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Nhat Tin Logistics status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(statusMapAnswer({ carrier: 'nhat-tin', providerCode: entry.code ?? null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });

  it('reads operations by their whole opening phrase and leaves other wording to the shared rules', () => {
    expect(statusMap.stage('FBC', 'synthetic')).toBe('delivered');
    expect(statusMap.stage(null, 'nhập kho: 2968-kho văn giang')).toBe('in_transit');
    expect(statusMap.stage(null, 'xuất kho trả hàng: ***')).toBe('out_for_delivery');
    expect(statusMap.stage(null, 'trả vận đơn cho ***')).toBe('delivered');
    expect(statusMap.stage(null, 'trả vận đơn chobits')).toBeUndefined();
    // A return on its way stays open; only the completed return closes the bill.
    expect(statusMap.stage(null, 'đang giao hàng hoàn')).toBe('exception');
    expect(statusMap.stage(null, 'đang chuyển hoàn')).toBe('exception');
    expect(statusMap.stage(null, 'đã chuyển hoàn')).toBe('returned');
    expect(nhatTinStage('Synthetic note')).toBeNull();
    expect(nhatTinStage('')).toBeNull();
  });
});

it('shows delivery first when pickup and delivery share the only minute', () => {
  const result = parseNhatTin(changed('delivered', bill => {
    delete bill.billstatus;
    delete bill.billstatus_desc;
    const pickup = bill.histories[0]!, delivery = bill.histories.at(-1)!;
    bill.histories = [pickup, { ...delivery, loc_time: pickup.loc_time }];
  }), DELIVERED);
  expect(result.current_stage).toBe('delivered');
  expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'accepted']);
  expect(result.last_status_text).toBe(result.events?.[0]?.description);
});
