import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { birGundeUrl, normalizeBirGundeNumber, parseBirGunde } from './parser.js';
import { birGundeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples in numbers.json: a barcode with its page, and the shop's order number that page shows.
const NUMBER = 'B101873107', ORDER = '5355103875';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

describe('Bir Günde Kargo tracking page', () => {
  it('reads the movements newest first with their wall clocks, the sender and the delivery estimate', () => {
    const result = parseBirGunde(fixture('out-for-delivery'), NUMBER.toLowerCase());
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Dağıtıma Çıkarıldı',
      last_update: null, last_update_local: '2026-11-20T08:56:00', expected_delivery: '2026-11-20', sender_name: 'A101' });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    expect(result.events!.map(event => [event.local_time, event.stage])).toEqual([
      ['2026-11-20T08:56:00', 'out_for_delivery'], ['2026-11-18T12:18:00', 'failed_attempt'], ['2026-11-18T10:10:00', 'out_for_delivery'],
      ['2026-11-18T09:36:00', 'in_transit'], ['2026-11-17T21:52:00', 'in_transit'], ['2026-11-17T16:11:00', 'accepted'],
      ['2026-11-16T18:37:00', 'registered'],
    ]);
    // The recipient, courier and branch staff stay on the page.
    expect(JSON.stringify(result)).not.toMatch(/KURYE ADI|YETKİLİ|Xx \*|500000|00 XX 000|Örnek|kurye\.jpg/);
  });

  it('binds an order number to the order the page shows and gives the barcode as the canonical number', () => {
    expect(parseBirGunde(fixture('out-for-delivery'), ORDER)).toMatchObject({ canonical_tracking_number: NUMBER, sender_name: 'A101' });
    expect(() => parseBirGunde(fixture('out-for-delivery'), '5355103876')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBirGunde(fixture('out-for-delivery'), 'B101873108')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('opens the page by barcode or by order number', () => {
    expect(birGundeUrl(' b10187 3107 ')).toBe('https://takip.birgundekargo.com/intranet/Tracking_kargo.asp?bgk_barkod=B101873107');
    expect(birGundeUrl(ORDER)).toBe(`https://takip.birgundekargo.com/intranet/Tracking_kargo.asp?alici_musteri_kodu=${ORDER}`);
    expect(() => normalizeBirGundeNumber('B1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('keeps the unknown alert, the finished alert and changed pages apart', () => {
    expect(() => parseBirGunde(fixture('not-found'), 'B000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBirGunde(fixture('completed'), '471375644078')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'history_expired' }));
    for (const html of [fixture('not-found').replace('Takip bilgilerinizi kontrol ediniz.', 'Sistem bakımda.'),
      fixture('out-for-delivery').replace('Bir Günde Kargo Gönderi Sorgulama', 'Another page'),
      fixture('out-for-delivery').replace('<th class="col-md-4">Kargo Durumu</th>', '<th>Açıklama</th>'),
      fixture('out-for-delivery').replace('20-11-2026 08.56', '31-11-2026 08.56'),
      fixture('out-for-delivery').replace('barkod=B101873107&dahili=kurye', 'barkod=B101873199&dahili=kurye')]) {
      expect(() => parseBirGunde(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBirGunde('<html><title>Just a moment...</title></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('reads a page that lists the shipment without movements as listed', () => {
    const $ = load(fixture('out-for-delivery'));
    $('#collapseOne tbody').empty();
    expect(() => parseBirGunde($.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('drops a past estimate and maps every recorded wording', () => {
    const $ = load(fixture('out-for-delivery'));
    $('.ttt span').text('19.11.2026');
    expect(parseBirGunde($.html(), NUMBER).expected_delivery).toBeNull();
    for (const entry of statuses.entries) {
      expect(birGundeStage(entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, entry.wording.toLocaleLowerCase('en-US'))).toBe(entry.stage);
    }
  });

  it('reads the page the adapter asks for, with the caller signal', async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(String(input));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(fixture('out-for-delivery'), { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    };
    const result = await adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null }).track({ number: NUMBER });
    expect(requests).toEqual(['https://takip.birgundekargo.com/intranet/Tracking_kargo.asp?bgk_barkod=B101873107']);
    expect(result.current_stage).toBe('out_for_delivery');
  });
});
