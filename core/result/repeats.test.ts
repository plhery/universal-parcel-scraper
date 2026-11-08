import { describe, expect, it, vi } from 'vitest';
import type { AdapterRegistry } from '../adapter/index.js';
import { trackCarrier } from '../adapter/track.js';
import { UniversalTracker } from '../../providers/universal.js';
import type { CarrierEvent, CarrierResult } from './index.js';
import { withoutMinuteCopies, withoutRepeatedScans, withoutShortenedScans } from './repeats.js';

const scan = (time: string, description: string, stage = 'in_transit', more: Partial<CarrierEvent> = {}): CarrierEvent =>
  ({ time, description, stage, stage_source: 'carrier_map', ...more });
const result = (events: CarrierEvent[]): CarrierResult =>
  ({ status: 'in_transit', current_stage: 'in_transit', last_status_text: events[0]?.description ?? '', last_update: events[0]?.time ?? null,
    expected_delivery: null, events });
const kept = (answer: CarrierResult) => (answer.events ?? []).map(event => `${event.time} ${event.description}`);

describe('withoutRepeatedScans', () => {
  it('reads a step recorded again within minutes once, from its first record', () => {
    const departed = 'Departure from the international sorting center';
    const events = [
      scan('2030-01-10T04:56:22.265Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-10T04:56:22.214Z', 'Processed at the sorting center', 'in_transit', { provider_code: 'SORTED' }),
      scan('2030-01-10T04:56:18.469Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-10T04:55:00Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-10T04:54:01Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-10T04:54:00Z', departed, 'in_transit', { provider_code: 'GATEWAY' }),
      scan('2030-01-09T18:19:01Z', 'Processed at the sorting center', 'in_transit', { provider_code: 'SORTED' }),
      scan('2030-01-09T18:19:00Z', 'Processed at the sorting center', 'in_transit', { provider_code: 'DEPARTED' }),
    ];
    const once = withoutRepeatedScans(result(events));
    expect(kept(once)).toEqual([
      `2030-01-10T04:56:22.214Z Processed at the sorting center`,
      `2030-01-10T04:54:00Z ${departed}`,
      `2030-01-09T18:19:00Z Processed at the sorting center`,
    ]);
    expect(once.events![2]).toEqual(events[7]);
    expect(withoutRepeatedScans(once)).toEqual(once);
    const tied = [scan('2030-01-10T10:00:00Z', 'Arrived at the hub', 'in_transit', { tie_order: 1, provider_code: 'B' }),
      scan('2030-01-10T10:00:00Z', 'Arrived at the hub', 'in_transit', { tie_order: 0, provider_code: 'A' })];
    expect(withoutRepeatedScans(result(tied)).events).toEqual([tied[1]]);
  });

  it('keeps a repeat after a scan of another stage, or later than ten minutes, or elsewhere', () => {
    const events = [
      scan('2030-01-10T10:20:00Z', 'Out for delivery', 'out_for_delivery'),
      scan('2030-01-10T10:10:00Z', 'Delivery attempted', 'failed_attempt'),
      scan('2030-01-10T10:00:00Z', 'Out for delivery', 'out_for_delivery'),
      scan('2030-01-09T10:10:01Z', 'Arrived at the hub'),
      scan('2030-01-09T10:00:00Z', 'Arrived at the hub'),
      scan('2030-01-08T10:01:00Z', 'Arrived at the hub', 'in_transit', { location: 'Second Town' }),
      scan('2030-01-08T10:00:00Z', 'Arrived at the hub', 'in_transit', { location: 'First Town' }),
      scan('2030-01-07T10:01:00Z', ''),
      scan('2030-01-07T10:00:00Z', ''),
    ];
    const answer = result(events);
    expect(withoutRepeatedScans(answer)).toBe(answer);
  });

  it('compares wording and place as written, and reads wall clocks in a history without instants', () => {
    const events: CarrierEvent[] = [
      { local_time: '2030-01-10T09:05:00', description: 'Delivery attempted:  recipient absent', location: 'SAMPLE HUB', stage: 'failed_attempt' },
      { local_time: '2030-01-10T09:04:30', description: 'Delivery attempted: recipient absent', location: 'Sample hub', stage: 'failed_attempt' },
      { local_time: '2030-01-10T09:04:00', description: 'Delivery attempted: recipient absent', location: 'Sample hub', stage: 'failed_attempt' },
      { time: '2030-01-10', description: 'Delivery attempted: recipient absent', location: 'Sample hub', stage: 'failed_attempt' },
    ];
    expect(withoutRepeatedScans(result(events)).events).toEqual([events[2], events[3]]);
  });

  it("reads every adapter's and provider's answer so", async () => {
    const events = [scan('2030-01-10T10:02:00Z', 'Arrived at the hub'), scan('2030-01-10T10:00:00Z', 'Arrived at the hub')];
    const registry = { for: () => ({ steps: ['direct'], recordsSteps: true, track: async () => result(events) }) } as unknown as AdapterRegistry;
    const universal = {} as UniversalTracker;
    expect((await trackCarrier('dhl', { number: '00340434000000000001' }, { registry, universal })).events).toHaveLength(1);
    const browserLookup = vi.fn().mockResolvedValue(result(events));
    const tracker = new UniversalTracker({ providers: ['Ship24'], fetcher: vi.fn<typeof fetch>(), browserLookup });
    expect((await tracker.fetchSource('Ship24', 'ZZ12340678900')).events).toHaveLength(1);
  });
});

