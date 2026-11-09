import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { normalizeWesternBidNumber, parseWesternBid, validateWesternBidUrl, westernBidTrackingUrl } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'WBX731594268109', OTHER = 'WBX827351946108', ALIAS = '9411731594268109371526';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const parse = (html = fixture(), number = NUMBER) => parseWesternBid(html, number, westernBidTrackingUrl(number));
const edit = (change: (page: ReturnType<typeof load>) => void) => { const $ = load(fixture()); change($); return $.html(); };

describe('Western Bid public milestone parser', () => {
  it('binds its own whole WBX identity and retains dated reached milestones', () => {
    const result = parse();
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2031-04-22T15:46:00', history_truncated: true, expected_delivery: null });
    expect(result.events).toEqual([
      { local_time: '2031-04-22T15:46:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2031-04-21T12:30:00', description: 'Departed WB Facility, Invented Hub, ZZ', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2031-04-20T00:15:00', description: 'Arrived at WB Facility, Invented Hub, ZZ', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2031-04-19T11:20:00', description: 'Label Created', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(result.canonical_tracking_number).toBeUndefined();
  });

  it('accepts only an explicitly listed whole alias and returns its own-label identity', () => {
    expect(parse(fixture(), ALIAS)).toMatchObject({ canonical_tracking_number: NUMBER, current_stage: 'delivered' });
    expect(() => parse(fixture(), ALIAS + '4')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(fixture(), ALIAS.slice(0, -1))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const html = edit($ => { $('.w-block').contents().first().replaceWith(ALIAS + ' '.repeat(70) + OTHER); });
    expect(() => parse(html, ALIAS)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('binds a validated complete USPS routing barcode to its package, without suffix guessing', () => {
    const first = '941100000000000000001';
    const check = (10 - [...first].reverse().reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 3 : 1), 0) % 10) % 10;
    const pic = first + check;
    const page = edit($ => { $('.w-block').first().text('42000000' + pic); });
    expect(parse(page, pic).canonical_tracking_number).toBe(NUMBER);
    expect(() => parse(page, pic.slice(0, -1) + ((check + 1) % 10))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(page, pic.slice(1))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not bind another parcel, truncated canonical text or an unverified own-label format', () => {
    expect(() => parse(fixture(), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const value of [NUMBER + ' '.repeat(70) + OTHER, ALIAS]) {
      expect(() => parse(edit($ => { $('.tracker-field_shiping-number > div').first().find('p').text(value); })))
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('does not choose one of several shipments or conflicting positive and form views', () => {
    expect(() => parse(fixture() + fixture())).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(fixture() + fixture('not-found'))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('drops recipient, address, capability, scripts and alias carrier labels from history', () => {
    const text = JSON.stringify(parse());
    for (const marker of [NUMBER, ALIAS, 'Synthetic Recipient', 'Invented Street', 'Private Postcode', 'SYNTHETIC-', 'carrier.invalid', 'USPS', 'View Details']) expect(text).not.toContain(marker);
    expect(parse().events!.every(event => event.time === undefined && event.time_zone === undefined)).toBe(true);
  });

  it('ignores future and undated rail entries and requires actual dated history', () => {
    const html = edit($ => { $('.MuiStep-root p').slice(0, 5).each((_, node) => { $(node).children('br').nextAll().remove(); $(node).children('br').remove(); $(node).text('On the Way'); }); });
    expect(() => parse(html)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parse().events!.some(event => event.description === 'On the Way' || event.local_time!.startsWith('2035'))).toBe(false);
  });

  it('deduplicates identical scans and retains unknown reached wording', () => {
    const html = edit($ => { const row = $('.MuiStep-root').first(); row.after(row.clone()); $('.MuiStep-root').eq(4).find('p').html('Inventory checkpoint<br>04/21/2031 8:00 PM'); });
    const result = parse(html);
    expect(result.events).toHaveLength(5);
    expect(result.events!.find(event => event.description === 'Inventory checkpoint')).toEqual({ local_time: '2031-04-21T20:00:00', description: 'Inventory checkpoint' });
  });

  it.each(['02/29/2031 3:46 PM', '04/22/2031 13:46 PM', '04/22/2031 0:46 AM', '04/22/2031 3:60 PM', '04/22/31 3:46 PM', '2031-04-22T15:46:00Z'])('rejects an invalid or changed milestone clock: %s', text => {
    expect(() => parse(fixture().replace('04/22/2031 3:46 PM', text))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not silently truncate changed milestone layouts or excessive rows', () => {
    expect(() => parse(fixture().replace('Delivered<br>04/22/2031 3:46 PM', 'Delivered<br><b>04/22/2031 3:46 PM</b>')))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const html = edit($ => { const row = $('.MuiStep-root').first().toString(); $('.MuiStepper-root').append(row.repeat(500)); });
    expect(() => parse(html)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts only the bound exact negative, never a verification refusal or partial form', () => {
    expect(() => parse(fixture('not-found'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(fixture('not-found').replace(NUMBER, OTHER))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const $ = load(fixture('not-found')); $('.w-form-fail').text('Invalid reCAPTCHA token');
    expect(() => parse($.html())).toThrow(expect.objectContaining({ kind: 'challenge' }));
    $('.w-form-fail').text('Error!');
    expect(() => parse($.html())).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    $('.w-form-fail').remove();
    expect(() => parse($.html())).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps protection and changed schema separate from missing parcels', () => {
    expect(() => parse('<title>Just a moment...</title>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parse('<body>We did not find a parcel with this number.</body>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(' '.repeat(1_000_001))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([
    'https://other.invalid/?trackNumber=' + NUMBER,
    westernBidTrackingUrl(NUMBER) + '&token=SYNTHETIC-CAPABILITY',
    westernBidTrackingUrl(NUMBER) + '&trackNumber=' + NUMBER,
    westernBidTrackingUrl(OTHER),
  ])('rejects foreign or ambiguous result addresses', url => {
    expect(() => validateWesternBidUrl(url, NUMBER)).toThrow();
  });

  it.each(['ABCD', '1', 'A'.repeat(70), 'https://carrier.invalid/42'])('rejects malformed input before retrieval', raw => {
    expect(() => normalizeWesternBidNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('maps declared observed status wording consistently', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording)).toBe(entry.stage);
  });
});
