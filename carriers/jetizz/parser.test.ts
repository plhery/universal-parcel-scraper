import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isJetizzNumber, parseJetizz } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('Jetizz tracker reply', () => {
  it('reads a returned shipment, its movements and the partner\'s scans newest first by the day', () => {
    const result = parseJetizz(fixture('returned.html'), '2601794363');
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'İade Edildi', last_update: null, last_update_local: '2026-11-16', expected_delivery: null,
      sender_name: 'İ******** H********', receiver_name: 'K******** M********', receiver_address: 'İZMİR / BUCA',
      delivery_carrier: 'aras-kargo', delivery_tracking_number: '6526185890691' });
    expect(result).not.toHaveProperty('signed_by');
    expect(result).not.toHaveProperty('canonical_tracking_number');
    // Within a day Jetizz's movements follow the partner's scans; each list keeps its own order.
    expect(result.events!.map(event => [event.local_time, event.description, event.location ?? null, event.stage ?? null])).toEqual([
      ['2026-11-16', 'Kesin İade - Ulaşılamıyor', 'ISTANBULSUBE', 'exception'],
      ['2026-11-10', 'Acentede İade - Tanınmıyor', null, 'failed_attempt'],
      ['2026-11-10', 'Acentede İade - Dağıtıma Yetişmedi', null, 'failed_attempt'],
      ['2026-11-10', 'DAĞITIMDA - Kurye Üzerinde', null, 'out_for_delivery'],
      ['2026-11-10', 'ŞUBEDE ARAÇ İNDİRME', 'YENİGÜN', 'in_transit'],
      ['2026-11-10', 'AKTARMADA SUBE ARACI YUKLEME', 'EGE TRANSFER', 'in_transit'],
      ['2026-11-10', 'AKTARMADA HAT ARACI İNDİRME', 'EGE TRANSFER', 'in_transit'],
      ['2026-11-09', 'YOLDA', null, 'in_transit'],
      ['2026-11-09', 'AKTARMADA HAT ARACI YÜKLEME', 'MARMARA TRANSFER', 'in_transit'],
      ['2026-11-09', 'ŞUBEDE ARAÇ YÜKLEME', 'MARMARA KURUMSAL', 'in_transit'],
    ]);
  });

  it('reads a delivery at its clock, asked by the partner\'s number, and names Jetizz\'s own', () => {
    const result = parseJetizz(fixture('delivered.html'), '6509954188019');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Teslim Edildi',
      last_update_local: '2026-10-20T12:47:00', receiver_address: 'KIRIKKALE / YAHŞİHAN', canonical_tracking_number: '2601500385' });
    // The partner's number was the one asked for, so it is not handed off to.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.slice(0, 3)).toEqual([
      { local_time: '2026-10-20T12:47:00', description: 'Teslim Edildi', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-10-20', description: 'TESLİM - Diğer', stage: 'delivered', stage_source: 'carrier_map' },
      // Waiting for the next day a mobile branch serves the area keeps the stage before it.
      { local_time: '2026-10-17', description: 'Mobil Alan Tarihi Bekleniyor' },
    ]);
    expect(parseJetizz(fixture('delivered.html'), '2601500385')).toMatchObject({ delivery_carrier: 'aras-kargo',
      delivery_tracking_number: '6509954188019' });
  });

  it('keeps refused answers, missing shipments, other shipments and changed pages apart', () => {
    expect(() => parseJetizz(fixture('refused.html'), '2601794363')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseJetizz(fixture('not-found.html'), '0000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJetizz(fixture('not-found.html').replace('G&#246;nderi bulunamadı!', 'Sistem bakımda'), '0000000000'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJetizz(fixture('returned.html'), '2601794364')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJetizz(fixture('returned.html').replace('<th>İşlem Yeri</th>', '<th>Yer</th>'), '2601794363'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJetizz(fixture('returned.html').replace('<td>16.11.2026</td>', '<td>31.02.2026</td>'), '2601794363'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJetizz('<div>synthetic</div>', '2601794363')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes Jetizz\'s ten-digit waybills and the partner\'s thirteen-digit numbers', () => {
    expect(['2601794363', '6509954188019'].map(isJetizzNumber)).toEqual([true, true]);
    expect(['260179436', '26017943631', 'IH-4230269', 'AB12345678'].map(isJetizzNumber)).toEqual([false, false, false, false]);
  });
});
