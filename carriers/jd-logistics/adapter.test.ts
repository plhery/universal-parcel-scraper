import { describe, expect, it, vi } from 'vitest';
import { JdLogisticsTracker } from './adapter.js';
import { parseJdLogistics } from './parser.js';

const NUMBER = 'JD0000000000001';
const history = () => ({ code: 1, data: [{ waybillNo: NUMBER, waybillNum: 1,
  receiverName: 'PRIVATE_RECIPIENT', wayBillTrackItemDtoList: [{ waybillNo: NUMBER,
    podUrl: 'PRIVATE_SIGNATURE', trackNodeList: [
      { operatorTime: '2026-09-03 10:00:00', operatorDesc: 'Delivered', routeCityName: 'Example City', routeCountry: 'Example Country', timeZone: 'CST', hasPodUrl: 1 },
      { operatorTime: '2026-09-02 12:00:00', operatorDesc: 'Arrived at sorting facility', routeCityName: 'Example Hub', timeZone: 'CST' },
    ] }] }] });

describe('JD Logistics international projection', () => {
  it('binds one waybill and preserves carrier order and unresolved clocks', () => {
    const result = parseJdLogistics(history(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-09-03T10:00:00' });
    expect(result.events).toHaveLength(2);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-09-03T10:00:00', location: 'Example City, Example Country', stage_source: 'wording:language' });
    expect(result.events?.every(event => !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('rejects a different parent and ambiguous pieces', () => {
    const wrong = history(); wrong.data[0]!.waybillNo = 'JD0000000000002';
    expect(() => parseJdLogistics(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const multi = history(); multi.data[0]!.wayBillTrackItemDtoList.push(multi.data[0]!.wayBillTrackItemDtoList[0]!);
    expect(() => parseJdLogistics(multi, NUMBER)).toThrow('multiple waybills');
    const partial = history(); partial.data[0]!.waybillNum = 2;
    expect(() => parseJdLogistics(partial, NUMBER)).toThrow('multiple waybills');
  });

  it('binds a single child waybill through its requested parent reference', () => {
    const reply = history(); reply.data[0]!.wayBillTrackItemDtoList[0]!.waybillNo = 'JD0000000000002';
    expect(parseJdLogistics(reply, NUMBER).events).toHaveLength(2);
  });

  it('keeps missing international history inconclusive', () => {
    expect(() => parseJdLogistics({ code: 1, data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = history(); empty.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList = [];
    expect(() => parseJdLogistics(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJdLogistics({ code: 0, data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects malformed dates and scan text instead of silently dropping rows', () => {
    const malformed = history(); malformed.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorTime = '2026-02-30 10:00:00';
    expect(() => parseJdLogistics(malformed, NUMBER)).toThrow('invalid scan clock');
    const unworded = history(); unworded.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorDesc = '';
    expect(() => parseJdLogistics(unworded, NUMBER)).toThrow('incomplete scan');
    const dateOnly = history(); dateOnly.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorTime = '2026-09-03';
    expect(() => parseJdLogistics(dateOnly, NUMBER)).toThrow('invalid scan clock');
  });

  it('uses explicit scan offsets and leaves unknown wording unclassified', () => {
    const reply = history(); reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorTime = '2026-09-03T10:00:00+08:00';
    reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorDesc = 'Unrecognized operation';
    const result = parseJdLogistics(reply, NUMBER);
    expect(result.last_update).toBe('2026-09-03T10:00:00+08:00');
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined();
  });

  it.each(['+99:00', '+02:99', '+14:01', '-1500'])('rejects an impossible offset: %s', offset => {
    const reply = history(); reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList[0]!.operatorTime = `2026-09-03T10:00:00${offset}`;
    expect(() => parseJdLogistics(reply, NUMBER)).toThrow('invalid scan offset');
  });

  it('sends the official anonymous request with the caller signal', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(history())));
    await new JdLogisticsTracker({ fetcher }).fetch(NUMBER, { budgetMs: 500 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://lop-proxy.ochama.com/WayBillApi/queryOrderTraceBatchV1');
    expect(JSON.parse(String(init?.body))).toEqual([{ magicNoList: [NUMBER], clientIp: '$cooMrdGatewayIp$', lang: 'en', timeZone: 'UTC' }]);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats endpoint disappearance as transport failure', async () => {
    await expect(new JdLogisticsTracker({ fetcher: async () => new Response('', { status: 404 }) }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'transport' });
  });
});
