import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { MAX_BYTES, normalizePostOneNumber, parsePostOneTrackingHtml, postOneTrackingUrl } from './parser.js';
import { postOneStage, statusMap as postOneStatusMap } from './status.js';

const NUMBER = 'R1000000017';
const PARTNER = '7030000000000001';
const fixture = () => readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const mutate = (change: (document: ReturnType<typeof load>) => void) => {
  const $ = load(fixture()); change($); return $.html();
};
const field = (document: ReturnType<typeof load>, key: string) => document('label')
  .filter((_, element) => document(element).text() === key).siblings('div');

describe('Post One own-item HTML parser', () => {
  it('binds the whole item, projects only verified logistics and keeps minute wall clocks', () => {
    const result = parsePostOneTrackingHtml(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-06-16T15:37', expected_delivery: null,
      delivery_carrier: 'slovak-parcel-service', delivery_tracking_number: PARTNER });
    expect(result.events).toHaveLength(6);
    expect(result.events!.map(event => [event.provider_code, event.description, event.stage])).toEqual([
      ['dld', 'Delivered', 'delivered'], ['ofd', 'Out for Delivery', 'out_for_delivery'],
      ['icn', "In Carrier's Network", 'in_transit'], ['ded', 'Departed to Destination', 'in_transit'],
      ['apo', 'Sorted at Hub', 'in_transit'], ['crd', 'Created', 'registered'],
    ]);
    expect(result.events!.map(event => event.local_time)).toEqual(['2026-06-16T15:37', '2026-06-16T08:52',
      '2026-06-15T11:06', '2026-06-13T17:48', '2026-06-13T10:25', '2026-06-12T08:14']);
    expect(result.events!.every(event => !event.time && !event.time_zone && !event.time_zone_basis && !event.location)).toBe(true);
    expect(result.history_truncated).toBe(true);
    expect(result).not.toHaveProperty('timezone'); expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('destination_country'); expect(result).not.toHaveProperty('receiver_name');
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|SIGNATURE|example\.invalid|https?:|17\/06/);
    expect(deliveryHandoff('post-one', NUMBER, result)).toEqual({ carrier: 'slovak-parcel-service', number: PARTNER, basis: 'partner' });
  });

  it('shares the issuer gate and normalizes only an admissible whole input', () => {
    expect(normalizePostOneNumber(' r100-000.0017 ')).toBe(NUMBER);
    expect(postOneTrackingUrl('r100 000 0017')).toBe('https://postone.eu/en/track?code=' + NUMBER);
    for (const value of ['R10000000170', 'R100000001', PARTNER, 'R1000000017/R1000000018', '../R1000000017', ' '.repeat(65) + NUMBER]) {
      expect(() => normalizePostOneNumber(value)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('requires exactly one visible whole own identity in the same result section', () => {
    for (const html of [
      fixture().replace(NUMBER, 'R1000000018'), fixture().replace(NUMBER, NUMBER + '0'),
      fixture().replace(NUMBER, NUMBER + ' R1000000018'), fixture().replace(NUMBER, 'R100-0000017'),
      mutate($ => { field($, 'item_number').parent().attr('hidden', ''); }),
      mutate($ => { field($, 'item_number').attr('hidden', ''); }),
      mutate($ => { field($, 'item_number').html('<span hidden>' + NUMBER + '</span>'); }),
      mutate($ => { field($, 'item_number').parent().append('<span>R1000000018</span>'); }),
      mutate($ => { $('.form-horizontal').append(field($, 'item_number').closest('.row').clone()); }),
      mutate($ => { $('body').append('<label>item_number</label><div>R1000000018</div>'); }),
      mutate($ => { $('.form-horizontal').removeClass('form-horizontal'); }),
      mutate($ => { $('body').append($('p.item').first().clone()); }),
    ]) expect(() => parsePostOneTrackingHtml(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostOneTrackingHtml('<input value="' + NUMBER + '">', NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses only reached, visible records and treats a bound empty history as parcel_found', () => {
    const future = mutate($ => {
      const row = $('p.item').last().closest('.row').clone();
      row.find('p').removeClass('is-done').html('<strong>main_status.dld</strong><br>31/12/2099 23:59');
      $('.col-md-4').append(row);
      const hidden = row.clone(); hidden.find('p').addClass('is-done'); hidden.attr('hidden', ''); $('.col-md-4').append(hidden);
    });
    expect(parsePostOneTrackingHtml(future, NUMBER).events).toHaveLength(6);
    for (const html of [mutate($ => { $('.col-md-4').empty(); }), mutate($ => { $('p.item').removeClass('is-done'); })]) {
      expect(() => parsePostOneTrackingHtml(html, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate', reason: 'parcel_found' }));
    }
  });

  it('keeps unknown status keys and arbitrary prose generic with partial coverage', () => {
    for (const status of ['main_status.new', 'Delivered to SYNTHETIC PERSON; recipient@example.invalid', 'main_status.dld R1000000018']) {
      const result = parsePostOneTrackingHtml(mutate($ => { $('p.item strong').last().text(status); }), NUMBER);
      expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Tracking update', history_truncated: true });
      expect(result.current_stage).toBeUndefined();
      expect(result.events![0]).toEqual({ local_time: '2026-06-16T15:37', description: 'Tracking update' });
      expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|PERSON|example\.invalid|R1000000018|main_status/);
    }
    const translated = mutate($ => { $('p.item strong').last().text('Delivered'); });
    expect(parsePostOneTrackingHtml(translated, NUMBER).current_stage).toBe('delivered');
    const unmapped = mutate($ => {
      $('p.item strong').last().text('main_status.new');
      $('p.item').last().closest('.row').find('img').attr('src', '/assets/images/tracking/new-format.svg');
    });
    expect(parsePostOneTrackingHtml(unmapped, NUMBER)).toMatchObject({ status: 'unknown', history_truncated: true });
    expect(postOneStage('crd', 'Delivered')).toBe('registered');
    expect(postOneStage('main_status.ofd', 'Tracking update')).toBe('out_for_delivery');
    expect(postOneStatusMap.stage(null, 'sorted at hub')).toBe('in_transit');
    expect(postOneStage('unknown', 'Delivered')).toBeUndefined();
  });

  it('preserves stated seconds without filling them in or assigning a zone', () => {
    const result = parsePostOneTrackingHtml(fixture().replace('16/06/2026 15:37', '16/06/2026 15:37:09'), NUMBER);
    expect(result.events![0]!.local_time).toBe('2026-06-16T15:37:09');
    expect(result.events![1]!.local_time).toBe('2026-06-16T08:52');
    expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
  });

  it.each(['31/02/2026 15:37', '16/13/2026 15:37', '16/06/2026 24:37', '16/06/2026 15:60',
    '16/06/2026 15:37:60', '16/06/26 15:37', '16/06/2026 15:37 +02:00', '16/06/2026 15:37 extra prose',
    '16/06/1999 15:37', '16/06/2026'])(
    'rejects a malformed or changed scan clock: %s', value => {
      expect(() => parsePostOneTrackingHtml(fixture().replace('16/06/2026 15:37', value), NUMBER))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    });

  it('deduplicates before limiting output and validates every source row', () => {
    const duplicates = mutate($ => { $('.col-md-4').append($('p.item').last().closest('.row').clone().toString().repeat(102)); });
    const result = parsePostOneTrackingHtml(duplicates, NUMBER);
    expect(result.events).toHaveLength(6); expect(result.history_truncated).toBe(true);
    const many = mutate($ => {
      const row = $('p.item').first().closest('.row').clone(); $('.col-md-4').empty();
      for (let index = 0; index < 105; index++) {
        const item = row.clone();
        item.find('p.item').html('<strong>main_status.crd</strong><br>12/06/2026 '
          + String(Math.floor(index / 60)).padStart(2, '0') + ':' + String(index % 60).padStart(2, '0'));
        $('.col-md-4').append(item);
      }
    });
    const capped = parsePostOneTrackingHtml(many, NUMBER);
    expect(capped.events).toHaveLength(100); expect(capped.history_truncated).toBe(true);
    expect(capped.last_update_local).toBe('2026-06-12T01:44');
    const $ = load(many); $('p.item').first().html('<strong>main_status.crd</strong><br>bad old clock');
    expect(() => parsePostOneTrackingHtml($.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const excessive = mutate($ => { $('.col-md-4').append($('p.item').first().closest('.row').toString().repeat(495)); });
    expect(() => parsePostOneTrackingHtml(excessive, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const html of [' '.repeat(MAX_BYTES + 1), 'é'.repeat(MAX_BYTES / 2 + 1)]) {
      expect(() => parsePostOneTrackingHtml(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects malformed reached rows and contradictory official markers', () => {
    for (const html of [
      mutate($ => { $('p.item').last().find('br').remove(); }),
      mutate($ => { $('p.item').last().find('strong').attr('hidden', ''); }),
      mutate($ => { $('p.item').last().append('<strong>main_status.crd</strong>'); }),
      mutate($ => { $('p.item').last().append('<span>SYNTHETIC SIGNATURE</span>'); }),
      mutate($ => { $('p.item').last().closest('.row').find('img').attr('src', '/assets/images/tracking/created.png'); }),
      mutate($ => { $('p.item').last().closest('.row').find('img').attr('src', 'https://example.invalid/delivered.png'); }),
      mutate($ => { $('p.item').last().parent().removeClass('col-sm-9'); }),
      mutate($ => { $('p.item strong').last().text('x'.repeat(1001)); }),
    ]) expect(() => parsePostOneTrackingHtml(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('detects soft challenge pages before interpreting a matching identity or empty history', () => {
    for (const gate of ['<title>Just a moment</title>', '<form id="challenge-form"></form>',
      '<div class="cf-turnstile"></div>', '<p>Verify that you are human</p>']) {
      expect(() => parsePostOneTrackingHtml(fixture() + ' '.repeat(65_000) + gate, NUMBER))
        .toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
  });
});

describe('Post One optional SPS handoff evidence', () => {
  it.each([
    ['other partner', ($: ReturnType<typeof load>) => { field($, 'partner').text('SYNTHETIC PARTNER'); }],
    ['wrong label', ($: ReturnType<typeof load>) => { field($, 'tracking_number').text('703-000-0000000002'); }],
    ['shortened label', ($: ReturnType<typeof load>) => { field($, 'tracking_number').text('00000000001'); }],
    ['extra identity', ($: ReturnType<typeof load>) => { field($, 'tracking_number').append(' 7030000000000002'); }],
    ['wrong whole query', ($: ReturnType<typeof load>) => { field($, 'tracking_link').find('a').attr('href', 'https://www.sps-sro.sk/sledovanie-zasielky/?shipment_id=7030000000000002'); }],
    ['duplicate whole query', ($: ReturnType<typeof load>) => { const link = field($, 'tracking_link').find('a'); link.attr('href', link.attr('href') + '&shipment_id=' + PARTNER); }],
    ['nonofficial link', ($: ReturnType<typeof load>) => { field($, 'tracking_link').find('a').attr('href', 'https://www.sps-sro.sk.example.invalid/sledovanie-zasielky/?shipment_id=' + PARTNER); }],
    ['unsecured link', ($: ReturnType<typeof load>) => { field($, 'tracking_link').find('a').attr('href', 'http://www.sps-sro.sk/sledovanie-zasielky/?shipment_id=' + PARTNER); }],
    ['other official route', ($: ReturnType<typeof load>) => { field($, 'tracking_link').find('a').attr('href', 'https://www.sps-sro.sk/other?shipment_id=' + PARTNER); }],
    ['unverified query key', ($: ReturnType<typeof load>) => { field($, 'tracking_link').find('a').attr('href', 'https://www.sps-sro.sk/sledovanie-zasielky/?code=' + PARTNER); }],
    ['duplicate link', ($: ReturnType<typeof load>) => { field($, 'tracking_link').append(field($, 'tracking_link').find('a').clone()); }],
    ['hidden label', ($: ReturnType<typeof load>) => { field($, 'tracking_number').parent().attr('hidden', ''); }],
    ['missing name', ($: ReturnType<typeof load>) => { field($, 'partner').parent().remove(); }],
  ] as const)('omits inconclusive %s evidence without discarding own history', (_name, change) => {
    const result = parsePostOneTrackingHtml(mutate(change), NUMBER);
    expect(result.current_stage).toBe('delivered'); expect(result.events).toHaveLength(6);
    expect(result.delivery_carrier).toBeUndefined(); expect(result.delivery_tracking_number).toBeUndefined();
    expect(deliveryHandoff('post-one', NUMBER, result)).toBeNull();
  });
});
