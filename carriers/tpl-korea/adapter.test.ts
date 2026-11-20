import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = readFileSync(new URL('./fixtures/air-transit.html', import.meta.url), 'utf8');

it('reports the last completed stage from the exact numbered response', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('tpl-korea', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.tborder.com/freight/hawb_tracking/' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toEqual({
    status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
    last_status_text: '항공운송중', summary_only: true,
  });
});

it('requires the exact waybill and ignores incomplete stages', () => {
  expect(() => parseTracking(fixture.replace(number, '0000000000000'), number))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  const upcoming = fixture.replace('is-complete" data-step="항공운송중"', 'is-pending" data-step="항공운송중"');
  expect(parseTracking(upcoming, number)).toMatchObject({ last_status_text: '출발지 출항대기', summary_only: true });
});
