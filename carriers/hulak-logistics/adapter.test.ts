import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const [delivered, registered] = numbers.records.map(record => record.number);
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('restores the printed branch reference and keeps delivery separate from the dated event', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('hulak-logistics', delivered!) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://logistics.hulakexpress.com/tracking/?tracking_number=' + delivered,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-08-31T03:28:00',
  });
  expect(result.events).toEqual([{
    local_time: '2026-08-26T02:21:00', description: 'Pickup Order Created', stage: 'registered', stage_source: 'carrier_map',
  }]);
});

it('accepts the alternate reference and ignores later upcoming milestones', () => {
  const result = parseTracking(fixture('pickup-created'), registered!);
  expect(result.current_stage).toBe('registered');
  expect(result.events).toHaveLength(1);
  expect(result.events?.[0]?.local_time).toBe('2026-09-16T14:00:00');
});

it('rejects empty and mismatched results and recognizes a verification prompt', () => {
  expect(() => parseTracking(fixture('empty-lookup'), delivered!)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('pickup-created'), delivered!)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  const verification = fixture('empty-lookup').replace('</form>', '<input name="captcha_code"></form>');
  expect(() => parseTracking(verification, delivered!)).toThrow(expect.objectContaining({ kind: 'challenge' }));
});