describe('withoutMinuteCopies', () => {
  // One answer's two networks: one dates a scan to the minute with its place, the other to the second.
  const minute = scan('2030-01-10T07:54:00Z', 'EN REPARTO. Su envío se encuentra en reparto.', 'out_for_delivery', { location: 'EXAMPLE TOWN' });
  const second = scan('2030-01-10T07:54:10Z', 'En reparto.  Su envío se encuentra en reparto.', 'out_for_delivery');

  it('keeps the copy to the second, with the place the copy to the minute gives', () => {
    const once = withoutMinuteCopies(result([second, minute]));
    expect(once.events).toEqual([{ ...second, location: 'EXAMPLE TOWN' }]);
    expect(withoutMinuteCopies(result([minute, second])).events).toEqual(once.events);
    expect(withoutMinuteCopies(once)).toBe(once);
    // The same place, or one that goes on after the other's parts; the copy to the second keeps its own.
    for (const [place, own] of [['Example Town, ST, Example Town ST 99999', 'Example Town, ST'], ['', ''], ['Hub', 'hub'], ['', 'Hub']]) {
      const copy = { ...second, location: own };
      expect(withoutMinuteCopies(result([copy, { ...minute, location: place }])).events, `${place}|${own}`).toEqual([copy]);
    }
    const local = { local_time: '2030-01-10T09:04:00', description: 'Delivered', stage: 'delivered' };
    const seconds = { ...local, local_time: '2030-01-10T09:04:41' };
    expect(withoutMinuteCopies(result([seconds, local])).events).toEqual([seconds]);
  });

  it('leaves scans of other words, stage, place, code or minute alone, and copies it cannot pair one to one', () => {
    for (const other of [
      { ...minute, description: 'Arrived at Facility' },
      { ...minute, stage: 'in_transit' },
      { ...minute, location: 'Example Townsend' },
      { ...minute, time: '2030-01-10T07:53:00Z' },
      { ...minute, time: '2030-01-10T07:54:00.001Z' },
      { ...minute, time: '2030-01-10T07:55:00Z' },
      { ...minute, provider_code: 'A' },
    ]) {
      const answer = result([{ ...second, location: 'Example Town', provider_code: 'B' }, other]);
      expect(withoutMinuteCopies(answer), JSON.stringify(other)).toBe(answer);
    }
    // Two places' scans in that minute and a copy that could be either's.
    const twice = result([second, minute, { ...minute, location: 'OTHER TOWN' }]);
    expect(withoutMinuteCopies(twice)).toBe(twice);
    const both = result([second, { ...second, time: '2030-01-10T07:54:20Z' }, minute]);
    expect(withoutMinuteCopies(both)).toBe(both);
    const day = result([{ local_time: '2030-01-10', description: 'Delivered', stage: 'delivered' }, scan('2030-01-10T00:00:00Z', 'Delivered', 'delivered')]);
    expect(withoutMinuteCopies(day)).toBe(day);
  });

  it("reads each provider's answer so, before a repeat keeps its first record", async () => {
    const browserLookup = vi.fn().mockResolvedValue(result([second, minute, scan('2030-01-10T07:50:00Z', 'Arrived at the delivery station')]));
    const tracker = new UniversalTracker({ providers: ['Ship24'], fetcher: vi.fn<typeof fetch>(), browserLookup });
    expect((await tracker.fetchSource('Ship24', 'ZZ12340678900')).events!.map((event) => `${event.time} ${event.location ?? ''}`))
      .toEqual(['2030-01-10T07:54:10Z EXAMPLE TOWN', '2030-01-10T07:50:00Z ']);
  });
});

describe('a scan listed in short and long words', () => {
  const at = '2026-10-30T16:32:35+00:00';
  const bare = scan(at, 'Colis non livré', 'failed_attempt', { location: 'Example Depot', provider_code: 'N' });
  const reason = scan('2026-10-30T16:32:35Z', 'Colis non livré : client absent', 'failed_attempt', { location: ' example depot ', provider_code: 'N' });

  it('keeps the longer line at the same instant and place, wherever it stands', () => {
    expect(withoutShortenedScans([bare, reason], ' : ')).toEqual([reason]);
    expect(withoutShortenedScans([reason, bare], ' : ')).toEqual([reason]);
    const local = { local_time: '2026-10-30T16:32:35', description: 'Arrived at Facility', location: 'EXAMPLE TOWN, WA, US' };
    const long = { ...local, description: 'Arrived at Facility -> Your item arrived at our facility in EXAMPLE TOWN.' };
    expect(withoutShortenedScans([long, local], ' -> ')).toEqual([long]);
  });

  it('leaves separate scans alone', () => {
    for (const other of [
      { ...bare, time: '2026-10-30T16:32:36Z' },
      { ...bare, location: 'Other Depot' },
      { ...bare, provider_code: 'D' },
      { ...bare, description: 'Colis non livré, client absent' },
      { ...bare, description: 'Colis' },
    ]) expect(withoutShortenedScans([other, reason], ' : '), JSON.stringify(other)).toEqual([other, reason]);
    expect(withoutShortenedScans([bare, reason], ' -> ')).toEqual([bare, reason]);
    const unclocked = { description: 'Colis non livré' };
    expect(withoutShortenedScans([unclocked, { ...unclocked, description: 'Colis non livré : client absent' }], ' : ')).toHaveLength(2);
  });

  it('lets a source that codes each line by its own words keep the longer line under another code', () => {
    expect(withoutShortenedScans([{ ...bare, provider_code: 'D' }, reason], ' : ', { anyCode: true })).toEqual([reason]);
  });
});
