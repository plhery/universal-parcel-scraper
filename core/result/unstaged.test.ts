import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment } from '../adapter/index.js';
import { trackCarrier } from '../adapter/track.js';
import { NOOP_RECORDER } from '../telemetry/index.js';
import type { UniversalTracker } from '../../providers/universal.js';
import type { CarrierEvent, CarrierResult } from './index.js';
import { resultStage } from './resolve.js';
import { leadingScan, movesNothing, readNewestStage } from './unstaged.js';
import type { CarrierStatusMap } from '../status/statusMap.js';

const scan = (time: string, description: string, stage?: string): CarrierEvent =>
  ({ time, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
const unknown = (events: CarrierEvent[]): CarrierResult =>
  ({ status: 'unknown', last_status_text: events[0]?.description ?? '', last_update: events[0]?.time ?? null, expected_delivery: null, events });

describe('leadingScan', () => {
  // A map that leaves a notice without a stage on purpose, by its wording and by a code with any wording.
  const map: CarrierStatusMap = {
    stage: () => undefined,
    gaps: [{ wording: 'expected delivery date updated', note: 'It moves nothing and keeps the stage of the scan before it.' },
      { code: 'NOTE', note: 'A note to the recipient: it keeps the stage of the scan before it.' }],
    gapNote: (_code, wording) => (wording.startsWith('delivery window ') ? 'A window, which moves nothing.' : undefined),
  };
  const delivered = scan('2026-01-04T15:00:00Z', 'Delivered', 'delivered');
  const coded = (event: CarrierEvent, provider_code: string): CarrierEvent => ({ ...event, provider_code });

  it('keeps a delivery under a newer notice the map says moves nothing', () => {
    for (const notice of [scan('2026-01-05T09:00:00Z', 'EXPECTED DELIVERY DATE UPDATED'), coded(scan('2026-01-05T09:00:00Z', 'Any wording'), 'NOTE'),
      scan('2026-01-05T09:00:00Z', 'Delivery window 9-12'), scan('2026-01-05T09:00:00Z', 'Awaiting delivery to an access point', 'pending')]) {
      expect(movesNothing(notice, map), notice.description).toBe(true);
      expect(leadingScan([notice, delivered], map), notice.description).toBe(delivered);
    }
  });

  it('lets a newer scan the map does not know undo a delivery or a return, and leads with a staged newest scan', () => {
    for (const stage of ['delivered', 'returned']) {
      expect(leadingScan([scan('2026-01-05T09:00:00Z', 'A new code'), scan('2026-01-04T15:00:00Z', 'Done', stage)], map)).toBeUndefined();
    }
    // A wording gap covers that wording only when it comes without a code.
    expect(leadingScan([coded(scan('2026-01-05T09:00:00Z', 'EXPECTED DELIVERY DATE UPDATED'), 'OTHER'), delivered], map)).toBeUndefined();
    const moving = scan('2026-01-05T09:00:00Z', 'Returned to the depot', 'in_transit');
    expect(leadingScan([moving, delivered], map)).toBe(moving);
    const transit = scan('2026-01-03T09:00:00Z', 'In transit', 'in_transit');
    expect(leadingScan([scan('2026-01-05T09:00:00Z', 'A new code'), transit], map)).toBe(transit);
  });

  it('leads with the newest staged notice when only notices came', () => {
    const pending = scan('2026-01-05T09:00:00Z', 'Awaiting delivery to an access point', 'pending');
    expect(leadingScan([scan('2026-01-06T09:00:00Z', 'EXPECTED DELIVERY DATE UPDATED'), pending], map)).toBe(pending);
    expect(leadingScan([scan('2026-01-06T09:00:00Z', 'EXPECTED DELIVERY DATE UPDATED')], map)).toBeUndefined();
  });
});

describe('readNewestStage', () => {
  it('reads a result whose newest scan has no stage by the newest scan with one', () => {
    const events = [scan('2026-01-04T19:00:00Z', 'A new code'), scan('2026-01-04T15:00:00Z', 'Delivery attempt failed', 'failed_attempt'),
      scan('2026-01-04T08:00:00Z', 'Out for delivery', 'out_for_delivery')];
    const read = readNewestStage(unknown(events));
    expect(read).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'A new code' });
    // The scan without a stage keeps none, so its wording stays open for review.
    expect(read.events?.[0]).not.toHaveProperty('stage');
    expect(resultStage(read)).toBe('failed_attempt');
  });

  it('claims no delivery or return the newer scans may have undone, and leaves a stated status alone', () => {
    for (const stage of ['delivered', 'returned']) {
      const events = [scan('2026-01-05T09:00:00Z', 'A new code'), scan('2026-01-04T15:00:00Z', 'Done', stage)];
      expect(readNewestStage(unknown(events))).toEqual(unknown(events));
    }
    expect(readNewestStage(unknown([scan('2026-01-05T09:00:00Z', 'A new code')]))).toMatchObject({ status: 'unknown' });
    const stated: CarrierResult = { ...unknown([scan('2026-01-05T09:00:00Z', 'A new code'), scan('2026-01-04T15:00:00Z', 'Moving', 'in_transit')]),
      status: 'pending' };
    expect(readNewestStage(stated)).toBe(stated);
  });

  it('applies to every adapter answer through trackCarrier', async () => {
    const environment: AdapterEnvironment = { trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER };
    const track = vi.fn().mockResolvedValue(unknown([scan('2026-01-04T19:00:00Z', 'Service point closed'),
      scan('2026-01-04T08:00:00Z', 'Out for delivery', 'out_for_delivery')]));
    const registry = new AdapterRegistry({ factories: { test: () => ({ id: 'test', steps: ['direct'], track }) }, carriers: { test: 'test' } }, environment);
    expect(await trackCarrier('test', { number: 'TEST0001' }, { registry, universal: {} as UniversalTracker }))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Service point closed' });
  });
});

it('takes the later tied stage in an oldest-first history', () => {
  const events = [
    scan('2026-11-01T08:00:00Z', 'Accepted', 'accepted'),
    scan('2026-11-01T09:00:00Z', 'On the road', 'out_for_delivery'),
    scan('2026-11-01T09:00:00Z', 'Attempt', 'failed_attempt'),
    scan('2026-11-01T10:00:00Z', 'Unknown'),
  ];
  expect(readNewestStage(unknown(events)).current_stage).toBe('failed_attempt');
});
