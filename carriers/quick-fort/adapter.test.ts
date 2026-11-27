import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { trackCarrier } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import type { UniversalTracker } from '../../providers/universal.js';
import { adapter, QUICK_FORT_ENDPOINT, QuickFortTracker } from './adapter.js';
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

  it('reads the timeline of the site\'s current design as it read the table', () => {
    const timeline = parseQuickFort(fixture('timeline'), NUMBER);
    expect(timeline).toEqual(parseQuickFort(fixture('found'), NUMBER));
    expect(timeline.events).toHaveLength(8);
    const round = fixture('timeline').replace('L\'envoi est dans le réseau de livraison local.', 'Out for delivery in Springfield,00000 Sampleton,ES');
    expect(parseQuickFort(round, NUMBER).events?.[1]).toMatchObject({ description: 'Out for delivery', location: 'Springfield, Sampleton, ES',
      stage: 'out_for_delivery' });
    const empty = fixture('timeline').replace(/<div class="timeline">[\s\S]*?\n {8}<\/div>\n/, '<div class="timeline"></div>\n');
    expect(() => parseQuickFort(empty, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    const unlabelled = fixture('timeline').replace('<div class="time">2026-03-13 20:48:59</div>', '<span>2026-03-13 20:48:59</span>');
    expect(() => parseQuickFort(unlabelled, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses an order page laid out neither way, rather than reading it as one without rows', () => {
    const redesigned = fixture('timeline').replaceAll('timeline', 'track-list');
    expect(() => parseQuickFort(redesigned, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const blank = fixture('found').replace(/<div id="result">[\s\S]*?<\/section>\s*<\/div>/, '<div id="result"> </div>');
    expect(() => parseQuickFort(blank, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
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

  it('reads the English rows, takes their places out and leaves the recipient\'s street out of the delivery', () => {
    // Synthetic rows in the English tracker's shapes, newest first, with invented places.
    const rows = [
      ['2026-03-20 09:00:00', 'Sampleburg,DE,00000,Delivered Examplestraße8/1'],
      ['2026-03-19 08:00:00', 'Out for delivery in Sampleburg,00000,DE'],
      ['2026-03-18 18:00:00', 'Delivery has been scheduled with the carrier.'],
      ['2026-03-18 08:00:00', 'Parcel arrived at the local delivery station, serving Sampleburg,00000.'],
      ['2026-03-12 08:00:00', 'Shipment information has been received for destination processing. .'],
      ['2026-03-11 08:00:00', 'Shipment arrived at DE Airport'],
      ['2026-03-06 08:00:00', 'Origin processing completed [Sampleton].'],
      ['2026-03-05 08:00:00', 'Parcel received at the processing facility Sampleton.'],
      ['2026-03-04 08:00:00', 'Consignment received at the local warehouse in ON,CA,X0X 0X0,Sampleton.'],
      ['2026-03-03 08:00:00', 'Sampleton,ON,CA,X0X 0X0,Order information received by the carrier.'],
    ].map(([time, text]) => `<tr><td>${time}</td><td>${text}</td></tr>`);
    const result = parseQuickFort(fixture('found').replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${rows.join('')}</tbody>`), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map' });
    expect(result.events?.map(({ description, location }) => [description, location])).toEqual([
      ['Delivered', 'Sampleburg, DE'],
      ['Out for delivery', 'Sampleburg, DE'],
      ['Delivery has been scheduled with the carrier.', undefined],
      ['Parcel arrived at the local delivery station.', 'Sampleburg'],
      ['Shipment information has been received for destination processing. .', undefined],
      ['Shipment arrived at DE Airport', undefined],
      ['Origin processing completed [Sampleton].', undefined],
      ['Parcel received at the processing facility Sampleton.', undefined],
      ['Consignment received at the local warehouse.', 'Sampleton, ON, CA'],
      ['Order information received by the carrier.', 'Sampleton, ON, CA'],
    ]);
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit',
      'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.events?.every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/00000|X0X|straße/);
    // Wordings observed before the places came out still read by the map.
    for (const [wording, stage] of [['consignment received at the local warehouse in on,ca,x0x 0x0,sampleton.', 'accepted'],
      ['out for delivery in sampleburg,00000,de', 'out_for_delivery'], ['parcel arrived at the local delivery station, serving sampleburg,00000.', 'in_transit'],
      ['delivered examplestraße8/1', 'delivered'], ['shipment arrived at the de destination processing facility.', 'in_transit']] as const) {
      expect(statusMap.stage(null, wording), wording).toBe(stage);
    }
    expect(statusMap.stage(null, 'delivered to the sender')).toBeUndefined();
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

  it('reads a delivery dated after the lookup as the expected day, and holds the planned rows back', async () => {
    // Synthetic rows: the tracker's plan lists the round and the delivery ahead of the lookup.
    const rows = [
      ['2026-03-21 12:00:00', 'Delivered'],
      ['2026-03-20 09:00:00', 'Out for delivery'],
      ['2026-03-18 08:00:00', 'Parcel arrived at the local delivery station.'],
      ['2026-03-11 08:00:00', 'Shipment arrived at DE Airport'],
    ].map(([time, text]) => `<tr><td>${time}</td><td>${text}</td></tr>`);
    const page = fixture('found').replace(/<tbody>[\s\S]*<\/tbody>/, `<tbody>${rows.join('')}</tbody>`);
    const readAt = Date.parse('2026-03-19T12:00:00+08:00');
    expect(parseQuickFort(page, NUMBER, readAt)).toMatchObject({ expected_delivery: '2026-03-21' });
    expect(parseQuickFort(page, NUMBER, Date.parse('2026-03-22T00:00:00+08:00'))).toMatchObject({ expected_delivery: null, current_stage: 'delivered' });
    const fetcher = (async () => new Response(page, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })) as typeof fetch;
    const registry = new AdapterRegistry({ factories: { 'quick-fort': adapter }, carriers: { 'quick-fort': 'quick-fort' } },
      { trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher });
    vi.useFakeTimers({ now: readAt, toFake: ['Date'] });
    try {
      const result = await trackCarrier('quick-fort', { number: NUMBER }, { registry, universal: {} as UniversalTracker });
      expect(result.events?.map(event => event.time)).toEqual(['2026-03-18T08:00:00+08:00', '2026-03-11T08:00:00+08:00']);
      expect(result).toMatchObject({ expected_delivery: '2026-03-21', last_update: '2026-03-18T08:00:00+08:00' });
      expect(result.current_stage).not.toBe('delivered');
    } finally {
      vi.useRealTimers();
    }
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
