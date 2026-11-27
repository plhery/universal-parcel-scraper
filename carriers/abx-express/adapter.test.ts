import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { AbxTracker, ABX_SEARCH, ABX_TRACK, adapter } from './adapter.js';
import { normalizeAbxNumber, parseAbx, parseAbxForm } from './parser.js';
import { abxStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// The public sample, delivered, and an invented number far from its range.
const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'CNMYA990417263';
const TOKEN = 'CfDJ8SyntheticTrackingFormToken_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbb';
const ANTIFORGERY = '.AspNetCore.Antiforgery.Synthetic01';
// After the sample's delivery, so every row dates on Malaysia's clock.
const READ_AT = Date.parse('2026-11-27T12:00:00Z');

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (name: string, from: string | RegExp, to: string) => {
  const html = fixture(name);
  const next = html.replace(from, to);
  if (next === html) throw new Error(`The page has no ${String(from)}`);
  return next;
};
const page = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const form = (cookies = ['acw_tc=synthetic0balancer;path=/;HttpOnly;Max-Age=1800',
  `${ANTIFORGERY}=syntheticCookie_1; path=/; samesite=strict; httponly`, 'other=ignored; path=/']) =>
  new Response(fixture('form'), { headers: [['Content-Type', 'text/html; charset=utf-8'],
    ...cookies.map((cookie) => ['Set-Cookie', cookie] as [string, string])] });
/** A transport that serves the tracking page, then `post` for the form. */
const site = (post: () => Response = () => page(fixture('delivered')), first = form) =>
  vi.fn<typeof fetch>().mockImplementation(async (_url, init) => (init?.method === 'POST' ? post() : first()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const parsed = (html: string, number = NUMBER) => parseAbx(html, number, READ_AT);

describe('ABX Express HTTP adapter', () => {
  it('opens a session on the tracking page and posts the number with its token, the cookies and the slider field', async () => {
    const fetcher = site();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AbxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[searchUrl, searchInit], [postUrl, postInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(searchUrl).toBe('https://www.abxexpress.com.my/tracking');
    expect(searchInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(searchInit.headers).has('Cookie')).toBe(false);
    expect(postUrl).toBe('https://www.abxexpress.com.my/Home/Track');
    expect(postInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      body: `ConsignmentNo=${NUMBER}&Captcha=doneverify&__RequestVerificationToken=${TOKEN}` });
    expect(postInit.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0',
      Cookie: `acw_tc=synthetic0balancer; ${ANTIFORGERY}=syntheticCookie_1`, Origin: 'https://www.abxexpress.com.my', Referer: ABX_SEARCH });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'abx-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the history newest first, each row on Malaysia\'s clock, with the current status above it', () => {
    const result = parsed(fixture('delivered'));
    expect(result.events).toEqual([
      { time: '2026-06-09T16:47:00+08:00', time_zone: 'Asia/Kuala_Lumpur', time_zone_basis: 'carrier', local_time: '2026-06-09T16:47:00',
        location: 'Selangor', description: 'Delivery Completed', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-06-08T01:34:00+08:00', time_zone: 'Asia/Kuala_Lumpur', time_zone_basis: 'carrier', local_time: '2026-06-08T01:34:00',
        location: 'PAH - Selangor', description: 'Parcel Departed', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-06-08T00:44:00+08:00', time_zone: 'Asia/Kuala_Lumpur', time_zone_basis: 'carrier', local_time: '2026-06-08T00:44:00',
        location: 'PAH - Selangor', description: 'Parcel Has Been Collected', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Completed', last_update: '2026-06-09T16:47:00+08:00', last_update_local: '2026-06-09T16:47:00',
      expected_delivery: null });
  });

  it('drops the delivery photos and the phone numbers the page hides behind them', () => {
    const photo = `data:image/jpeg;base64,${'/9j/4AAQSkZJRgABAQAAAQABAAD'.repeat(40_000)}`;
    const html = changed('delivered', /data:image\/png;base64,/g, photo)
      .replace("openBase64Image('')", `openBase64Image('${photo.slice(23)}')`)
      .replace('<a href="#verificationModal"', '<input type="hidden" id="RphoneNo" value="60123456789" />\n<a href="#verificationModal"');
    expect(html.length).toBeGreaterThan(3_000_000);
    const result = parsed(html);
    expect(result).toEqual(parsed(fixture('delivered')));
    expect(JSON.stringify(result)).not.toMatch(/base64|60123456789|epod/);
  });

  it('reads the no-record row as not found, bound to the number the page shows', async () => {
    expect(() => parsed(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsed(fixture('not-found'), 'CNMYA990417264')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(site(() => page(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(site(() => page(fixture('not-found')))).recognize!(UNKNOWN)).resolves.toMatchObject({ known: false });
  });

  it('refuses a result for another number, several shipments or a history it cannot read', () => {
    expect(() => parsed(changed('delivered', `hilight">${NUMBER}<`, 'hilight">CNMYA007956563<')))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = changed('delivered', /(<div class="row no-gutters">\s*<div class="col-md-3">Shipment No:<\/div>[\s\S]*?<\/div>\s*<\/div>)/, '$1$1');
    expect(() => parsed(twice)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsed(changed('delivered', '<span>08/06/2026</span>', '<span>31/06/2026</span>'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsed(changed('delivered', '>16:47<', '>4:47 PM<'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsed(changed('delivered', '<div class="info">Parcel Departed</div>', '<div class="info"></div>')))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsed(changed('delivered', '<div class="info">Parcel Departed</div>', '<div class="info">No record available</div>')))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsed(changed('delivered', /<ul id="first-list">[\s\S]*<\/ul>/, ''))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsed(changed('delivered', /Shipment No:/, 'Shipment:'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsed(fixture('form'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsed('<html><head><title>Just a moment...</title></head></html>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parsed('<html><script>var arg1="x";document.cookie="acw_sc__v2="+x</script></html>'))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps a row its clock would date after the lookup on its wall clock alone', () => {
    const result = parseAbx(fixture('delivered'), NUMBER, Date.parse('2026-06-09T08:00:00Z'));
    expect(result.events![0]).toEqual({ local_time: '2026-06-09T16:47:00', location: 'Selangor', description: 'Delivery Completed',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-06-09T16:47:00' });
    expect(result.events![1]).toMatchObject({ time: '2026-06-08T01:34:00+08:00' });
  });

  it('takes the stage from the scans when the current status has no known wording', () => {
    const result = parsed(changed('delivered', /(Current Status:<\/div>\s*<div class="col-md-9 hilight">)Delivery Completed/, '$1Status Baru'));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Status Baru' });
    const bare = changed('delivered', /<div class="row no-gutters">\s*<div class="col-md-3">Current Status:[\s\S]*?<\/div>\s*<\/div>/, '');
    expect(parsed(bare)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivery Completed' });
  });

  it('reads the tracking form and refuses a changed one or a missing session', async () => {
    expect(parseAbxForm(fixture('form'))).toBe(TOKEN);
    expect(() => parseAbxForm(changed('form', 'name="ConsignmentNo"', 'name="Number"'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAbxForm(changed('form', TOKEN, 'short'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAbxForm('<div class="cf-turnstile"></div>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const fetcher = site(undefined, () => form(['acw_tc=synthetic0balancer;path=/']));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The balancer's cookie is optional.
    const bare = site(undefined, () => form([`${ANTIFORGERY}=syntheticCookie_1; path=/`]));
    await expect(carrier(bare).track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    expect((bare.mock.calls[1]![1]!.headers as Record<string, string>).Cookie).toBe(`${ANTIFORGERY}=syntheticCookie_1`);
  });

  it('keeps refusals, rate limits and outages apart from a missing number', async () => {
    await expect(carrier(site(() => page('', { status: 400 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(site(undefined, () => page('<title>Just a moment...</title>', { status: 403 }))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge', status: 403 });
    await expect(carrier(site(() => page('', { status: 403 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(site(() => page('', { status: 429 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(site(() => page('', { status: 404 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(() => new Response(null, { status: 302, headers: { Location: '/Home/Error' } }))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(undefined, () => page('', { status: 404 }))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(site(() => page('<html>changed</html>'))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('retries once in a new session when the site cannot be reached', async () => {
    let failed = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (!failed) {
        failed = true;
        throw new TypeError('fetch failed');
      }
      return init?.method === 'POST' ? page(fixture('delivered')) : form();
    });
    await expect(carrier(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([ABX_SEARCH, ABX_SEARCH, ABX_TRACK]);
  });

  it('recognizes a number the tracker holds and refuses other input before any request', async () => {
    await expect(carrier(site()).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    const fetcher = site();
    for (const bad of ['ABX12', `${NUMBER},${UNKNOWN}`, 'ABCDEFGHIJ', 'AB1'.repeat(11), '9'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number: bad })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAbxNumber('cnmya 007-956-562')).toBe(NUMBER);
  });

  it('leaves the sample shapes to an explicit choice', () => {
    for (const record of numbers.records) expect(detectCarrierMatch(record.number).candidates).not.toContain('abx-express');
  });

  it('maps every recorded wording', () => {
    for (const entry of statuses.entries) {
      expect(abxStage(entry.wording)?.stage).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'abx-express', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage(null, normalizeStatusWording('Status Baru'))).toBeUndefined();
  });
});
