import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { classifyWording } from '../../core/status/wording.js';
import { MAX_BYTES, normalizeSkladusaNumber, parseSkladusaTrackingHtml, skladusaTrackingUrl } from './parser.js';
import { projectSkladusaStatus, statusMap } from './status.js';

const NUMBER = 'SK1000000017UA';
const URL = 'https://skladusa.com/en/tracking/sk1000000017ua/';
const fixture = () => readFileSync(new globalThis.URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const empty = () => readFileSync(new globalThis.URL('./fixtures/empty.html', import.meta.url), 'utf8');
type Document = ReturnType<typeof load>;
const rows = ($: Document) => $('table tr').filter((_, row) => $(row).children('td').length === 3);

function syncMobile($: Document): void {
  const template = $('.search-mobile__item').first().clone(), list = $('.search-mobile__items');
  list.empty();
  rows($).each((_, row) => {
    const cells = $(row).children('td'), item = template.clone();
    item.find('.search-mobile__date').text(cells.eq(0).text().trim());
    item.find('.search-mobile__status span').text(cells.eq(1).children('span').text().trim());
    item.find('.search-mobile__txt').text(cells.eq(2).text().trim()); list.append(item);
  });
}

const mutate = (change: (document: Document) => void, responsive = false) => {
  const $ = load(fixture()); change($); if (responsive) syncMobile($); return $.html();
};

describe('SkladUSA scoped guest history parser', () => {
  it('validates both whole views but emits the twenty rows only once, without private fields or codes', () => {
    const result = parseSkladusaTrackingHtml(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-07-16T11:00', expected_delivery: null,
      history_truncated: true });
    expect(result.events).toHaveLength(20);
    expect(result.events!.filter(event => event.stage === 'registered')).toHaveLength(2);
    expect(result.events!.filter(event => event.stage === 'in_transit')).toHaveLength(14);
    expect(result.events!.filter(event => event.stage === 'out_for_delivery')).toHaveLength(2);
    expect(result.events!.filter(event => event.stage === 'delivered')).toHaveLength(1);
    expect(result.events!.every(event => !event.time && !event.time_zone && !event.time_zone_basis && !event.location
      && !event.provider_code)).toBe(true);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-07-01T08:00', description: 'Waybill created', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|SIGNATURE|recipient|example\.invalid|SK1000000017UA|https?:|UPS|17\.07/);
    for (const field of ['delivery_carrier', 'delivery_tracking_number', 'canonical_tracking_number', 'receiver_name',
      'timezone', 'delivered_at', 'destination_country', 'provider_code']) expect(result).not.toHaveProperty(field);
  });

  it('accepts the complete Ukrainian layout only with its matching final route and canonical identity', () => {
    const url = URL.replace('/en/tracking/', '/tracking/');
    const localize = (html: string) => html.replaceAll('/en/tracking/', '/tracking/').replace('Search result:', 'Результат пошуку:')
      .replace('<th>Data</th>', '<th>Дата</th>').replace('<th>Status</th>', '<th>Статус</th>')
      .replace('<th>More details</th>', '<th>Детальніше</th>').replace('No tracking info yet', 'Ще немає інформації про відстеження');
    expect(parseSkladusaTrackingHtml(localize(fixture()), NUMBER, url)).toEqual(parseSkladusaTrackingHtml(fixture(), NUMBER));
    expect(() => parseSkladusaTrackingHtml(localize(empty()), NUMBER, url))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'expired_or_unknown' }));
    for (const [html, route] of [[localize(fixture()), URL], [fixture(), url],
      [localize(fixture()).replace('<th>Дата</th>', '<th>Data</th>'), url],
      [localize(fixture()), url.replace('1000000017', '1000000018')],
      [localize(fixture()), url.slice(0, -1)], [localize(fixture()), url + '?key=SYNTHETIC']]) {
      expect(() => parseSkladusaTrackingHtml(html!, NUMBER, route)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('uses the shared whole-reference gate and canonical lowercase URL', () => {
    expect(normalizeSkladusaNumber(' sk1000-000017ua ')).toBe(NUMBER);
    expect(skladusaTrackingUrl('SK1000 000017UA')).toBe(URL);
    for (const value of ['SK10000000170UA', 'SK100000017UA', '1000000017', 'SK1000000017PL', '../' + NUMBER,
      NUMBER + NUMBER, ' '.repeat(65) + NUMBER]) {
      expect(() => normalizeSkladusaNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('requires agreement from every present canonical or page URL without including it in diagnostics', () => {
    for (const html of [
      mutate($ => { $('link[rel=canonical]').attr('href', URL.replace('sk1000000017ua', 'sk1000000018ua')); }),
      mutate($ => { $('[data-pageurl]').attr('data-pageurl', '/en/tracking/sk1000000018ua/'); }),
      mutate($ => { $('link[rel=canonical]').attr('href', URL + '?token=SYNTHETIC'); }),
      mutate($ => { $('link[rel=canonical]').attr('href', URL + '#SYNTHETIC'); }),
      mutate($ => { $('link[rel=canonical]').attr('href', URL.replace('skladusa.com', 'skladusa.com.example.invalid')); }),
      mutate($ => { $('link[rel=canonical]').attr('href', '/en/tracking/sk1000000017ua/'); }),
      mutate($ => { $('head').append($('link[rel=canonical]').clone()); }),
      mutate($ => { $('body').append('<div data-pageurl="/en/tracking/sk1000000017ua/"></div>'); }),
    ]) {
      try { parseSkladusaTrackingHtml(html, NUMBER); throw new Error('Expected schema failure'); }
      catch (error) {
        expect(error).toMatchObject({ kind: 'schema' });
        expect((error as Error).message).not.toMatch(/100000001|SYNTHETIC|https?:/);
      }
    }
    const absolutePageUrl = mutate($ => { $('[data-pageurl]').attr('data-pageurl', URL); });
    expect(parseSkladusaTrackingHtml(absolutePageUrl, NUMBER).current_stage).toBe('delivered');
    const withoutMetadata = mutate($ => { $('link[rel=canonical]').remove(); $('[data-pageurl]').removeAttr('data-pageurl'); });
    expect(() => parseSkladusaTrackingHtml(withoutMetadata, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const withoutCanonical = mutate($ => { $('link[rel=canonical]').remove(); });
    expect(() => parseSkladusaTrackingHtml(withoutCanonical, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires exact, unique desktop and mobile whole identities in one visible result', () => {
    for (const html of [
      mutate($ => { $('.search-table h1 span').text('SK1000000018UA'); }),
      mutate($ => { $('.search-mobile h1 span').text(NUMBER + ' SK1000000018UA'); }),
      mutate($ => { $('.search-table h1 span').text('SK1000-000017UA'); }),
      mutate($ => { $('.search-table h1').prepend('OTHER '); }),
      mutate($ => { $('.search-mobile h1').remove(); }),
      mutate($ => { $('.tracking-result').append($('.search-table').clone()); }),
      mutate($ => { $('body').append($('.tracking-result').clone()); }),
      mutate($ => { $('body').append('<h1>Search result: ' + NUMBER + '</h1>'); }),
      mutate($ => { $('.tracking-result').attr('hidden', ''); }),
      mutate($ => { $('.search-mobile').attr('style', 'DISPLAY : NONE !important'); }),
      mutate($ => { $('.search-table h1 span').attr('aria-hidden', 'true'); }),
      mutate($ => { $('.search-table h1').append('<span hidden>' + NUMBER + '</span>'); }),
    ]) expect(() => parseSkladusaTrackingHtml(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not accept conditional headings without their labelled table and consistent responsive rows', () => {
    for (const html of [
      mutate($ => { $('table').remove(); }),
      mutate($ => { $('table th').first().text('Date'); }),
      mutate($ => { $('.search-table').append($('table').clone()); }),
      mutate($ => { $('.search-mobile__item').first().remove(); }),
      mutate($ => { $('.search-mobile__date').first().text('16.07.2026 12:00'); }),
      mutate($ => { $('.search-mobile__status span').first().text('Different shipment history'); }),
      mutate($ => { $('.search-mobile__txt').first().text('OTHER SYNTHETIC FACILITY'); }),
    ]) expect(() => parseSkladusaTrackingHtml(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const noRows = mutate($ => { rows($).remove(); $('.search-mobile__items').empty(); });
    expect(() => parseSkladusaTrackingHtml(noRows, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'expired_or_unknown' }));
  });

  it('keeps the exact empty notice indeterminate and rejects mixed, hidden or malformed variants', () => {
    expect(() => parseSkladusaTrackingHtml(empty(), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError',
      kind: 'indeterminate', reason: 'expired_or_unknown' }));
    for (const html of [empty().replace('No tracking info yet', 'SYNTHETIC service error'),
      empty().replace('class="help-block not-found"', 'class="help-block not-found" hidden'),
      empty().replace('class="help-block not-found"', 'class="help-block not-found" style="display : none"'),
      fixture().replace('</main>', '<div class="help-block not-found">No tracking info yet</div></main>'),
      '<h1>Search result: ' + NUMBER + '</h1>', '<html><title>Route unavailable</title></html>']) {
      expect(() => parseSkladusaTrackingHtml(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('maps preparation separately from custody and projects location tails through safe labels', () => {
    expect(projectSkladusaStatus('Waybill has been created')).toMatchObject({ stage: 'registered' });
    expect(projectSkladusaStatus('Parcel is ready to depart the Kyiv facility')).toMatchObject({ stage: 'registered' });
    expect(projectSkladusaStatus('Processing at UPS Facility')).toMatchObject({ description: 'Processing at carrier facility', stage: 'in_transit' });
    for (const text of ['In transit SYNTHVILLE United States', 'Arrived at SYNTHHUB United States',
      'In transit SYNTHVILLE, 99017 United States', 'Arrived at SYNTHHUB, 99017 United States',
      'Parcel is in transit to Poland for air export']) {
      const status = projectSkladusaStatus(text);
      expect(status).toMatchObject({ stage: 'in_transit', partial: true });
      expect(status.description).not.toMatch(/SYNTH|Poland|States|99017/);
    }
    expect(statusMap.stage(null, 'waybill created')).toBe('registered');
    expect(statusMap.stage(null, 'preparing to depart origin facility')).toBe('registered');
    expect(statusMap.stage(null, 'out for delivery')).toBe('out_for_delivery');
    expect(statusMap.stage('SYNTHETIC_CODE', 'delivered')).toBeUndefined();
  });

  it('reads status wording independently of decorative SVG text', () => {
    const html = mutate($ => { $('.status-no-info svg').append('<title>SYNTHETIC PERSON recipient@example.invalid</title>'); });
    const result = parseSkladusaTrackingHtml(html, NUMBER);
    expect(result.events).toHaveLength(20); expect(result.current_stage).toBe('delivered');
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|recipient|example\.invalid/);
  });

  it.each(['Delivered to SYNTHETIC PERSON, signed recipient@example.invalid', 'In transit recipient SYNTHETIC PERSON',
    'SYNTHETIC PRIVATE STATUS', 'Parcel is on an unverified future flight'])(
    'keeps arbitrary prose generic and partial: %s', text => {
      const result = parseSkladusaTrackingHtml(mutate($ => { rows($).first().children('td').eq(1).children('span').text(text); }, true), NUMBER);
      expect(result).toMatchObject({ status: 'unknown', history_truncated: true, last_status_text: 'Tracking update' });
      expect(result.events![0]).toEqual({ local_time: '2026-07-16T11:00', description: 'Tracking update' });
      expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|recipient|signed|PRIVATE|flight|provider_code/);
    });

  it('requires last-mile evidence from the current leg before terminal delivery', () => {
    const withoutDispatch = mutate($ => {
      rows($).slice(1, 3).each((_, row) => { $(row).children('td').eq(1).children('span').text('Arrived at Facility'); });
    }, true);
    const differentLeg = mutate($ => {
      const row = rows($).first().clone(); row.children('td').eq(0).text('16.07.2026 10:00');
      row.children('td').eq(1).children('span').text('Departed from Facility'); rows($).first().after(row);
    }, true);
    for (const html of [withoutDispatch, differentLeg]) {
      const result = parseSkladusaTrackingHtml(html, NUMBER);
      expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined();
      expect(result.events![0]).toEqual({ local_time: '2026-07-16T11:00', description: 'Tracking update' });
      expect(result.events!.some(event => event.stage === 'delivered' || event.provider_code)).toBe(false);
      expect(statusMap.stage(null, result.events![0]!.description!)).toBeUndefined();
      expect(classifyWording(result.events![0]!.description!).stage).not.toBe('delivered');
    }
  });

  it('does not let an earlier warehouse-like delivery complete later onward movement', () => {
    const html = mutate($ => {
      const row = rows($).first().clone(); row.children('td').eq(0).text('17.07.2026 12:00');
      row.children('td').eq(1).children('span').text('Departed from Facility'); rows($).first().before(row);
    }, true);
    const result = parseSkladusaTrackingHtml(html, NUMBER);
    expect(result).toMatchObject({ current_stage: 'in_transit', status: 'in_transit', history_truncated: true });
    expect(result.events!.some(event => event.stage === 'delivered' || /delivered/i.test(event.description!))).toBe(false);
  });

  it('keeps newest-first source order and last-mile evidence when international wall clocks run backward', () => {
    const html = mutate($ => { rows($).first().children('td').eq(0).text('16.07.2026 00:30'); }, true);
    const result = parseSkladusaTrackingHtml(html, NUMBER);
    expect(result.current_stage).toBe('delivered'); expect(result.last_update_local).toBe('2026-07-16T00:30');
    expect(result.events!.slice(0, 3).map(event => event.local_time))
      .toEqual(['2026-07-16T00:30', '2026-07-16T09:00', '2026-07-16T08:00']);
    expect(result.events!.every(event => !event.time && !event.time_zone)).toBe(true);
  });

  it.each(['31.02.2026 11:00', '16.13.2026 11:00', '16.07.2026 24:00', '16.07.2026 11:60',
    '16.07.26 11:00', '16.07.2026 11:00:00', '16.07.2026 11:00 +02:00', '16.07.2026', '16.07.1999 11:00'])(
    'rejects changed precision or an invalid calendar clock: %s', date => {
      const html = mutate($ => { rows($).first().children('td').eq(0).text(date); }, true);
      expect(() => parseSkladusaTrackingHtml(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    });

  it('deduplicates complete validated views before its output cap', () => {
    const html = mutate($ => { rows($).first().after(rows($).first().clone().toString().repeat(102)); }, true);
    const result = parseSkladusaTrackingHtml(html, NUMBER);
    expect(result.events).toHaveLength(20); expect(result.current_stage).toBe('delivered');
    const redacted = mutate($ => {
      const selected = rows($).slice(-2); selected.each((index, row) => {
        $(row).children('td').eq(0).text('01.07.2026 08:00');
        $(row).children('td').eq(1).children('span').text('SYNTHETIC PRIVATE PERSON ' + index);
      });
    }, true);
    expect(parseSkladusaTrackingHtml(redacted, NUMBER).events).toHaveLength(19);
  });

  it('validates old rows outside the output cap and bounds source rows and decoded bytes', () => {
    const html = mutate($ => {
      const row = rows($).last().clone(), body = $('table tbody').last(); rows($).remove();
      for (let index = 109; index >= 0; index--) {
        const item = row.clone(); item.children('td').eq(0).text('01.07.2026 '
          + String(Math.floor(index / 60)).padStart(2, '0') + ':' + String(index % 60).padStart(2, '0')); body.append(item);
      }
    }, true);
    const capped = parseSkladusaTrackingHtml(html, NUMBER);
    expect(capped.events).toHaveLength(100); expect(capped.history_truncated).toBe(true);
    expect(capped.last_update_local).toBe('2026-07-01T01:49');
    const $ = load(html); rows($).last().children('td').eq(0).text('bad old clock'); syncMobile($);
    expect(() => parseSkladusaTrackingHtml($.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const excessive = mutate($ => { rows($).first().after(rows($).first().clone().toString().repeat(481)); }, true);
    expect(() => parseSkladusaTrackingHtml(excessive, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const body of [' '.repeat(MAX_BYTES + 1), 'é'.repeat(MAX_BYTES / 2 + 1)]) {
      expect(() => parseSkladusaTrackingHtml(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects row corruption and soft verification before interpreting tracking or emptiness', () => {
    for (const html of [mutate($ => { rows($).last().children('td').last().remove(); }),
      mutate($ => { rows($).first().children('td').eq(1).append('SYNTHETIC extra prose'); }),
      mutate($ => { rows($).last().children('td').eq(2).text('x'.repeat(2001)); }, true),
      mutate($ => { rows($).last().find('span').text('x'.repeat(1001)); }, true)]) {
      expect(() => parseSkladusaTrackingHtml(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const gate of ['<title>Just a moment</title>', '<form id="challenge-form"></form>',
      '<div class="cf-turnstile"></div>', '<div class="g-recaptcha"></div>', '<p>Verify that you are human</p>']) {
      expect(() => parseSkladusaTrackingHtml(empty() + ' '.repeat(65_000) + gate, NUMBER))
        .toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });
});
