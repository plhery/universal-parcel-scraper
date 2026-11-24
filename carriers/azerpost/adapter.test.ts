import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { adapter, AZERPOST_LOOKUP, AZERPOST_PAGE, AzerpostTracker } from './adapter.js';
import { normalizeAzerpostNumber, parseAzerpost } from './parser.js';
import { azerpostStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample: a registered letter posted in Baku for Australia, last scanned leaving Baku.
const ITEM = 'RR013659216AZ';
// A synthetic code with a valid check digit, which the tracker does not know.
const UNKNOWN = 'RR000000005AZ';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(fixture(name)) as { Item: { Event: Record<string, unknown>[] } & Record<string, unknown> };
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const once = (result: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(result);
// The sample's reply with other scans, oldest first, as the tracker lists them.
const withScans = (scans: Record<string, unknown>[] | Record<string, unknown>) => {
  const payload = json('departed');
  return { ...payload, Item: { ...payload.Item, Event: scans } };
};
const scan = (Code: string, Date = '2025-03-20T10:15:00', OfficeCd = 'Bakı: AZ1000') => ({ Code, Date, OfficeCd });
const BLOCKED = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.'
  + '<br>Your support ID is: 0000000000000000000</body></html>';

describe('Azerpost tracking adapter', () => {
  it("posts the page's form with the whole code through the supplied transport, without a session or a token", async () => {
    const fetcher = once(reply(fixture('departed')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AzerpostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rr 013 659 216 az ', { budgetMs: 1000 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(AZERPOST_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', Referer: AZERPOST_PAGE, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(new Headers(init.headers).has('cookie')).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
    expect([...(init.body as FormData).entries()]).toEqual([['package_id', ITEM], ['g_token', '']]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'azerpost', step: 'direct', outcome: 'ok' }));
  });

  it("reads the sample's scans newest first on their offices' wall clocks, with its weight and destination", () => {
    const result = parseAzerpost(json('departed'), ITEM);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Departure from outward office of exchange', last_update: null, last_update_local: '2025-03-10T06:37:10',
      expected_delivery: null, weight_kg: 0.32, destination_country: 'AU', events: [
        { local_time: '2025-03-10T06:37:10', location: 'AZBAKA, Bakı', description: 'Departure from outward office of exchange',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-03-07T18:45:00', location: 'AZ9095, Bakı', description: 'Arrival at outward office of exchange',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-03-07T12:57:00', location: 'AZ1000, Bakı', description: 'Posting/collection',
          stage: 'accepted', stage_source: 'carrier_map' },
      ] });
    // The mail class, the contents, the origin and the postal status are not read.
    expect(JSON.stringify(result)).not.toMatch(/Written mail|Merchandise|AZERBAIJAN|Arrived|ConditionCd/);
  });

  it("dates Baku's scans on Baku's clock and a foreign office's on its own, from the office the scan names", () => {
    const scans = [...json('departed').Item.Event, scan('Arrival at inward office of exchange', '2025-03-14T09:05:00', 'TURKEY: TRISTE')];
    const dated = dateLocalClocks('azerpost', parseAzerpost(withScans(scans), ITEM)).events!;
    expect(dated.map((event) => [event.location, event.local_time, event.time, event.time_zone])).toEqual([
      ['TRISTE, TURKEY', '2025-03-14T09:05:00', '2025-03-14T09:05:00+03:00', 'Europe/Istanbul'],
      ['AZBAKA, Bakı', '2025-03-10T06:37:10', '2025-03-10T06:37:10+04:00', 'Asia/Baku'],
      ['AZ9095, Bakı', '2025-03-07T18:45:00', '2025-03-07T18:45:00+04:00', 'Asia/Baku'],
      ['AZ1000, Bakı', '2025-03-07T12:57:00', '2025-03-07T12:57:00+04:00', 'Asia/Baku'],
    ]);
    // An office written otherwise is kept as written.
    expect(parseAzerpost(withScans(scan('Posting/collection', '2025-03-20T10:15:00', 'Gəncə Poçt Şöbəsi')), ITEM).events![0]!.location)
      .toBe('Gəncə Poçt Şöbəsi');
  });

  it('keeps a stated offset, reads a lone scan given as an object, and lists an item without scans as known', () => {
    expect(parseAzerpost(withScans(scan('Posting/collection', '2025-03-20T10:15:00+04:00')), ITEM)).toMatchObject({
      status: 'in_transit', current_stage: 'accepted', last_update: '2025-03-20T10:15:00+04:00',
      events: [{ time: '2025-03-20T10:15:00+04:00', location: 'AZ1000, Bakı', description: 'Posting/collection' }] });
    expect(parseAzerpost(withScans(scan('Posting/collection')), ITEM).events).toEqual([
      { local_time: '2025-03-20T10:15:00', location: 'AZ1000, Bakı', description: 'Posting/collection', stage: 'accepted', stage_source: 'carrier_map' }]);
    for (const empty of [[], null]) {
      expect(() => parseAzerpost(withScans(empty as never), ITEM)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    }
  });

  it('drops who took a delivered item, in English or in Azerbaijani, and stages other events by the shared rules', () => {
    const delivered = (wording: string) => parseAzerpost(withScans([scan('Posting/collection', '2025-03-07T12:57:00'), scan(wording)]), ITEM);
    for (const wording of ['Final delivery, recipient: SAMPLE NAME', 'Final delivery - SAMPLE NAME', 'Final delivery (SAMPLE NAME), signatory: SAMPLE']) {
      const result = delivered(wording);
      expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Final delivery' });
      expect(JSON.stringify(result)).not.toContain('SAMPLE');
    }
    expect(delivered('Çatdırılıb, alıcı: SAMPLE NAME')).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Çatdırılıb' });
    expect(delivered('Item out for physical delivery')).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'wording:language' });
    // An event neither the map nor the shared rules know stays visible without a stage; the scan before it leads.
    expect(delivered('Held at inward office of exchange')).toMatchObject({ current_stage: 'accepted',
      last_status_text: 'Held at inward office of exchange', events: [expect.not.objectContaining({ stage: expect.anything() }), expect.anything()] });
  });

  it('reads the not-found reply bound to the number as not found, and nothing else', async () => {
    await expect(carrier(once(reply(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const notFound = JSON.parse(fixture('not-found')) as Record<string, unknown>;
    expect(() => parseAzerpost({ code: 404, desc: 'Tracking number not found' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAzerpost(notFound, 'RR000000014AZ')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAzerpost({ ...notFound, data: 'http://backend.example:8080/tracking/en/api/Status' }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAzerpost({ ...notFound, desc: 'Service unavailable' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAzerpost({ code: 500, desc: 'Internal error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAzerpost({ code: 429, desc: 'Too many requests' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    // The page's validation reply: a refused token is a check to pass, a refused number field a changed form.
    expect(() => parseAzerpost({ error: true, message: 'Please fill all fields', errors: { g_token: ['The g token field is required.'] } }, ITEM))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseAzerpost({ error: true, message: 'Please fill all fields', errors: { package_id: ['The Bağlama kodu field must be 13 characters.'] } }, ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const odd of [null, [], { error: 'false', csrf: 'synthetic' }, { Item: 'none' }, { Item: { Weight: 0.32 } }]) {
      expect(() => parseAzerpost(odd, ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('binds the item to the whole code and refuses an invalid scan', () => {
    const payload = json('departed');
    expect(() => parseAzerpost({ ...payload, Item: { ...payload.Item, '@Identifier': 'RR013659220AZ' } }, ITEM))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const bad of [scan('Posting/collection', '2025-02-30T10:15:00'), scan('Posting/collection', '07.03.2025 12:57'), scan('', '2025-03-20T10:15:00'),
      scan('Posting/collection', '2025-03-20T25:15:00+04:00')]) {
      expect(() => parseAzerpost(withScans([bad]), ITEM), JSON.stringify(bad)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseAzerpost(withScans(['not a scan'] as never), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps block pages, refusals, moved routes and rate limits apart from a missing item, and retries a network failure once', async () => {
    for (const [response, kind] of [
      [reply(BLOCKED, 200, 'text/html'), 'challenge'],
      [reply('<html><title>Azərpoçt</title></html>', 200, 'text/html'), 'schema'],
      [reply('{"Item":', 200), 'schema'],
      [reply('Forbidden', 403, 'text/html'), 'challenge'],
      [reply('{"message":"CSRF token mismatch."}', 419), 'challenge'],
      [reply('', 302), 'transport'],
      [reply('', 404, 'text/html'), 'transport'],
      [reply('', 429), 'rate_limited'],
      [reply('', 503), 'maintenance'],
      [reply('', 500), 'indeterminate'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(carrier(fetcher).track({ number: ITEM }), `${response.status}`).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('departed')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("takes S10 codes with a valid check digit, Azerpost's and other posts', and refuses anything else before a request", async () => {
    expect(normalizeAzerpostNumber('rr013659216az')).toBe(ITEM);
    expect(normalizeAzerpostNumber('LX271828189SG')).toBe('LX271828189SG');
    for (const bad of ['RR013659217AZ', 'RR01365921AZ', '013659216', 'X'.repeat(65)]) {
      expect(() => normalizeAzerpostNumber(bad)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'RR013659217AZ' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording to its stage', () => {
    for (const entry of statuses.entries) {
      expect(azerpostStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
  });

  it('leaves the public sample to generic postal detection', () => {
    expect(detectCarrierMatch(ITEM).candidates ?? []).not.toContain('azerpost');
  });
});
