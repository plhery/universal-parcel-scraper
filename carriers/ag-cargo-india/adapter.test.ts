import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import fixture from './fixtures/delivered.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;

it('checks the LR and delivers the actual scan with its local time and facility', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://api.agcargo.in/api/Delhivery/TrackingLR?LrNo=' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-08-11T16:11:09',
  });
  expect(result.events).toEqual([{
    local_time: '2026-08-11T16:11:09', provider_code: 'DELIVERED', description: 'Delivered',
    location: 'KalyanpurBR_Ladaura_D (Bihar)', stage: 'delivered', stage_source: 'carrier_map',
  }]);
});

it('rejects mismatched LRs and leaves a delivered summary undated without a movement timestamp', () => {
  expect(() => parseTracking(fixture, '000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  const withoutScan = structuredClone(fixture);
  withoutScan.data.wbns[0]!.scan_timestamp = '';
  expect(parseTracking(withoutScan, number)).toEqual({
    status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
    last_status_text: 'Delivered', summary_only: true,
  });
});
