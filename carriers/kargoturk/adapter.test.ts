import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { normalizeKargoturkNumber, parseKargoturk } from './parser.js';
import { kargoturkStage, statusMap } from './status.js';

const NUMBER = '974681350246', RETURN = '1974681350246';
const fixture = (name = 'tracking') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('KargoTurk history', () => {
  it('binds both whole barcodes and projects branch/activity clocks without names or proof links', () => {
    const result = parseKargoturk(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-07-04T13:30:00' });
    expect(result.events).toHaveLength(6);
    expect(result.events![0]).toMatchObject({ stage: 'delivered', location: 'EXAMPLE ŞUBE' });
    expect(result.events![1]).not.toHaveProperty('stage'); expect(result.events![2]).not.toHaveProperty('stage');
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private-proof/);
  });

  it('distinguishes depot return from completed return to the sending company', () => {
    const result = parseKargoturk(fixture('returned'), RETURN);
    expect(result.current_stage).toBe('returned'); expect(result.events).toHaveLength(4);
    expect(result.events![1]).toMatchObject({ stage: 'in_transit', description: 'Çıkış Şubesine Geri Geldi' });
    expect(result.events![2]).toMatchObject({ stage: 'exception' });
    expect(kargoturkStage('Şubeden İade Olarak Yönlendirildi')).toBe('exception');
    expect(statusMap.gaps).toHaveLength(3);
  });

  it('retains a delivery round through a communication notice but not through an unknown new phase', () => {
    const $ = load(fixture()); $('table tbody tr').slice(-2).remove(); $('.trk-status-text h2').text('Dağıtımda');
    expect(parseKargoturk($.html(), NUMBER).current_stage).toBe('out_for_delivery');
    $('table tbody tr').last().children('td').eq(2).text('New logistics phase');
    expect(parseKargoturk($.html(), NUMBER).status).toBe('unknown');
  });

  it('keeps the specific absent tracker view separate from mixed results, changes and impossible dates', () => {
    expect(() => parseKargoturk(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const html of [fixture().replace(`class="trk-status-barcode">${NUMBER}`, `class="trk-status-barcode">${NUMBER}0`),
      fixture().replace('Müşteri Barkod', 'Another label'), fixture().replace('04.07.2026', '30.02.2026'),
      fixture().replace('13:30', '24:00'), fixture().replace('Kanıt</th>', 'Signature</th>'),
      fixture('not-found').replace('Kargo takip kodu bulunamadı.', 'Unavailable'), fixture() + fixture('not-found')]) {
      expect(() => parseKargoturk(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(normalizeKargoturkNumber(' 974681 350246 ')).toBe(NUMBER);
    expect(() => normalizeKargoturkNumber('97468135024')).toThrow(expect.objectContaining({ reason: 'unsupported_reference' }));
  });
});
