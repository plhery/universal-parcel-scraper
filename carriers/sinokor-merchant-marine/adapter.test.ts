import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { assertKnownBooking, parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;
const history = fixture('waybill.html');

it('checks the bill through the site and reads its dated tracking table', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(fixture('known.json')))
    .mockImplementationOnce(async () => new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number: number.toLowerCase() });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `https://ebiz.sinokor.co.kr/Home/chkExistsBooking?bkno=${number}`,
    `https://ebiz.sinokor.co.kr/Tracking?blno=${number}`,
  ]);
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'Return (1/1)', last_update_local: '2019-04-15T12:00',
  });
  expect(result.events).toHaveLength(7);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[2]).toMatchObject({ location: 'CAT LAI', description: 'Arrival', stage: 'in_transit' });
});

it('skips scheduled milestones and refuses missing or mismatched waybills', () => {
  const result = parseTracking(history.replace('<td>Departure</td>', '<td>Departure (Scheduled)</td>'), number);
  expect(result.events).toHaveLength(6);
  expect(result.events?.some(event => event.description?.includes('Departure'))).toBe(false);
  expect(() => assertKnownBooking(fixture('missing.json'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history.replace(`<td>${number}</td>`, '<td>SNKO000000000000</td>'), number))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});
