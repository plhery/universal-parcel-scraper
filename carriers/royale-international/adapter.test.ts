import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { normalizeRoyaleInternationalNumber, parseRoyaleInternational } from './parser.js';
import { royaleInternationalStage, statusMap } from './status.js';

const NUMBER = '970682415309';
const fixture = () => readFileSync(new URL('./fixtures/tracking.html', import.meta.url), 'utf8');
const empty = `<section class="tracking-page"><form class="tracking-form" method="get" action="/tracking"><input id="waybillno" name="waybillno" value=""></form></section>`;

describe('Royale International history', () => {
  it('binds the visible waybill, places dated proof beside its capture and reads the consignee and who took the delivery', () => {
    const result = parseRoyaleInternational(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', service_name: 'Express',
      last_status_text: 'POD Details Captured', last_update: null, last_update_local: '2026-07-04T16:30:00',
      receiver_name: 'PRIVATE CONSIGNEE', signed_by: 'PRIVATE RECIPIENT' });
    expect(result.events).toHaveLength(4);
    expect(result.events![1]).toMatchObject({ local_time: '2026-07-04T15:00:00', description: 'Proof of delivery', stage: 'delivered' });
    expect(result.events![2]).toMatchObject({ location: 'Example facility' });
    expect(result.events![3]).not.toHaveProperty('location');
    expect(result.events!.every(event => !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE (?:SHIPPER|REFERENCE|SIGNATURE)|private-signature/);
  });

  it('keeps an update’s whole wording and stages it from the wording before a link, a recipient or a phone number', () => {
    const result = parseRoyaleInternational(fixture()
      .replace('Checked in at Example facility', 'Checked in at Example facility https://example.invalid/scan')
      .replace('POD Details Captured', 'POD Details Captured recipient: SAMPLE NAME'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_status_text: 'POD Details Captured recipient: SAMPLE NAME', signed_by: 'PRIVATE RECIPIENT' });
    expect(result.events![1]).toMatchObject({ description: 'Proof of delivery', stage: 'delivered' });
    expect(result.events![2]).toMatchObject({ description: 'Checked in at Example facility https://example.invalid/scan', location: 'Example facility' });
  });

  it('does not treat POD capture as delivery without dated proof or place proof without capture context', () => {
    const $ = load(fixture()); $('table.pod tbody').empty();
    const undated = parseRoyaleInternational($.html(), NUMBER);
    expect(undated.current_stage).toBe('in_transit');
    expect(undated).not.toHaveProperty('signed_by');
    expect(royaleInternationalStage('POD Details Captured')).toBeUndefined();
    expect(statusMap.gaps).toHaveLength(1);
    expect(() => parseRoyaleInternational(fixture().replace('POD Details Captured', 'New activity'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown later update unknown rather than restoring an earlier delivery', () => {
    const $ = load(fixture());
    $('table.events tbody').append('<tr><td>2026-07-05</td><td>08:00:00</td><td>New logistics phase</td></tr>');
    expect(parseRoyaleInternational($.html(), NUMBER).status).toBe('unknown');
  });

  it('separates an empty search view, verification, malformed tables and another full identifier', () => {
    expect(() => parseRoyaleInternational(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    expect(() => parseRoyaleInternational('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    for (const html of [fixture().replace(NUMBER, NUMBER + '0'), fixture() + fixture(),
      fixture().replace('<th>Date</th>', '<th>Timestamp</th>'), fixture().replace('2026-07-04', '2026-02-30')]) {
      expect(() => parseRoyaleInternational(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(normalizeRoyaleInternationalNumber(' 9706 8241 5309 ')).toBe(NUMBER);
    expect(() => normalizeRoyaleInternationalNumber('864209751')).toThrow(expect.objectContaining({ reason: 'unsupported_reference' }));
  });

  it('caps distinct events and rejects an oversized source history', () => {
    const $ = load(fixture()), rows = $('table.events tbody');
    rows.prepend(Array.from({ length: 101 }, (_, i) => `<tr><td>2026-07-01</td><td>10:00:00</td><td>Activity ${i}</td></tr>`).join(''));
    expect(parseRoyaleInternational($.html(), NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseRoyaleInternational($.html(), NUMBER).events).toHaveLength(100);
    rows.prepend(Array.from({ length: 500 }, () => '<tr><td>2026-07-01</td><td>10:00:00</td><td>Activity</td></tr>').join(''));
    expect(() => parseRoyaleInternational($.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

it('anchors proof to a capture just after midnight', () => {
  const html = fixture().replace('15:00:00', '23:55:00')
    .replace('2026-07-04</td><td>16:30:00', '2026-07-05</td><td>00:05:00');
  expect(parseRoyaleInternational(html, NUMBER).current_stage).toBe('delivered');
});
