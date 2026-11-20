import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, TOPPARCEL_TRACKER } from './adapter.js';
import { normalizeTopparcelNumber, parseTopparcel } from './parser.js';
import { statusMap, topparcelStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };

// The replies to two public samples: one relayed from two posts, one from FedEx. The tests derive invented parcels from them.
const POSTS = numbers.records[0]!.number;
const FEDEX = numbers.records[2]!.number;
const OTHER = 'ZZ900000001ZZ';
const TOKEN = btoa('SYNTHETIC-TOKEN-FOR-TOPPARCEL-TESTS');

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Set-Cookie': 'session=synthetic; Path=/; HttpOnly', ...init.headers } });
// A reply names the address it came from, which the cookie jar files its cookie under.
const answering = (fetcher: typeof fetch): typeof fetch => async (url, init) => {
  const response = await fetcher(url, init);
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher: answering(fetcher), recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (clock: string, country: string, address: string, ...lines: string[]) =>
  `<tr class="text-gray-700"><td class="whitespace-nowrap px-3 py-3">${clock}</td><td class="px-3 py-3">${country}</td><td class="px-3 py-3">${address}</td><td class="px-3 py-3">${lines.map((line) => `<p class="text-gray-900">${line}</p>`).join('')}</td></tr>`;
/** The FedEx sample's page under another number, with its rows replaced when given. */
const parcel = (changes: { number?: string; rows?: string[] } = {}) => {
  const number = changes.number ?? OTHER;
  const base = page(FEDEX).replaceAll(FEDEX, number);
  return changes.rows ? base.replace(/<tbody([^>]*)>.*?<\/tbody>/s, `<tbody$1>${changes.rows.join('')}</tbody>`) : base;
};

describe('Topparcel numbers', () => {
  it('takes the booked courier’s or post’s number in letters and digits', () => {
    expect(normalizeTopparcelNumber(` ${POSTS.toLowerCase()} `)).toBe(POSTS);
    for (const other of ['', '1234567', 'ABCDEFGHIJ', 'ZZ90000!01', '9'.repeat(41)]) {
      expect(() => normalizeTopparcelNumber(other), other).toThrow('tracking number of the courier Topparcel booked');
    }
  });
});

describe('Topparcel tracking adapter', () => {
  it('posts the number to the form with its token, in the session the form opened', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => html(init?.method === 'POST' ? page(POSTS) : page('form')));
    await expect(carrier(fetcher).track({ number: POSTS.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'RU' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[formUrl, form], [postUrl, post]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([String(formUrl), String(postUrl)]).toEqual([TOPPARCEL_TRACKER, TOPPARCEL_TRACKER]);
    expect(form).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(post).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(Object.fromEntries(new URLSearchParams(String(post.body)))).toEqual({ TOPPARCEL_CSRF_TOKEN: TOKEN, 'Shipment[track]': POSTS, track: 'track' });
    expect(new Headers(post.headers).get('cookie')).toBe('session=synthetic');
    expect(carrier(fetcher)).toMatchObject({ id: 'topparcel', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the form’s notice as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => html(init?.method === 'POST' ? page('not-found') : page('form')));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, refusals, error pages and redirects apart from a missing parcel', async () => {
    const answer = async (post: () => Response, form = () => html(page('form'))) => carrier(vi.fn<typeof fetch>()
      .mockImplementation(async (_url, init) => (init?.method === 'POST' ? post() : form())))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(page(POSTS)), () => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/parcels/tracking' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html(page(POSTS)), () => html(page('form').replace(/<input type="hidden"[^>]*>/, '')))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('<html><body><p>Maintenance</p></body></html>'))).toMatchObject({ kind: 'schema' });
  });
});

describe('Topparcel pages', () => {
  it('reads a parcel relayed from two posts: its rows on their wall clock, newest first, and where it went', () => {
    const result = parseTopparcel(page(POSTS), POSTS);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery, Delivery to the addressee', last_update: null, last_update_local: '2026-11-05T06:06:00',
      expected_delivery: null, destination_country: 'RU',
    });
    expect(result.events).toHaveLength(23);
    expect(result.events![0]).toEqual({ local_time: '2026-11-05T06:06:00', description: 'Delivery, Delivery to the addressee',
      location: '607612, Burevestnik, RU', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.find((event) => event.description === 'Customs clearance, Released by custom house'))
      .toMatchObject({ location: '102901, Moskva-Kazanskij Vkz. PZhDP MMPO Pi-30, RU', stage: 'customs', stage_source: 'wording:language' });
    expect(result.events!.slice(-4)).toEqual([
      { local_time: '2026-10-19T11:00:00', description: 'Acceptance', location: 'DEBERZ, Kyrgyzstan DEBERZ, KG', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-10-19T09:25:00', description: 'In transit EU', location: 'IT', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-10-14T16:15:00', description: 'Collected', location: 'IT', stage: 'accepted', stage_source: 'carrier_map' },
      { local_time: '2026-10-12T07:16:00', description: 'Accepted', location: 'IT', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    // The post office's address under the delivery and the parcel's weight stay behind.
    expect(JSON.stringify(result)).not.toMatch(/ready for pickup|Gagarina|kg"/);
  });

  it('merges Topparcel’s own rows with FedEx’s by their clocks, and reads FedEx’s wording by the shared rules', () => {
    const result = parseTopparcel(page(FEDEX), FEDEX);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-06-29T16:27:00', destination_country: 'IT' });
    expect(result.events!.map((event) => [event.local_time!.slice(5, 16), event.description, event.stage])).toEqual([
      ['06-29T16:27', 'Delivered', 'delivered'],
      ['06-29T09:19', 'On FedEx vehicle for delivery', 'out_for_delivery'],
      ['06-29T08:20', 'At local FedEx facility', 'in_transit'],
      ['06-29T04:46', 'Departed FedEx hub', 'in_transit'],
      ['06-28T21:27', 'On the way', 'in_transit'],
      ['06-26T22:36', 'Arrived at FedEx hub', 'in_transit'],
      ['06-26T17:48', 'In transit EU', 'in_transit'],
      ['06-26T10:05', 'Departed FedEx hub', 'in_transit'],
      ['06-26T09:46', 'On the way', 'in_transit'],
      ['06-26T00:01', 'Arrived at FedEx hub', 'in_transit'],
      ['06-25T17:46', 'Collected', 'accepted'],
      ['06-25T13:32', 'Picked up', 'accepted'],
      ['06-23T17:40', 'Accepted', 'registered'],
      ['06-23T11:40', 'Shipment information sent to FedEx', 'registered'],
    ]);
  });

  it('answers only for the number asked', () => {
    expect(() => parseTopparcel(page(FEDEX), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseTopparcel(parcel(), OTHER)).toMatchObject({ current_stage: 'delivered' });
  });

  it('keeps the stage of the row before a notice, and leaves unknown wording to the rows before it', () => {
    const slot = 'Отказ от бронирования интервала доставки, Техническая причина';
    expect(parseTopparcel(parcel({ rows: [row('01.07.2026 09:00', 'IT', '', 'Accepted'), row('03.07.2026 10:00', 'RU', '190000, Example', 'Unsuccessful delivery attempt, Addressee requested late delivery'),
      row('03.07.2026 10:05', 'RU', '190000, Example', slot)] }), OTHER))
      .toMatchObject({ current_stage: 'failed_attempt', last_status_text: slot, events: [{ description: slot }, { stage: 'failed_attempt' }, { stage: 'registered' }] });
    const unknown = parseTopparcel(parcel({ rows: [row('01.07.2026 09:00', 'IT', '', 'Collected'), row('02.07.2026 09:00', '', '', 'Example status')] }), OTHER);
    expect(unknown).toMatchObject({ current_stage: 'accepted', last_status_text: 'Example status' });
    expect(unknown.events![0]).toEqual({ local_time: '2026-07-02T09:00:00', description: 'Example status' });
  });

  it('answers a listed parcel without rows as having no history', () => {
    expect(() => parseTopparcel(parcel({ rows: [] }), OTHER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('refuses a changed page', () => {
    for (const changed of [parcel({ rows: [row('2026-07-01 09:00', 'IT', '', 'Accepted')] }), parcel({ rows: [row('31.02.2026 09:00', 'IT', '', 'Accepted')] }),
      parcel({ rows: [row('01.07.2026 09:00', 'Italy', '', 'Accepted')] }), parcel({ rows: [row('01.07.2026 09:00', 'IT', '')] }),
      parcel({ rows: [row('01.07.2026 09:00', 'IT', '', 'Accepted').replace('</td></tr>', '</td><td></td></tr>')] }),
      parcel().replace(/<dt[^>]*>Tracking #<\/dt>/, '<dt>Reference</dt>')]) {
      expect(() => parseTopparcel(changed, OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Topparcel statuses', () => {
  it('maps each wording it records, and leaves its notices without a stage', () => {
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(stage);
      expect(topparcelStage(entry.wording)?.stage, entry.wording).toBe(stage);
      expect(statusMapAnswer({ carrier: 'topparcel', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: entry.note });
    }
    expect(statusMap.stage(null, 'example status')).toBeUndefined();
  });
});
