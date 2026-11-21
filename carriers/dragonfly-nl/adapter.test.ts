import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DragonflyNlTracker } from './adapter.js';
import { normalizeDragonflyNlNumber, parseDragonflyNl } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };

const [DELIVERED, LOST, ARCHIVED] = numbers.records.map(record => record.number) as [string, string, string];
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

describe('Dragonfly Netherlands response', () => {
  it('reads a delivered history by its status codes', () => {
    const result = parseDragonflyNl(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Hooray! Your package is here', delivered_at: '2026-11-03T14:29:53.027Z' });
    expect(result.events?.map(event => [event.provider_code, event.stage])).toEqual([
      ['601', 'delivered'], ['300', 'out_for_delivery'], ['105', 'accepted'], ['0', 'registered']]);
    expect(result.events?.every(event => event.stage_source === 'carrier_map' && event.time)).toBe(true);
    // The page names no client and the service no recipient; a delivered parcel shows no estimate.
    expect(result).not.toHaveProperty('sender_name');
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('expected_delivery');
  });

  it('reads a failed attempt followed by a lost parcel', () => {
    const result = parseDragonflyNl(fixture('lost-after-attempt'), LOST);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: "Uh-oh! We're unable to locate your package" });
    expect(result.events?.map(event => event.stage)).toEqual(['exception', 'failed_attempt', 'out_for_delivery', 'accepted', 'registered']);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads the older reply shape, with the label on the status, and a parcel back at the depot', () => {
    const result = parseDragonflyNl(fixture('archived-back-to-depot'), ARCHIVED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'We’ll try again soon!' });
    expect(result.events?.map(event => event.stage)).toEqual(['failed_attempt', 'out_for_delivery', 'in_transit', 'accepted', 'registered']);
  });

  it('reads the hour window the page shows once a driver has the parcel', () => {
    const payload = fixture('delivered'); const result = payload.data.result;
    result.status_list.shift(); result.last_status = result.status_list[0];
    expect(parseDragonflyNl(payload, DELIVERED)).toMatchObject({ status: 'out_for_delivery',
      expected_delivery_from: '2026-11-03T13:55:00Z', expected_delivery: '2026-11-03T14:55:00Z' });
  });

  it('accepts only the service\'s explicit not_found answer as absence', () => {
    expect(() => parseDragonflyNl(fixture('not-found'), 'AMZNL000000000001')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDragonflyNl({ success: false, data: { code: 'upstream_error', result: null } }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects malformed replies, another shipment and another network\'s parcel', () => {
    for (const payload of [{}, null, '<html>Just a moment...</html>', { success: true, data: {} }]) {
      expect(() => parseDragonflyNl(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const other = fixture('delivered'); other.data.result.tracking_id = LOST;
    expect(() => parseDragonflyNl(other, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const canadian = fixture('delivered'); canadian.data.result.subsidiary = 'dragonfly_ca';
    expect(() => parseDragonflyNl(canadian, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const broken = fixture('delivered'); broken.data.result.status_list.unshift(null);
    expect(() => parseDragonflyNl(broken, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('maps every recorded status to the stage it records', () => {
    for (const entry of statuses.entries) {
      const row = { status: Number(entry.code), statusCode: Number(entry.code), step: 2, timestamp: 1793716193027,
        isDelivered: entry.code === '601', task_type: 'last_mile_delivery', labels: { shortLabel: { en: entry.wording } } };
      const payload = { success: true, data: { code: 'found', result: { tracking_id: DELIVERED, subsidiary: 'dragonfly_nl', last_status: row, status_list: [row] } } };
      expect(parseDragonflyNl(payload, DELIVERED).current_stage, entry.code).toBe(entry.stage);
    }
  });
});

describe('Dragonfly Netherlands retrieval', () => {
  it('asks the Dutch portal\'s service without cookies or authentication', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture('delivered'))));
    await new DragonflyNlTracker({ fetcher }).fetch(DELIVERED.toLowerCase());
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://dragonflyshipping.nl/cfworker/v3/tracking/${DELIVERED}/`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(normalizeDragonflyNlNumber(' amznl-000009134020 ')).toBe(DELIVERED);
  });

  it('rejects invalid input and already aborted lookups before I/O', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['123', `${DELIVERED}/../x`, `${DELIVERED}?history=1`]) {
      await expect(new DragonflyNlTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(new DragonflyNlTracker({ fetcher }).fetch(DELIVERED, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a Cloudflare page in place of JSON as a challenge, and other HTML as a malformed reply', async () => {
    const page = (body: string) => vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html' } }));
    await expect(new DragonflyNlTracker({ fetcher: page('<!DOCTYPE html><title>Just a moment...</title>') }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(new DragonflyNlTracker({ fetcher: page('<!DOCTYPE html><title>Maintenance</title>') }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']])('does not confuse HTTP %s with a not-found answer', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('error code: 1015', { status: Number(status) }));
    await expect(new DragonflyNlTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
  });
});
