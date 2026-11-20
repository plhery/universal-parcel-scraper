import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import order from './fixtures/do.json' with { type: 'json' };
import house from './fixtures/hawb.json' with { type: 'json' };
import master from './fixtures/mawb.json' with { type: 'json' };
import missingOrder from './fixtures/missing-do.json' with { type: 'json' };
import missingHouse from './fixtures/missing-hawb.json' with { type: 'json' };
import missingMaster from './fixtures/missing-mawb.json' with { type: 'json' };
import { parseTracking, type ReferenceType } from './parser.js';

const examples = [
  { number: 'AASEL2632082', wire: 'AASEL2632082', type: 'hawb', fixture: house, stage: 'delivered', summary: 'Delivered SEMV 1/1 PCS' },
  { number: '18054765771', wire: '180-54765771', type: 'mawb', fixture: master, stage: 'in_transit', summary: 'Depart ASGL at: 19:10 30-Mar' },
  { number: '7337627075', wire: '7337627075', type: 'do', fixture: order, stage: 'in_transit', summary: 'Depart ASGL at: 19:10 30-Mar' },
] as const;

it.each(examples)('reads $type tracking without inferring a complete timestamp', async ({ number, wire, type, fixture, stage, summary }) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://ccteam.asgl.net.vn/api/tracking', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ tracking_number: wire, tracking_type: type, phone: '' }),
  }));
  expect(result).toMatchObject({ current_stage: stage, last_status_text: summary, summary_only: true, events: [] });
  expect(result.last_update).toBeUndefined();
  expect(result.delivered_at).toBeUndefined();
});

it('requires an exact identifier and understands both native no-result shapes', () => {
  const controls: [ReferenceType, string, unknown][] = [
    ['hawb', 'ASGLUNKNOWN000', missingHouse], ['mawb', '18000000001', missingMaster], ['do', '0000000000', missingOrder],
  ];
  for (const [kind, number, raw] of controls) {
    expect(() => parseTracking(JSON.stringify(raw), number, kind)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  }
  expect(() => parseTracking(JSON.stringify(house), 'ASGLUNKNOWN000', 'hawb')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
