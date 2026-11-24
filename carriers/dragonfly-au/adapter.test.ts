import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DragonflyAuTracker } from './adapter.js';
import { normalizeDragonflyAuNumber, parseDragonflyAu } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };

const [DELIVERED, ADDRESS, ATTEMPT, ROUND] = numbers.records.map(record => record.number) as [string, string, string, string];
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('Dragonfly Australia response', () => {
  it('reads a delivered history by its status codes', () => {
    const result = parseDragonflyAu(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Hooray! Your parcel is here', delivered_at: '2026-09-24T03:41:13.945Z' });
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['601', 'delivered'], ['300', 'out_for_delivery'], ['106', 'in_transit'], ['105', 'accepted'], ['0', 'registered']]);
    expect(result.events?.every(event => event.stage_source === 'carrier_map' && event.time && !event.location)).toBe(true);
    // The page names no client and the service no recipient; a delivered parcel shows no estimate.
    expect(result).not.toHaveProperty('sender_name');
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('expected_delivery');
  });

  it('reads an address problem on a round, the return to the station and a later delivery', () => {
    const result = parseDragonflyAu(fixture('address-problem-then-delivered'), ADDRESS);
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-04-15T09:39:45.673Z' });
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['601', 'delivered'], ['108', 'in_transit'], ['610', 'failed_attempt'], ['595', 'failed_attempt'],
      ['300', 'out_for_delivery'], ['108', 'in_transit'], ['105', 'accepted'], ['0', 'registered']]);
  });

  it('reads a parcel prepared for another round after a failed attempt, with the day the page shows', () => {
    const result = parseDragonflyAu(fixture('after-failed-attempt'), ATTEMPT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Your parcel is being prepared for delivery!',
      expected_delivery: '2026-04-29' });
    expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'failed_attempt', 'failed_attempt', 'out_for_delivery', 'in_transit', 'accepted', 'registered']);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads the hour window the page shows once a driver has the parcel', () => {
    expect(parseDragonflyAu(fixture('out-for-delivery'), ROUND)).toMatchObject({ status: 'out_for_delivery',
      expected_delivery_from: '2026-03-30T01:37:27Z', expected_delivery: '2026-03-30T05:37:27Z' });
  });

  it('accepts only the service\'s explicit not_found answer as absence', () => {
    expect(() => parseDragonflyAu(fixture('not-found'), 'DRNFLY000000000001')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDragonflyAu({ success: false, data: { code: 'upstream_error', result: null } }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects malformed replies, another shipment and another network\'s parcel', () => {
    for (const payload of [{}, null, '<html>Just a moment...</html>', { success: true, data: {} }]) {
      expect(() => parseDragonflyAu(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const other = fixture('delivered'); other.data.result.tracking_id = ADDRESS;
    expect(() => parseDragonflyAu(other, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const canadian = fixture('delivered'); canadian.data.result.subsidiary = 'dragonfly_ca';
    expect(() => parseDragonflyAu(canadian, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const broken = fixture('delivered'); broken.data.result.status_list.unshift(null);
    expect(() => parseDragonflyAu(broken, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('maps every recorded status to the stage it records', () => {
    for (const entry of statuses.entries) {
      const row = { status: Number(entry.code), statusCode: Number(entry.code), step: 2, timestamp: 1790221273945,
        isDelivered: entry.code === '601', task_type: 'last_mile_delivery', labels: { shortLabel: { en: entry.wording } } };
      const payload = { success: true, data: { code: 'found', result: { tracking_id: DELIVERED, subsidiary: 'dragonfly_au', last_status: row, status_list: [row] } } };
      expect(parseDragonflyAu(payload, DELIVERED).current_stage, entry.code).toBe(entry.stage);
    }
  });
});

describe('Dragonfly Australia retrieval', () => {
  it('asks the Australian portal\'s service without cookies or authentication', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture('delivered'))));
    await new DragonflyAuTracker({ fetcher }).fetch(DELIVERED.toLowerCase());
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://dragonflyshipping.com.au/cfworker/v3/tracking/${DELIVERED}/`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(normalizeDragonflyAuNumber(' drnfly-000023971907 ')).toBe(DELIVERED);
  });

  it('rejects invalid input and already aborted lookups before I/O', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123', `${DELIVERED}/../x`, `${DELIVERED}?history=1`]) {
      await expect(new DragonflyAuTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(new DragonflyAuTracker({ fetcher }).fetch(DELIVERED, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a Cloudflare page in place of JSON as a challenge, and other HTML as a malformed reply', async () => {
    const page = (body: string, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status, headers: { 'Content-Type': 'text/html' } }));
    await expect(new DragonflyAuTracker({ fetcher: page('<!DOCTYPE html><title>Just a moment...</title>') }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'challenge' });
    // The block page the service gives networks it refuses.
    await expect(new DragonflyAuTracker({ fetcher: page('<!DOCTYPE html><title>Attention Required! | Cloudflare</title>Sorry, you have been blocked', 403) }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(new DragonflyAuTracker({ fetcher: page('<!DOCTYPE html><title>Maintenance</title>') }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']])('does not confuse HTTP %s with a not-found answer', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('error code: 1015', { status: Number(status) }));
    await expect(new DragonflyAuTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
  });
});
