import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { hartrodtReference, parseHartrodtDetails, parseHartrodtSearch } from './parser.js';

const house = hartrodtReference('SHPT2608285747');
const job = hartrodtReference('RTM1432602208143701');
const search = readFileSync(new URL('./fixtures/search.html', import.meta.url), 'utf8');
const details = readFileSync(new URL('./fixtures/details.html', import.meta.url), 'utf8');
const absent = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');

describe('a. hartrodt public tracking', () => {
  it('identifies a unique native result by its house bill or job number', () => {
    expect(parseHartrodtSearch(search, house)).toBe('56851177');
    expect(parseHartrodtSearch(search, job)).toBe('56851177');
    expect(() => parseHartrodtSearch(search.replaceAll(house.number, 'SHPT012026073305'), house))
      .toThrow(/did not identify the requested reference/);
    expect(() => parseHartrodtSearch(search.replace('/pserv/tt/open?', 'https://example.test/pserv/tt/open?'), house))
      .toThrow(/invalid detail link/);
  });

  it('preserves the timezone and leaves informational messages without a stage', () => {
    const result = parseHartrodtDetails(details, house);
    expect(result).toMatchObject({
      current_stage: 'in_transit', last_status_text: 'IMP - Information', last_update: '2026-09-21T00:00:00-01:00',
      expected_delivery: null,
    });
    expect(result.events).toHaveLength(8);
    expect(result.events?.[0]?.stage).toBeUndefined();
    expect(result.events?.[1]?.stage).toBeUndefined();
    expect(result.events?.[2]).toMatchObject({
      time: '2026-09-18T00:00:00-01:00', description: 'IMP - Flight/Vessel arrived', stage: 'in_transit',
    });
    expect(result.events?.at(-1)).toMatchObject({ time: '2026-08-19T14:57:00-01:00', stage: 'registered' });
    expect(parseHartrodtDetails(details, job)).toEqual(result);
    expect(() => parseHartrodtDetails(details.replaceAll(house.number, 'SHPT012026073305'), house))
      .toThrow(/did not identify the requested shipment/);
  });

  it('orders events by instant across the offsets in their native timestamps', () => {
    const mixed = details.replace('2026-09-18, 00:00 GMT-1', '2026-09-21, 01:30 GMT+2');
    const result = parseHartrodtDetails(mixed, house);
    expect(result.events?.[0]?.time).toBe('2026-09-21T00:00:00-01:00');
    expect(result.events?.[1]?.time).toBe('2026-09-21T01:30:00+02:00');
  });

  it('handles a native miss, an unknown page and a verified listing without history', () => {
    expect(() => parseHartrodtSearch(absent, house)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHartrodtSearch('<div>Nothing found</div>', house)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHartrodtDetails(details.slice(0, details.indexOf('</table>') + 8), house))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => parseHartrodtDetails(details.replace('00:00 GMT-1', '24:00 GMT-1'), house))
      .toThrow(/incomplete or undated event/);
  });

  it('submits the house number and fetches details from its anchored public pointer', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(search))
      .mockImplementationOnce(async () => new Response(details));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: ' shpt2608285747 ' }, { budgetMs: 2_000, signal: new AbortController().signal }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [searchUrl, init] = fetcher.mock.calls[0]!;
    expect(String(searchUrl)).toBe('https://ttsecure.hartrodt.com/pserv/tt/open');
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toBe('search_shipment=1&hawb=SHPT2608285747&submit=+Start+search+');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(fetcher.mock.calls[1]![0])).toBe('https://ttsecure.hartrodt.com/pserv/tt/open?view_detail=56851177');
    await expect(tracker.track({ number: 'https://example.test/' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops at a challenged search or a native miss', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response('Forbidden', { status: 403 }))
      .mockImplementationOnce(async () => new Response(absent));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: house.number })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker.track({ number: house.number })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
