import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QUICK_FORT_ENDPOINT, QuickFortTracker } from './adapter.js';
import { parseQuickFort } from './parser.js';
import { quickFortStage, statusMap } from './status.js';

const NUMBER = 'QFT900000000017';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('Quick Fort parser', () => {
  it('reads every row on the tracker\'s Hong Kong clock, newest first', () => {
    const result = parseQuickFort(fixture('found'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-03-14T22:00:49+08:00',
      expected_delivery: null });
    expect(result.events).toHaveLength(8);
    expect(result.events?.map(event => event.stage)).toEqual(['in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit',
      'in_transit', 'accepted', 'registered']);
    expect(result.events?.[7]).toMatchObject({ time: '2026-03-02T13:26:54+08:00' });
    expect(result.current_stage_source).toBe('carrier_map');
    expect(result.events?.every(event => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('maps the network\'s sentences whatever city or airport they name, and leaves others to the shared rules', () => {
    for (const wording of ['Le colis est arrivé au centre de traitement d\'origine à Montréal.',
      'L\'envoi est arrivé au terminal de fret de l\'aéroport international Pearson de Toronto.',
      'L\'envoi a quitté l\'aéroport de Vancouver et est en transport international.', 'L\'envoi est arrivé à l\'aéroport in FR.',
      'L\'envoi a été remis au transporteur.', 'L\'envoi a été remis au transporteur aérien.']) {
      expect(quickFortStage(wording)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    }
    expect(statusMap.stage('', 'l\'envoi a quitté l\'aéroport de vancouver et est en transport international.')).toBe('in_transit');
    expect(quickFortStage('Le colis a été livré.')).toMatchObject({ stage: 'delivered' });
    expect(quickFortStage('Le colis a été livré.')?.source).not.toBe('carrier_map');
  });

  it('takes the place out of a sentence, before or after it, without its postcode', () => {
    const events = parseQuickFort(fixture('found'), NUMBER).events!;
    expect(events[0]).toMatchObject({ description: 'Le colis est arrivé à l\'agence locale de livraison desservant la zone du destinataire.',
      location: 'Springfield' });
    expect(events[6]).toMatchObject({ description: 'L\'envoi a été pris en charge par l\'entrepôt local au départ.', location: 'Sampleton, ON, CA' });
    expect(events[7]).toMatchObject({ description: 'Le transporteur a reçu les informations électroniques de l\'envoi.', location: 'Sampleton, ON, CA' });
    expect(events[3]).toEqual(expect.objectContaining({ description: 'L\'envoi est arrivé à l\'aéroport in DE.' }));
    expect(events[3]).not.toHaveProperty('location');
    expect(JSON.stringify(events)).not.toMatch(/00000|X0X/);
  });

  it('leaves a sentence with commas but no code or postcode whole', () => {
    const page = fixture('found').replace('L\'envoi est dans le réseau de livraison local.', 'Colis en route, livraison prévue, merci.');
    const event = parseQuickFort(page, NUMBER).events?.[1];
    expect(event).toMatchObject({ time: '2026-03-13T20:48:59+08:00', description: 'Colis en route, livraison prévue, merci.' });
    expect(event).not.toHaveProperty('location');
  });

  it('reads the site\'s notice that no order was found as not found, and another notice as indeterminate', () => {
    expect(() => parseQuickFort(fixture('missing'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = fixture('missing').replace(/<h1>[^<]*<\/h1>/, '<h1>请求过于频繁</h1>');
    expect(() => parseQuickFort(other, NUMBER)).toThrow(expect.not.objectContaining({ kind: 'not_found' }));
  });

  it('refuses a page for another number, changed columns, a bad clock and a page without the order', () => {
    expect(() => parseQuickFort(fixture('found').replace('value="QFT900000000017"', 'value="QFT900000000018"'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseQuickFort(fixture('found').replace('<th>快件状态</th>', '<th>状态</th>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQuickFort(fixture('found').replace('2026-03-13 20:48:59', '13/03/2026'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseQuickFort('<html><body>Maintenance</body></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads an order without rows as one without history', () => {
    const empty = fixture('found').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>');
    expect(() => parseQuickFort(empty, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
  });

  it('flags a history only when distinct scans exceed the cap', () => {
    const page = (count: number) => {
      const rows = Array.from({ length: count }, (_, i) => `<tr><td>2026-03-02 10:00:00</td><td>Movement ${i}</td></tr>`);
      return fixture('found').replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody>' + rows.join('') + rows[0] + '</tbody>');
    };
    expect(parseQuickFort(page(100), NUMBER).history_truncated).toBeFalsy();
    expect(parseQuickFort(page(101), NUMBER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseQuickFort(page(101), NUMBER).events).toHaveLength(100);
  });

  it('refuses a number the tracker\'s path cannot carry', () => {
    expect(() => parseQuickFort(fixture('found'), 'QFT/1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

describe('Quick Fort adapter', () => {
  it('asks the order page for the number, in the site\'s language', async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      asked.push(String(url));
      expect(new Headers(init?.headers).get('Accept-Language')).toBe('zh-CN');
      return new Response(fixture('found'), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }) as typeof fetch;
    const result = await new QuickFortTracker({ fetcher }).fetch(' qft 900000000017 ');
    expect(asked).toEqual([`${QUICK_FORT_ENDPOINT}${NUMBER}`]);
    expect(result.status).toBe('in_transit');
  });

  it.each([404, 410])('treats endpoint HTTP %i as unavailable', async status => {
    const fetcher = async () => new Response('Endpoint retired', { status });
    await expect(new QuickFortTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('keeps a block page a challenge', async () => {
    const fetcher = (async () => new Response('<html><head><title>Just a moment...</title></head></html>', { status: 200 })) as typeof fetch;
    await expect(new QuickFortTracker({ fetcher }).fetch(NUMBER)).rejects.toHaveProperty('kind', 'challenge');
  });
});
