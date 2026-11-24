import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CITYMAIL_LOOKUP, CITYMAIL_PAGE } from './adapter.js';
import { normalizeCityMailNumber, parseCityMail } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and an invented number the tests give its reply to.
const SAMPLE = '111027990';
const OTHER = '900000001';
const TOKEN = 'SyntheticTokenForCityMailTests0000000000';
const PAGE = `<!DOCTYPE html><html><head><title>Track Shipments</title><meta name="csrf-token" content="${TOKEN}"></head>`
  + '<body><input type="text" id="track-nav" name="cn_number"></body></html>';

type Reply = { status: number; message: string; payload: string };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const CANCELLED = fixture('cancelled');
/** The sample's reply under another number, with its tracking rows replaced when given. */
const reply = (changes: { number?: string; rows?: string[] } = {}): Reply => {
  let html = CANCELLED.payload.replaceAll(SAMPLE, changes.number ?? OTHER);
  if (changes.rows) {
    html = html.replace(/(<div class="track-details fs-13">).*?(<\/div>\s*<\/div>\s*<\/div>\s*)$/s,
      `$1${changes.rows.map((row) => `<div><span class="border-bottom">${row}</span></div>`).join('')}$2`);
  }
  return { ...CANCELLED, payload: html };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: {
  'Content-Type': 'text/html; charset=UTF-8', 'Set-Cookie': 'city_mail_session=synthetic; Path=/; HttpOnly', ...init.headers,
} });
// A reply names the address it came from, which the cookie jar files its cookie under.
const answering = (fetcher: typeof fetch): typeof fetch => async (url, init) => {
  const response = await fetcher(url, init);
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher: answering(fetcher), recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CityMail Pakistan numbers', () => {
  it('takes a nine-character consignment number', () => {
    expect(normalizeCityMailNumber(` ${SAMPLE.slice(0, 4)} ${SAMPLE.slice(4)} `)).toBe(SAMPLE);
    expect(normalizeCityMailNumber('ab1234567')).toBe('AB1234567');
    for (const other of ['', '11102799', '1110279900', 'ABCDEFGHI', '11102799!', '9'.repeat(65)]) {
      expect(() => normalizeCityMailNumber(other), other).toThrow('nine-character CityMail consignment number');
    }
  });
});

describe('CityMail Pakistan tracking adapter', () => {
  it('posts the number with the page’s token, in the session the page opened, as the page’s script does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => (init?.method === 'POST' ? json(CANCELLED) : html(PAGE)));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'exception' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, page], [postUrl, post]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([String(pageUrl), String(postUrl)]).toEqual([CITYMAIL_PAGE, CITYMAIL_LOOKUP]);
    expect(page).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(post).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(Object.fromEntries(new URLSearchParams(String(post.body)))).toEqual({ cn_no: SAMPLE });
    const headers = new Headers(post.headers);
    expect([headers.get('x-csrf-token'), headers.get('x-requested-with'), headers.get('cookie')])
      .toEqual([TOKEN, 'XMLHttpRequest', 'city_mail_session=synthetic']);
    expect(carrier(fetcher)).toMatchObject({ id: 'citymail-pk', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s own answer for an unknown number as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => (init?.method === 'POST' ? json(fixture('not-found')) : html(PAGE)));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, refused tokens, error pages and redirects apart from a missing parcel', async () => {
    const answer = async (post: () => Response, page = () => html(PAGE)) => carrier(vi.fn<typeof fetch>()
      .mockImplementation(async (_url, init) => (init?.method === 'POST' ? post() : page())))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    const found = () => json(reply());
    expect(await answer(found, () => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(found, () => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(found, () => html('<html><head><title>Track Shipments</title></head></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(found, () => html('', { status: 302, headers: { Location: 'https://my.citymail.com.pk/login' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json({ message: 'CSRF token mismatch.' }, { status: 419 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Server Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    // Without its script's header the tracker answers an empty page.
    expect(await answer(() => html(''))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ message: 'The cn no field is required.', errors: { cn_no: ['The cn no field is required.'] } }, { status: 422 })))
      .not.toMatchObject({ kind: 'not_found' });
  });
});

describe('CityMail Pakistan replies', () => {
  it('reads the public sample: its rows newest first, on their wall clock', () => {
    const result = parseCityMail(CANCELLED, SAMPLE);
    expect(result).toEqual({
      status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', provider_code: 'Cancelled',
      last_status_text: 'Cancelled - Shipment is cancled', last_update: null, last_update_local: '2025-08-29T03:32:00',
      expected_delivery: null,
      events: [
        { local_time: '2025-08-29T03:32:00', description: 'Cancelled - Shipment is cancled', provider_code: 'Cancelled', stage: 'exception', stage_source: 'carrier_map' },
        { local_time: '2025-08-28T18:28:00', description: 'Booked - Shipment is booked', provider_code: 'Booked', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The shop that booked it, its reference and the cities stay behind.
    expect(JSON.stringify(result)).not.toMatch(/MIDRA|1000002|MR13287|Dubai/);
  });

  it('reads the twelve-hour clock, and an unknown status by its wording', () => {
    const result = parseCityMail(reply({ rows: [
      '28 Aug 2025, 12:05 AM - Booked - Shipment is booked',
      '1 Sep 2025, 12:40 PM - Delivered - Shipment is delivered',
    ] }), OTHER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'Delivered', last_update_local: '2025-09-01T12:40:00' });
    expect(result.events).toMatchObject([
      { local_time: '2025-09-01T12:40:00', provider_code: 'Delivered', stage: 'delivered', stage_source: expect.stringMatching(/^wording:/) },
      { local_time: '2025-08-28T00:05:00', provider_code: 'Booked', stage: 'registered' },
    ]);
  });

  it('leaves out a remark that names who took the parcel or gives a phone number', () => {
    const result = parseCityMail(reply({ rows: [
      '28 Aug 2025, 06:28 PM - Booked - Shipment is booked',
      '29 Aug 2025, 10:00 AM - Undelivered - Consignee not answering 0300 1234567',
      '30 Aug 2025, 02:15 PM - Delivered - Received by SYNTHETIC RECIPIENT',
      '30 Aug 2025, 02:15 PM - Delivered - Receiver name: SYNTHETIC RECIPIENT',
    ] }), OTHER);
    expect(result.events!.map((event) => event.description)).toEqual(['Delivered', 'Delivered', 'Undelivered', 'Booked - Shipment is booked']);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|1234567/);
  });

  it('binds the reply to the number asked', () => {
    expect(() => parseCityMail(reply(), '900000002')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCityMail(reply({ rows: [] }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, {}, { status: 1, payload: [] }, { status: 0, message: 'Something else', payload: [] },
      { ...CANCELLED, payload: CANCELLED.payload.replace('CN# ', 'Number') }, reply({ rows: ['2025-08-28 18:28 - Booked - Shipment is booked'] }),
      reply({ rows: ['31 Feb 2025, 06:28 PM - Booked'] }), reply({ rows: ['28 Aug 2025, 13:28 PM - Booked'] }), reply({ rows: ['28 Aug 2025, 06:28 PM - '] })]) {
      expect(() => parseCityMail(changed, OTHER), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('CityMail Pakistan statuses', () => {
  it('maps each status the tracker was seen to give', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'citymail-pk', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('Unknown', 'anything')).toBeUndefined();
  });
});
