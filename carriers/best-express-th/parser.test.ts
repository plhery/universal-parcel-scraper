import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { parseBest } from '../best-express-vn/parser.js';
import { BEST_TH } from './parser.js';
import { statusMap } from './status.js';

const PUBLIC = '66857942189018';
const delivered = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));

describe('BEST Express Thailand tracker reply', () => {
  it('reads the English scans newest first, without the courier, on Bangkok time', () => {
    const result = normalizeCarrierResult(parseBest(delivered, PUBLIC, BEST_TH));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: '2024-09-15T05:50:45.752Z', delivered_at: '2024-09-15T05:50:45.752Z', signed_by: 'วิลาวัลย์ กลมกล่อม',
      receiver_address: 'จังหวัดกรุงเทพมหานคร', timezone: 'Asia/Bangkok' });
    expect(result).not.toHaveProperty('sender_name');
    expect(result.events!.map(event => [event.time, event.description, event.location, event.provider_code, event.stage])).toEqual([
      ['2024-09-15T05:50:45.752Z', 'วิลาวัลย์ กลมกล่อม POD', 'Phra kranong2, Phra Khanong', '17', 'delivered'],
      ['2024-09-15T05:24:20.258Z', 'delivery on the way', 'Phra kranong2, Phra Khanong', '04', 'out_for_delivery'],
      ['2024-09-15T02:45:26.242Z', 'arrived Phra kranong2', 'Phra kranong2, Phra Khanong', '03', 'in_transit'],
      ['2024-09-13T17:38:07.617Z', 'on the way to Phra kranong2', 'BKK HUB, Bang Phli', '02', 'in_transit'],
      ['2024-09-13T16:19:49.194Z', 'arrived BKK HUB', 'BKK HUB, Bang Phli', '03', 'in_transit'],
      ['2024-09-13T01:49:24.019Z', 'on the way to BKK HUB', 'Wang Noi, Uthai', '02', 'in_transit'],
      ['2024-09-13T01:49:14.233Z', 'Pickup', 'Wang Noi, Uthai', '01', 'accepted'],
    ]);
    // The couriers' names and phones stay out of the result.
    expect(JSON.stringify(result)).not.toMatch(/\d{9,}|ธีปกรณ์|ประเสิรฐ/);
  });

  it('names Thailand in its failures', () => {
    expect(() => parseBest({ success: false, errorCode: 'risk_001' }, PUBLIC, BEST_TH))
      .toThrow(expect.objectContaining({ kind: 'challenge', message: 'BEST Express Thailand refused the picture verification' }));
    expect(() => parseBest(delivered, '66857942189010', BEST_TH))
      .toThrow(expect.objectContaining({ kind: 'schema', message: 'BEST Express Thailand answered for another waybill' }));
  });

  it('stages the English wordings without their scan type', () => {
    for (const [wording, stage] of [['Pickup', 'accepted'], ['on the way to BKK HUB', 'in_transit'], ['arrived BKK HUB', 'in_transit'],
      ['delivery on the way', 'out_for_delivery'], ['Synthetic Name POD', 'delivered']] as const) {
      expect(statusMap.stage(null, normalizeStatusWording(wording))).toBe(stage);
    }
  });
});
