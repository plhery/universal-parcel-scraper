import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { parseVnpost } from './parser.js';
import { statusMap, vnpostStage } from './status.js';

const PUBLIC = 'EK572324490VN';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const delivered = fixture('delivered');
const scans = (count: number) => ({ ...delivered, locate: delivered.locate.slice(0, count) });

describe('VNPost tracker reply', () => {
  it('reads every scan newest first with its stated offset, office and point', () => {
    const result = normalizeCarrierResult(parseVnpost(delivered, PUBLIC));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'EMI - Phát thành công (Delivered)', last_update: '2026-03-17T09:12:55+07:00',
      delivered_at: '2026-03-17T09:12:55+07:00', weight_kg: 0.016 });
    expect(result).not.toHaveProperty('destination_country');
    expect(result.events).toHaveLength(10);
    expect(result.events![0]).toEqual({ time: '2026-03-17T09:12:55+07:00', description: 'EMI - Phát thành công (Delivered)',
      original_description: 'EMI - Phát thành công (Delivered) (573050: BCP Nghĩa Hành - Quảng Ngãi )', location: 'BCP Nghĩa Hành - Quảng Ngãi',
      point: { latitude: 15.0467, longitude: 108.777 }, provider_code: 'KT5', stage: 'delivered', stage_source: 'carrier_map' });
    // The posting scan's customer-service line is left out with its office.
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-03-16T19:13:34+07:00', description: 'EMA - Chấp nhận gửi (Posting / Collection)',
      location: 'Quang Trung - Quảng Ngãi', provider_code: 'KT1', stage: 'accepted' });
    // Fractions of a second are dropped from the stated clock.
    expect(result.events!.find(event => event.provider_code === 'VC3')!.time).toBe('2026-03-17T07:46:44+07:00');
    expect(result.events!.map(event => event.stage ?? null)).toEqual(['delivered', null, 'out_for_delivery', 'in_transit', 'in_transit',
      'in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted']);
    for (const event of result.events!) expect(event.description).not.toMatch(/CSKH|\(\d{6}:/);
    // The delivery rows name the recipient and are not scans.
    expect(JSON.stringify(result)).not.toMatch(/ubnd|Người nhận/i);
    expect(JSON.stringify(result)).toBe(JSON.stringify(result).normalize('NFC'));
    expect(resolveResult(result)).toMatchObject({ current_stage: 'delivered' });
  });

  it('names the hand-over to the postman, not its routing, while the item is out for delivery', () => {
    const result = normalizeCarrierResult(parseVnpost(scans(9), PUBLIC));
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      last_status_text: 'EDG - Đã giao bưu tá phát - Item out for physical delivery', last_update: '2026-03-17T08:55:52+07:00' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.slice(0, 2).map(event => event.provider_code)).toEqual(['KT18', 'KT12']);
  });

  it('keeps a destination abroad and leaves a point outside Vietnam out', () => {
    const abroad = { ...delivered, info: { ...delivered.info, Nuoc_Phat: 'FR - FRANCE' },
      locate: [{ ...delivered.locate[0], Lat: '48.85', Long: '2.35' }] };
    const result = parseVnpost(abroad, PUBLIC);
    expect(result).toMatchObject({ destination_country: 'FR', status: 'in_transit', current_stage: 'accepted' });
    expect(result.events![0]).not.toHaveProperty('point');
  });

  it('answers not found only for the tracker\'s unknown-number reply', () => {
    expect(() => parseVnpost(fixture('not-found'), PUBLIC)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseVnpost(fixture('captcha-refused'), PUBLIC)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseVnpost({ message: 'Synthetic other failure' }, PUBLIC)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseVnpost(delivered, 'EK572324481VN')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps batches, empty histories and unreadable scans apart from a missing parcel', () => {
    for (const [reply, kind] of [
      [{ ...delivered, info: { ...delivered.info, LO_GUI: 1 } }, 'indeterminate'], [scans(0), 'indeterminate'],
      [{ ...delivered, locate: undefined }, 'indeterminate'], [[], 'schema'],
      [{ ...delivered, locate: [{ ...delivered.locate[0], TraceDate: '2026-03-16T19:13:34' }] }, 'schema'],
      [{ ...delivered, locate: [{ ...delivered.locate[0], StatusText: '' }] }, 'schema'],
      [{ ...delivered, locate: [{ ...delivered.locate[0], StatusText: '(571020: Quang Trung - Quảng Ngãi )' }] }, 'schema'],
      [{ ...delivered, locate: Array.from({ length: 201 }, () => delivered.locate[0]) }, 'schema'],
    ] as const) expect(() => parseVnpost(reply, PUBLIC)).toThrow(expect.objectContaining({ kind }));
  });
});

describe('VNPost status map', () => {
  it('stages scans by code, then by wording, and leaves the routing to the scan before it', () => {
    expect(vnpostStage('KT12', 'Synthetic wording')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(vnpostStage('KT18', 'Routed')).toBeNull();
    expect(vnpostStage('ZZ9', 'Phát không thành công (Not Delivered)')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(vnpostStage('ZZ9', 'EMH - Chuyển hoàn (Return)')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(statusMap.stage('KT5', 'anything')).toBe('delivered');
    expect(statusMap.stage(null, normalizeStatusWording('Chuyển tiếp (Forward)'))).toBe('in_transit');
    expect(statusMap.stage('KT18', 'routed')).toBeUndefined();
  });
});
