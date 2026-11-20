import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { BEST_VN, parseBest } from './parser.js';
import { bestStage, statusMap } from './status.js';

const PUBLIC = '84859234749299';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const delivered = fixture('delivered');
const entry = delivered.data.expressList[0];
const reply = (changes: Record<string, unknown>, data: Record<string, unknown> = {}) =>
  ({ ...delivered, data: { ...delivered.data, ...data, expressList: [{ ...entry, ...changes }] } });

describe('BEST Express Vietnam tracker reply', () => {
  it('reads every scan newest first, without its courier, and its site as the place', () => {
    const result = normalizeCarrierResult(parseBest(delivered, PUBLIC, BEST_VN));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Lê Trần Trí Nhu Ký nhận', last_update: '2025-11-14T04:11:10.174Z', delivered_at: '2025-11-14T04:11:10.174Z',
      sender_name: 'TrustUp', receiver_name: 'Lê Trần Trí Nhu', receiver_address: 'Hồ Chí Minh', signed_by: 'Lê Trần Trí Nhu',
      timezone: 'Asia/Ho_Chi_Minh' });
    expect(result.events!.map(event => [event.description, event.location ?? null, event.provider_code ?? null, event.stage])).toEqual([
      ['Lê Trần Trí Nhu Ký nhận', 'FS NAM LONG, Quận 1', '17', 'delivered'],
      ['Đang giao hàng', 'FS NAM LONG, Quận 1', '04', 'out_for_delivery'],
      ['Đến nơi FS NAM LONG', 'FS NAM LONG, Quận 1', '03', 'in_transit'],
      ['Được gửi đến FS NAM LONG', 'HCM HUB, Củ Chi', '02', 'in_transit'],
      ['Đến nơi HCM HUB', 'HCM HUB, Củ Chi', '03', 'in_transit'],
      ['Được gửi đến HCM HUB', 'FS TÂN THỚI NHẤT, Quận 12', '02', 'in_transit'],
      ['Đã thu thập', 'FS TÂN THỚI NHẤT, Quận 12', '01', 'accepted'],
      ['successfully ordered', null, null, 'registered'],
    ]);
    expect(result.events![6]).toMatchObject({ time: '2025-11-13T10:25:44.614Z', original_description: 'Quận 12【FS TÂN THỚI NHẤT】,Đã thu thập' });
    // The courier's name and phone stay out of the result.
    expect(JSON.stringify(result)).not.toMatch(/\d{9,}|Đặng Minh Phát|Duc\. Nguyen/);
    expect(resolveResult(result)).toMatchObject({ current_stage: 'delivered' });
  });

  it('names the round while the parcel is out for delivery', () => {
    const result = parseBest(reply({ traceDetails: entry.traceDetails.slice(0, 7) }), PUBLIC, BEST_VN);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Đang giao hàng' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('signed_by');
  });

  it('reads a scan type it does not list by its wording', () => {
    const row = { ...entry.traceDetails[2], scanTypeCode: '99', remark: 'Quận 1【FS NAM LONG】,Synthetic wording' };
    const result = parseBest(reply({ traceDetails: [entry.traceDetails[0], row] }), PUBLIC, BEST_VN);
    expect(result.events![0]).toMatchObject({ description: 'Synthetic wording', location: 'FS NAM LONG, Quận 12', provider_code: '99' });
    expect(result).toMatchObject({ current_stage: 'registered', status: 'pending' });
  });

  it('answers not found only for a waybill the tracker lists without a history', () => {
    expect(() => parseBest(fixture('not-found'), '00000000000000', BEST_VN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBest(reply({ traceDetails: [] }), PUBLIC, BEST_VN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBest({ ...delivered, data: { ...delivered.data, expressList: [] } }, PUBLIC, BEST_VN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBest(fixture('risk'), PUBLIC, BEST_VN)).toThrow(expect.objectContaining({ kind: 'challenge', message: 'BEST Express Vietnam refused the picture verification' }));
    expect(() => parseBest({ success: false, errorCode: 'synthetic' }, PUBLIC, BEST_VN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBest(reply({}, { notMatchCodeList: [PUBLIC] }), PUBLIC, BEST_VN)).toThrow(expect.objectContaining({ kind: 'input_required' }));
  });

  it('keeps other waybills and unreadable scans apart from a missing parcel', () => {
    expect(() => parseBest(delivered, '84859234749290', BEST_VN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const value of [
      [], { success: true, data: {} }, reply({ traceDetails: {} }),
      reply({ traceDetails: [{ ...entry.traceDetails[1], acceptTime: null }] }),
      reply({ traceDetails: [{ ...entry.traceDetails[1], remark: '' }] }),
      reply({ traceDetails: [{ ...entry.traceDetails[1], remark: 'Quận 12【FS TÂN THỚI NHẤT】,【Synthetic Courier/0900000000】' }] }),
      reply({ traceDetails: Array.from({ length: 201 }, () => entry.traceDetails[1]) }),
    ]) expect(() => parseBest(value, PUBLIC, BEST_VN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('BEST Express Vietnam status map', () => {
  it('stages scans by type, then by wording', () => {
    expect(bestStage('04', 'Synthetic wording')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(bestStage('', 'successfully ordered')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(bestStage('99', 'Được gửi đến HCM HUB')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage('17', 'anything')).toBe('delivered');
    expect(statusMap.stage(null, normalizeStatusWording('Lê Trần Trí Nhu Ký nhận'))).toBe('delivered');
    expect(statusMap.stage(null, normalizeStatusWording('Ký nhận'))).toBeUndefined();
    expect(statusMap.stage(null, normalizeStatusWording('Được gửi đến'))).toBeUndefined();
  });
});
