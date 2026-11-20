import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');
const history = fixture('history');

it('reads the public waybill and applies each movement’s explicit UTC offset', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('ou-yi-hang', number.toLowerCase()) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://oyh-exp.com/api/public/tracking/' + number, expect.any(Object));
  expect(result).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit', provider_code: 'ND',
    last_status_text: '运输中', last_update: '2026-08-01T01:25:00.000Z',
  });
  expect(result.events).toHaveLength(17);
  expect(result.events?.[0]).toMatchObject({ time: '2026-08-01T01:25:00.000Z', location: 'Frankfurt,DE', stage: 'in_transit' });
  expect(result.events?.find(event => event.description === '航班落地')).toMatchObject({
    time: '2026-07-28T01:02:13.000Z', location: 'ANR', stage: 'in_transit',
  });
  expect(result.events?.find(event => event.description === '到仓,待清关')).toMatchObject({ stage: 'customs' });
  expect(result.events?.find(event => event.description?.includes('UPS'))).toMatchObject({ stage: 'registered' });
  expect(result).not.toHaveProperty('expected_delivery');
  expect(result).not.toHaveProperty('delivery_tracking_number');
  expect(result).not.toHaveProperty('signed_by');
});

it('preserves a valid wall clock when a movement omits its offset', () => {
  const reply = JSON.parse(history);
  reply.data.details[0].gmtOffset = '';
  const result = parseTracking(JSON.stringify(reply), number);
  expect(result.events?.[0]).toMatchObject({ local_time: '2026-08-01T03:25:00', location: 'Frankfurt,DE' });
  expect(result.events?.[0]).not.toHaveProperty('time');
  expect(result).not.toHaveProperty('last_update');
});

it('distinguishes a missing waybill, a different identity and a malformed reply', () => {
  expect(() => parseTracking(fixture('missing'), 'OYH0000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, 'OYH0000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking('{}', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
});
