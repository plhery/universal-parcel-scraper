import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { normalizeTopdeliveryNumber, parseTopdelivery } from './parser.js';

const NUMBER = '97468135';
const fixture = (name = 'tracking') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('TopDelivery history', () => {
  it('binds both complete identities, keeps a delivery day without midnight and excludes order controls', () => {
    const result = parseTopdelivery(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-07-04' });
    expect(result.events).toHaveLength(5);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.events![4]).toMatchObject({ local_time: '2026-07-01T10:20:00', description: 'Подготавливается к отправке в службу доставки' });
    expect(result.events!.every(event => !event.time && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|accessToken|orderId/);
  });

  it('accepts only the unique bound absence view and keeps challenges distinct', () => {
    expect(() => parseTopdelivery(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const mixed = fixture().replace('</title>', '</title><section class="container error"><div class="tracking__text">Ваш заказ не найден.</div></section>');
    for (const html of [mixed, fixture('not-found').replace('Ваш заказ не найден.', 'Service unavailable'),
      fixture('not-found').replace(NUMBER, NUMBER + '0')]) {
      expect(() => parseTopdelivery(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseTopdelivery('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseTopdelivery(fixture().replace('name="order"', 'name="captcha"'), NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('rejects another result identity, changed structure and impossible clocks before truncation', () => {
    for (const html of [fixture().replace(`name="orderId" value="${NUMBER}"`, `name="orderId" value="${NUMBER}0"`),
      fixture().replace('04.07.2026', '30.02.2026'), fixture().replace('(10:20)', '(24:00)'), fixture() + fixture()]) {
      expect(() => parseTopdelivery(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown latest activity visible and ignores only undated inactive steps', () => {
    const $ = load(fixture());
    $('.info-status > ul').append('<li class="active-status"><span>New logistics activity</span><div class="info-status__item-data">05.07.2026 <span class="info-status__item-time">(08:00)</span></div></li><li><span>Future step</span></li>');
    const result = parseTopdelivery($.html(), NUMBER);
    expect(result.status).toBe('unknown'); expect(result.events).toHaveLength(6);
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(normalizeTopdeliveryNumber(' 9746 8135 ')).toBe(NUMBER);
    expect(() => normalizeTopdeliveryNumber('CODE97468135')).toThrow(expect.objectContaining({ reason: 'unsupported_reference' }));
  });

  it('caps distinct history while still validating every source row', () => {
    const $ = load(fixture()), list = $('.info-status > ul');
    list.append(Array.from({ length: 101 }, (_, i) => `<li class="active-status"><span>Activity ${i}</span><div class="info-status__item-data">05.07.2026 <span class="info-status__item-time">(08:00)</span></div></li>`).join(''));
    expect(parseTopdelivery($.html(), NUMBER)).toMatchObject({ history_truncated: true });
    expect(parseTopdelivery($.html(), NUMBER).events).toHaveLength(100);
    list.append('<li class="active-status"><span>Activity</span><div class="info-status__item-data">invalid<span class="info-status__item-time"></span></div></li>');
    expect(() => parseTopdelivery($.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
