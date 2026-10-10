import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
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

  it('stages scans by their operation code and keeps it', () => {
    const reply = history();
    const nodes = reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList as Record<string, unknown>[];
    nodes[0] = { ...nodes[0], operatorDesc: 'Your package has been signed for, thank you for choosing JD Logistics!', operationCode: 'DLV' };
    nodes[1] = { ...nodes[1], operatorDesc: 'Your package has begun clearance', operationCode: 'CCL' };
    nodes.push({ operatorTime: '2026-09-01 08:00:00', operatorDesc: 'Something new', operationCode: 'ZZZ', timeZone: 'UTC+8' });
    const result = parseJdLogistics(reply, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(result.events?.map(event => [event.provider_code, event.stage, event.stage_source])).toEqual([
      ['DLV', 'delivered', 'carrier_map'], ['CCL', 'customs', 'carrier_map'], ['ZZZ', undefined, undefined],
    ]);
  });

  it('drops the courier\'s name and phone from the out-for-delivery wording', () => {
    const reply = history();
    const nodes = reply.data[0]!.wayBillTrackItemDtoList[0]!.trackNodeList as Record<string, unknown>[];
    nodes[0] = { ...nodes[0], operationCode: 'DMLMLS',
      operatorDesc: 'Your package is on the way; the courier is 【EXP-Jane Example Courier，500000000】, please be   patient.' };
    const result = parseJdLogistics(reply, NUMBER);
    expect(result.events?.[0]).toMatchObject({ description: 'Your package is on the way; please be patient.', stage: 'out_for_delivery' });
    expect(result.last_status_text).toBe('Your package is on the way; please be patient.');
    expect(JSON.stringify(result)).not.toMatch(/Jane|500000000/);
    // Bracketed places stay.
    nodes[0] = { ...nodes[0], operationCode: 'VUVU', operatorDesc: 'Your package has been unloaded at【Example Hub】' };
    expect(parseJdLogistics(reply, NUMBER).events?.[0]?.description).toBe('Your package has been unloaded at【Example Hub】');
  });

  it('lets a stored row that still holds the courier\'s contact take the redacted scan', () => {
    const policy = sameInstantIdentityPolicy('jd-logistics', { supportsScanMatching: true });
    const stored = { stage: 'in_transit', location: 'Example Province',
      description: 'Your package is on the way; the courier is 【EXP-Jane Example Courier，500000000】, please be   patient.', providerCode: '' };
    const incoming = { stage: 'out_for_delivery', location: 'Example Province',
      description: 'Your package is on the way; please be patient.', providerCode: 'DMLMLS' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, location: 'Another Province' })).toBe(false);
    expect(policy?.matches?.(incoming, { ...stored, description: 'Your package has been unloaded at【Example Hub】' })).toBe(false);
  });

  it('lets a scan stored before its code was kept take the code and its stage', () => {
    const policy = sameInstantIdentityPolicy('jd-logistics', { supportsScanMatching: true });
    expect(sameInstantIdentityPolicy('jd-logistics')).toBeUndefined();
    const stored = { stage: '', description: 'Your package has been signed for', location: 'Example City', providerCode: '' };
    const incoming = { ...stored, stage: 'delivered', providerCode: 'DLV' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    for (const different of [{ ...stored, providerCode: 'CCL' }, { ...stored, description: 'Order Created.' }, { ...stored, location: 'Another City' }]) {
      expect(policy?.matches?.(incoming, different)).toBe(false);
    }
    expect(policy?.matches?.({ ...incoming, providerCode: '' }, stored)).toBe(false);
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
