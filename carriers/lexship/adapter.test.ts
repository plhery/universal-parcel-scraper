import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LEXSHIP_API, lexshipPageToken } from './adapter.js';
import { normalizeLexshipNumber, parseLexship } from './parser.js';
import { lexshipStage } from './status.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const SAMPLE = 'RR057830637AE';
const TOKEN = 'eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl'; // gitleaks:allow (synthetic test token)
const NEWER = 'eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiJuZXcifQ.c2lnbmF0dXJl';
const page = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-Ab12_cd.js"></script></head></html>';
const script = (token: string) => `const a="eyJ0eXAiOiJKV1QifQ.b3RoZXI.eA";x();const ee="${token}";Ht.post("${LEXSHIP_API}",{awb_numbers:[{parcel_id:Y}]})`;

function tracker(api: (attempt: number) => Response, token = () => TOKEN) {
  const requests: { url: string; init: RequestInit }[] = [];
  let attempts = 0;
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    if (String(url) === 'https://track.lexship.biz/') return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
    if (String(url).includes('/assets/')) return new Response(script(token()), { status: 200, headers: { 'content-type': 'text/javascript' } });
    attempts += 1;
    return api(attempts);
  }) as typeof fetch;
  return { requests, track: adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, fetcher }) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('LEXSHIP tracking', () => {
  it('reads a delivered export to Belarus on its wall clocks, without the consignee', () => {
    const result = parseLexship(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2024-10-31T17:24:00', destination_country: 'BY',
    });
    expect(result.events).toHaveLength(13);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2024-09-28T12:58:28', description: 'Shipment Created', stage: 'registered' });
    expect(result.events!.find((event) => event.description === 'Sent for Customs Clearance')).toMatchObject({ stage: 'customs' });
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    const clocks = result.events!.map((event) => event.local_time as string);
    expect(clocks).toEqual([...clocks].sort().reverse());
    expect(JSON.stringify(result)).not.toMatch(/EXAMPLE|Minsk|Ahmedabad/);
  });

  it('keeps the reply\'s scan order for scans of the same second', () => {
    const reply = fixture('delivered') as [{ TrackPoints: { AWBHistory: { SNo: number; ActionDate: string; ActionTime: string }[] } }];
    const rows = reply[0].TrackPoints.AWBHistory;
    rows[0]!.ActionDate = rows[1]!.ActionDate;
    rows[0]!.ActionTime = rows[1]!.ActionTime;
    const result = parseLexship(reply, SAMPLE);
    expect(result.events!.slice(0, 2).map((event) => event.description)).toEqual(['Delivered', 'Item arrived to destination country']);
    expect(lexshipStage('Synthetic unknown step')?.source).not.toBe('carrier_map');
  });

  it('rejects a reply for another number', () => {
    expect(() => parseLexship(fixture('delivered'), 'RR000000000AE')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the tracker\'s "AWB Not Found" as not found, and nothing else', () => {
    expect(() => parseLexship(fixture('not-found'), 'LX1234567890')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLexship([], 'LX1234567890')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLexship({ message: 'Server Error' }, 'LX1234567890')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const listed = [{ AWBNo: 'LX1234567890', Status: 'Shipment Created', TrackPoints: { AWBHistory: [[]] } }];
    expect(() => parseLexship(listed, 'LX1234567890')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('never reads a malformed scan as a result', () => {
    const reply = fixture('delivered') as [{ TrackPoints: { AWBHistory: { ActionTime: string }[] } }];
    reply[0].TrackPoints.AWBHistory[0]!.ActionTime = '24:00:00';
    expect(() => parseLexship(reply, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('validates the number', () => {
    expect(normalizeLexshipNumber(' rr 057830637 ae ')).toBe(SAMPLE);
    expect(() => normalizeLexshipNumber('RR05')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('finds the token the page\'s script sends to the lookup', () => {
    expect(lexshipPageToken(script(TOKEN))).toBe(TOKEN);
    expect(lexshipPageToken('const a="eyJ0eXAiOiJKV1QifQ.b3RoZXI.eA";')).toBeUndefined();
  });

  it('posts the number with the page\'s token, reads the page once, and keeps HTTP failures apart from not found', async () => {
    const found = tracker(() => json(fixture('delivered')));
    await expect(found.track.track({ number: 'rr057830637ae' })).resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(found.track.track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(found.requests.map((request) => request.url)).toEqual([
      'https://track.lexship.biz/', 'https://track.lexship.biz/assets/index-Ab12_cd.js', LEXSHIP_API, LEXSHIP_API,
    ]);
    const lookup = found.requests[2]!;
    expect(lookup.init).toMatchObject({ method: 'POST', headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }) });
    expect(JSON.parse(String(lookup.init.body))).toEqual({ awb_numbers: [{ parcel_id: SAMPLE }] });

    const unknown = tracker(() => json(fixture('not-found')));
    await expect(unknown.track.track({ number: 'LX1234567890' })).rejects.toMatchObject({ kind: 'not_found' });
    const refused = tracker(() => json({ message: 'Unauthenticated.' }, 401));
    await expect(refused.track.track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'challenge' });
    const blocked = tracker(() => new Response('<html><title>Just a moment...</title>cf-turnstile</html>', { status: 403 }));
    await expect(blocked.track.track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'challenge' });
    const limited = tracker(() => new Response('Too many requests', { status: 429 }));
    await expect(limited.track.track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'rate_limited' });
    const moved = tracker(() => new Response('<html>Not Found</html>', { status: 404 }));
    await expect(moved.track.track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'transport' });
    const page = tracker(() => new Response('<html>Server Error</html>', { status: 200 }));
    await expect(page.track.track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('reads the page again when a kept token has expired', async () => {
    let token = TOKEN;
    const expiring = tracker((attempt) => (attempt === 2 ? json({ message: 'Unauthenticated.' }, 401) : json(fixture('delivered'))), () => token);
    await expect(expiring.track.track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    token = NEWER;
    await expect(expiring.track.track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    const lookups = expiring.requests.filter((request) => request.url === LEXSHIP_API);
    expect(lookups.map((request) => (request.init.headers as Record<string, string>).Authorization))
      .toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${NEWER}`]);
  });
});
