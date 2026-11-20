import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import fixture from './fixtures/pending.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;

it('uses the exact public result and reports its pending summary', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://api.ddxpress.vn/api/v1/tracking/' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'pending', last_status_text: 'Đang chờ cập nhật', summary_only: true,
  });
  expect(result.events).toBeUndefined();
  expect(result.last_update).toBeUndefined();
  expect(result.last_update_local).toBeUndefined();
});

it('rejects a response that belongs to another shipment', () => {
  expect(() => parseTracking(fixture, 'DDX000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
