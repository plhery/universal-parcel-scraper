import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AdapterEnvironment } from '../adapter/index.js';
import { trackCarrier } from '../adapter/track.js';
import { NOOP_RECORDER } from '../telemetry/index.js';
import type { UniversalTracker } from '../../providers/universal.js';
import type { CarrierEvent, CarrierResult } from './index.js';
import { resultStage } from './resolve.js';
import { readNewestStage } from './unstaged.js';

const scan = (time: string, description: string, stage?: string): CarrierEvent =>
  ({ time, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
const unknown = (events: CarrierEvent[]): CarrierResult =>
  ({ status: 'unknown', last_status_text: events[0]?.description ?? '', last_update: events[0]?.time ?? null, expected_delivery: null, events });

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
