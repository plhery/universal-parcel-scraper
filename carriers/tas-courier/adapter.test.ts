import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TasCourierTracker } from './adapter.js';
import { normalizeTasNumber, parseTas, TAS_RESULT, TAS_SEARCH, tasQueryNumber } from './parser.js';
import { statusMap, tasStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'V-4027982';
const ASSIGNED = 'V-3975570';
const UNKNOWN = 'V-99999990';
const SESSION = 'PHPSESSID=syntheticsession00000000000000';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, status = 200, headers: [string, string][] = []) =>
  new Response(body, { status, headers: [['Content-Type', 'text/html; charset=utf-8'], ...headers] });
const searchPage = (cookies = [`${SESSION}; path=/; secure`]) =>
  html('<html><body><form name="listSearchVoucher"></form></body></html>', 200, cookies.map((cookie) => ['Set-Cookie', cookie]));
const SITE_PAGE = '<!DOCTYPE html><html lang="el"><head><title>https://www.tascourier.gr</title></head><body>404 Error Page not Found</body></html>';
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

/** TAS Courier's voucher search: the page opens a session, and the list answers each voucher from its fixture in it. */
function site(list: (voucher: string, cookie: string | undefined) => Response = (voucher, cookie) =>
  html(!cookie ? SITE_PAGE : voucher === DELIVERED ? text('delivered.html') : voucher === ASSIGNED ? text('assigned.html') : text('not-found.html')),
open: () => Response = () => searchPage()) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` === TAS_SEARCH) return open();
    const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie;
    return list(url.searchParams.get('r18p01')!, cookie);
  });
}

describe('TAS Courier tracking adapter', () => {
  it('opens the voucher search, then reads its list in the search’s session, through the supplied transport', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TasCourierTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' v 3975570 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(pageUrl).toBe(`${TAS_SEARCH}?pcode=SEARCHVOUCHER&r18p01=${ASSIGNED}`);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(url).toBe(`${TAS_RESULT}?add_event=1&r18p01=${ASSIGNED}&having=1`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual',
      headers: { Cookie: SESSION, 'X-Requested-With': 'XMLHttpRequest', Referer: pageUrl, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tas-courier', step: 'direct', outcome: 'ok' }));
  });

  it('reads a delivery newest first on Athens wall clocks, without the recipient or the person who delivered', () => {
    const result = parseTas(text('delivered.html'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Έγινε Παράδοση Στον Παραλήπτη', last_update: null, last_update_local: '2022-07-18T14:30:00', expected_delivery: null,
      events: [
        { local_time: '2022-07-18T14:30:00', description: 'Έγινε Παράδοση Στον Παραλήπτη', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2022-07-16T15:59:00', description: 'Έγινε Ανάθεση σε Οδηγό Αττικής', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2022-07-15T07:39:00', description: 'Εκκρεμεί Προς Παραλαβή', stage: 'registered', stage_source: 'carrier_map' },
      ] });
    expect(JSON.stringify(result)).not.toMatch(/ΠΑΡΑΛΗΠΤΗΣ|ΟΔΗΓΟΣ|\*{3}/);
  });

  it('reads a voucher assigned to a driver as in transit', () => {
    expect(parseTas(text('assigned.html'), ASSIGNED)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'Έγινε Ανάθεση σε Οδηγό Αττικής', last_update_local: '2022-04-06T08:06:00' });
  });

  it('names a filled delivery slot as unread and stands on the status when there is no history', () => {
    const slot = text('assigned.html').replace('title="Εκτιμώμενη ώρα παράδοσης αποστολής"><span></span>',
      'title="Εκτιμώμενη ώρα παράδοσης αποστολής"><span>09:00 - 11:00</span>');
    expect(parseTas(slot, ASSIGNED)).toMatchObject({ unread_estimates: ['estimatedDeliverySlot'] });
    const bare = text('assigned.html').replace(/<tr id="vchHistData3975570"[\s\S]*?<\/div>\s*<\/td><\/tr>/, '');
    expect(parseTas(bare, ASSIGNED)).toMatchObject({ current_stage: 'in_transit', summary_only: true, events: [] });
  });

  it('reads the empty list as inconclusive, never as not found', async () => {
    expect(() => parseTas(text('not-found.html'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    await expect(carrier(site()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });

  it('keeps a lost or refused session apart from a missing voucher', async () => {
    await expect(carrier(site(undefined, () => searchPage([]))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(carrier(site(() => html(SITE_PAGE))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
  });

  it('reads a bot check or a refusal as a challenge and an outage as maintenance', async () => {
    await expect(carrier(site(() => html(CHECK))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(undefined, () => html(CHECK, 403))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(() => html('', 403))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(() => html('', 503))).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'maintenance' });
    const error = await carrier(site(() => html('', 404))).track({ number: DELIVERED }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'transport' });
    expect(JSON.stringify(error)).not.toContain(SESSION);
  });

  it('rejects malformed replies', () => {
    expect(() => parseTas('<div>changed</div>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTas(text('delivered.html').replace(/>Voucher</g, '>Αριθμός<'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTas(text('delivered.html').replace('<span class="status date">18/07/2022</span>', '<span class="status date">31/02/2022</span>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTas(text('delivered.html').replace('<span class="status time">14:30</span>', '<span class="status time">24:30</span>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds the list to the whole voucher asked', () => {
    expect(() => parseTas(text('delivered.html'), 'V-4027983')).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'TAS Courier answered for another voucher' }));
    expect(() => parseTas(text('delivered.html'), 'V-402798')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses inputs that are not a TAS voucher before any request', async () => {
    expect(normalizeTasNumber('v-4027982')).toBe('V4027982');
    expect(tasQueryNumber('V4027982')).toBe(DELIVERED);
    const fetcher = site();
    for (const number of ['4027982', 'VV4027982', 'V-12345', 'V-12345678901', 'X-4027982']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is asked only when TAS Courier is chosen, and reads the tracker link', async () => {
    expect(recognitionAskedCarriers(DELIVERED)).not.toContain('tas-courier');
    expect(parseTrackingInput(`https://www.tascourier.gr/track?v=${DELIVERED}`)).toMatchObject({ carrier: 'tas-courier' });
    const tracker = createTracker({ fetcher: site(), providers: [], env: {} });
    await expect(tracker.track({ number: DELIVERED, carrier: 'tas-courier' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'tas-courier', source: 'tas-courier', result: { current_stage: 'delivered' } });
  });
});

type Entry = { wording: string; stage?: string };

describe('TAS Courier status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it', () => {
    for (const entry of statuses.entries as Entry[]) {
      if (!entry.stage) continue;
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(tasStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'tas-courier', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'tas-courier', description: 'Συνθετική κατάσταση' })).toEqual({ kind: 'unknown' });
  });
});
