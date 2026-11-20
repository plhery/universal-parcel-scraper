import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const dischargedNumber = numbers.records[0]!.number;
const shippedNumber = numbers.records[1]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('queries the Sallaum Lines guest route and keeps actual port movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('discharged')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('sallaum-lines', dischargedNumber) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://app.logisoft.io/api/unit/getunitbyserial?line=Sallaum+Lines+Ltd&serial=' + dischargedNumber,
    expect.any(Object),
  );
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'Unit discharged', last_update_local: '2025-10-29T10:47:07',
  });
  expect(result.events).toHaveLength(3);
  expect(result.events?.[0]).toMatchObject({ description: 'Unit discharged', location: 'Lagos', local_time: '2025-10-29T10:47:07' });
  expect(result.events?.[1]).toMatchObject({ description: 'Unit shipped', location: 'Davisville', local_time: '2025-10-03' });
  expect(result).not.toHaveProperty('delivered_at');
});

it('omits an absent discharge and refuses results for a different vehicle', () => {
  expect(parseTracking(fixture('shipped'), shippedNumber, 200).events).toHaveLength(2);
  expect(() => parseTracking(fixture('discharged'), shippedNumber, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), '00000000000000000', 404)).toThrow(expect.objectContaining({ kind: 'not_found' }));
});
