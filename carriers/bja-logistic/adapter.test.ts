import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const august = fixture('august');

describe('BJA Logistic public tracking', () => {
  it('reads Indonesian dates, route milestones and the quoted arrival date', () => {
    const result = parseTracking(august, 200, '8203');
    expect(result).toMatchObject({
      status: 'unknown', last_status_text: 'Barang Diterima', last_update: null, last_update_local: '2026-08-31',
      expected_delivery: '2026-08-15', service_name: 'Express',
    });
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events?.map(({ description, local_time, stage, location }) => [description, local_time, stage, location])).toEqual([
      ['Barang Diterima', '2026-08-31', undefined, undefined],
      ['Perjalanan ke Hub Tujuan', '2026-08-13', 'in_transit', undefined],
      ['Menunggu Jadwal Keberangkatan Kapal', '2026-08-11', undefined, undefined],
      ['Barang Diproses di Hub Transit', '2026-08-07', 'in_transit', undefined],
      ['Perjalanan Menuju Hub Transit', '2026-08-05', 'in_transit', undefined],
      ['Barang Diterima di Warehouse Bekasi', '2026-08-04', 'accepted', 'Bekasi'],
    ]);
  });

  it('allows a matching reply without an estimate', () => {
    const result = parseTracking(fixture('november'), 200, '10702');
    expect(result.expected_delivery).toBeNull();
    expect(result.events?.map(event => event.local_time)).toEqual(['2026-11-17', '2026-11-09', '2026-11-02', '2026-10-28']);
  });

  it('distinguishes a missing shipment from a changed payload, wrong number or blocked page', () => {
    expect(() => parseTracking(fixture('not-found'), 404, '9875')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('{}', 404, '9875')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(august, 200, '999999999999999')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(august.replace('4 Agu', '32 Agu'), 200, '8203'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', 200, '8203')).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('submits the invoice number without leading zeroes to the guest endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(august));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'BJA' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(tracker.track({ number: '008203' })).resolves.toMatchObject({ last_update_local: '2026-08-31' });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://bjalogistic.id/api/tracking?resi=8203');
  });
});
