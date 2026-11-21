// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GZYL } from '../../carriers/gzyl/parser.js';
import { ONE_BATCH_SCRIPTS } from '../../carriers/gzyl/script.js';
import { MTSCN } from '../../carriers/mtscn/parser.js';
import { PENGYOU } from '../../carriers/pengyou/parser.js';
import { XINGHE_FREIGHT } from '../../carriers/xinghe-freight/parser.js';
import { YUSUDA } from '../../carriers/yusuda/parser.js';
import type { CarrierResult } from '../../core/result/index.js';
import { UniversalTracker } from '../universal.js';
import { withoutScriptCopies } from './scripts.js';

// A synthetic copy of GZYL's script, as a provider relays it under GZYL's name.
const relayed = (overrides: Partial<CarrierResult> = {}): CarrierResult => ({
  tracking_provider: '17TRACK', status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
  last_status_text: 'Delivered Sampletown', last_update: '2026-03-14T10:00:00+08:00', reported_carriers: ['GZYL'],
  events: [
    { time: '2026-03-14T10:00:00+08:00', description: 'Delivered Sampletown', stage: 'delivered', stage_source: 'carrier_map', reporting_carrier: 'GZYL' },
    { time: '2026-03-02T15:07:14+08:00', description: 'Arrive at the cross border receiving point', stage: 'accepted', stage_source: 'carrier_map', reporting_carrier: 'GZYL' },
    { time: '2026-03-01T22:36:51+08:00', description: 'Order information received', stage: 'registered', stage_source: 'carrier_map', reporting_carrier: 'GZYL' },
  ],
  ...overrides,
});

describe('provider copies of a one-batch script', () => {
  it('names the tenants that keep only the order’s registration from their script', () => {
    for (const tenant of [GZYL, XINGHE_FREIGHT, YUSUDA, MTSCN, PENGYOU]) expect(ONE_BATCH_SCRIPTS.has(tenant.carrier), tenant.carrier).toBe(tenant.oneBatch === true);
  });

  it('keeps only the order’s registration, and reads the status from it', () => {
    const kept = withoutScriptCopies(relayed(), '17TRACK');
    expect(kept.events!.map((event) => event.description)).toEqual(['Order information received']);
    expect(kept).toMatchObject({ last_update: '2026-03-01T22:36:51+08:00', last_status_text: 'Order information received' });
    expect(kept).not.toHaveProperty('current_stage');
    // Xinghe Freight's rows, under the name 17TRACK gives them.
    const xinghe = relayed({ events: relayed().events!.map((event) => ({ ...event, reporting_carrier: 'GZXH' })) });
    expect(withoutScriptCopies(xinghe, '17TRACK').events).toHaveLength(1);
  });

  it('keeps another carrier’s rows, and a parcel’s when the provider names another carrier', () => {
    const post = { time: '2026-03-15T09:00:00+01:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map', reporting_carrier: 'Swiss Post' };
    const handed = relayed({ reported_carriers: ['GZYL', 'Swiss Post'], events: [post, ...relayed().events!] });
    expect(withoutScriptCopies(handed, '17TRACK').events!.map((event) => event.description)).toEqual(['Delivered', 'Order information received']);
    // Rows without a carrier's name are the parcel's carrier's, unless the provider names several.
    const unnamed = relayed({ discovered_carrier: 'gzyl', events: relayed().events!.map((event) => ({ ...event, reporting_carrier: undefined })) });
    expect(withoutScriptCopies(unnamed, 'ParcelsApp').events).toHaveLength(1);
    expect(withoutScriptCopies({ ...unnamed, reported_carriers: ['GZYL', 'Swiss Post'] }, 'ParcelsApp').events).toHaveLength(3);
    // Another carrier's answer is untouched.
    const other = relayed({ events: relayed().events!.map((event) => ({ ...event, reporting_carrier: 'Swiss Post' })) });
    expect(withoutScriptCopies(other, '17TRACK')).toBe(other);
  });

  it('reads a copy of the script alone as no history', async () => {
    const script = relayed({ events: relayed().events!.slice(0, 2) });
    expect(() => withoutScriptCopies(script, '17TRACK')).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'written_ahead' }));
    // As every provider's answer is read.
    const browserLookup = vi.fn().mockResolvedValue({ ...script, tracking_provider: 'Ship24' });
    const tracker = new UniversalTracker({ providers: ['Ship24'], trawlUrl: '', fetcher: vi.fn<typeof fetch>(), browserLookup });
    await expect(tracker.fetchSource('Ship24', 'YL738TEST0001YQ', 20_000)).rejects.toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'written_ahead' }));
    browserLookup.mockResolvedValue({ ...relayed(), tracking_provider: 'Ship24' });
    await expect(tracker.fetchSource('Ship24', 'YL738TEST0001YQ', 20_000)).resolves.toMatchObject({ events: [expect.objectContaining({ stage: 'registered' })] });
  });
});
