import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');

describe('Tradiva Logistics guest tracking', () => {
  it('reads five dated local events and the estimated arrival from the published demo', () => {
    const result = parseTracking(example, 'TDV-DEMO0001');
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'explicit_mapping',
      last_update: null, last_update_local: '2026-11-09T12:00', expected_delivery: '2026-11-14',
      last_status_text: 'في الطريق', service_name: 'شحن بحري',
    });
    expect(result.events?.map(({ description, local_time, stage, location }) => [description, local_time, stage, location])).toEqual([
      ['في الطريق', '2026-11-09T12:00', 'in_transit', 'Mediterranean Sea'],
      ['تم الشحن', '2026-11-07T11:00', 'in_transit', 'Mersin Port'],
      ['جمارك التصدير', '2026-11-05T10:00', 'customs', 'Mersin Port'],
      ['تم استلام البضاعة', '2026-11-04T09:00', 'accepted', 'Mersin, Turkey'],
      ['تم تأكيد الحجز', '2026-11-03T08:00', 'registered', 'Mersin, Turkey'],
    ]);
  });

  it('binds accepted container and bill references to the shipment returned', () => {
    for (const number of ['MSCU1234567', 'MEDU7654321', 'TDVDEMO0001']) {
      expect(parseTracking(example, number).events).toHaveLength(5);
    }
    expect(() => parseTracking(example, 'INVALID')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('distinguishes explicit absence from a changed page, invalid scan date or browser check', () => {
    expect(() => parseTracking(fixture('not-found'), 'TDV-7K4M9Q2X')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('<main>No result block</main>', 'TDVDEMO0001')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(example.replace('9 نوفمبر 2026', '91 نوفمبر 2026'), 'TDVDEMO0001'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', 'TDVDEMO0001'))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses the carrier’s number-only guest form', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'mscu1234567' })).resolves.toMatchObject({ status: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://tradivalogistics.com/tracking-1/');
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toBe('tdv_trk_ref=MSCU1234567&tdv_trk_hp=');
  });
});
