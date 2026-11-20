import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('looks up a full house bill and returns the reported local movement history', async () => {
  const number = numbers.records[0]!.number;
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture(number.slice(4))));
  const tracker = adapter({ fetcher: request, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('procon-express-lines', number) });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'https://www.cmslonline.com/fclasp76H/AspWtPublic.jsp?imp=cms_cms&imp=cms_cms_pt&p_enquiry_ref=2ET26090083',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-10-28T11:07:00' });
  expect(result.events?.map(event => [event.description, event.local_time])).toEqual([
    ['LOADED CONTAINER INGATED', '2026-10-28T11:07:00'],
    ['CONTAINER OUTGATED', '2026-10-28T06:42:00'],
    ['CONTAINER DISCHARGED', '2026-10-22T10:20:00'],
    ['VESSEL ARRIVED', '2026-10-22T05:09:00'],
    ['VESSEL SAILED', '2026-09-25T22:44:00'],
    ['LOADED TO VESSEL', '2026-09-25T12:47:00'],
    ['BOOKED DATE', '2026-09-14T11:28:00'],
  ]);
});

it('keeps a second consignment separate and recognizes the explicit absence', () => {
  expect(parseTracking(fixture('2EM26080098'), '2EM26080098')).toMatchObject({
    current_stage: 'in_transit', last_update_local: '2026-10-13T07:13:00',
  });
  expect(() => parseTracking(fixture('2EM26080098'), '2ET26090083')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('not-found'), '3XX16020022')).toThrow(expect.objectContaining({ kind: 'not_found' }));
});
