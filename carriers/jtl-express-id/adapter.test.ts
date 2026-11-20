import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, jtlExpressDescription, jtlExpressLookupUrl, JtlExpressTracker, normalizeJtlExpressNumber, parseJtlExpress } from './adapter.js';
import { jtlExpressStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import sample from './fixtures/resi-C4BLT002-0323-00006.json' with { type: 'json' };
import unknown from './fixtures/not-found.json' with { type: 'json' };

type Reply = typeof sample;
const NUMBER = sample.resi;
const copy = (): Reply => structuredClone(sample);
const step = (day: string, clock: string, caption: string) => `<div class='step '><div><div class='circle'><i class='fa fa-check'></i></div></div>`
  + `<div><div class='title'>${day}</div><div class='kecil'>${clock}</div><div class='caption'>${caption}</div></div></div>`;

type Answer = { status?: number; body?: string };
function harness(answer: Answer = { body: JSON.stringify(sample) }) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    return new Response(answer.body ?? '', { status: answer.status ?? 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
  });
  return { fetcher, tracker: new JtlExpressTracker({ fetcher, recorder: NOOP_RECORDER }) };
}

describe('JTL Express tracker', () => {
  it('reads the published resi: taken in at Blitar, picked up, then held for the customer', () => {
    const result = parseJtlExpress(sample, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Paket di kembalikan di Blitar [Blitar Sananwetan] - (HOLD) Menunggu Konfirmasi Pelanggan',
      last_update: null, last_update_local: '2023-03-29T22:55:00', expected_delivery: null, service_name: 'Standart',
      unread_estimates: ['layanan'], destination_country: 'ID' });
    expect(result.events!.map(({ local_time, description, stage }) => [local_time, description, stage])).toEqual([
      ['2023-03-29T22:55:00', 'Paket di kembalikan di Blitar [Blitar Sananwetan] - (HOLD) Menunggu Konfirmasi Pelanggan', 'exception'],
      ['2023-03-29T15:08:00', 'Paket telah di pick up', 'accepted'],
      ['2023-03-29T14:10:00', 'Terima permintaan pick up dari [JTL]', 'registered'],
      ['2023-03-29T14:05:31', 'Barang di terima di POS (C4BLT002) di Kota Kota Blitar - Jawa Timur', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SIGESIT|Septian/);
    expect(result.events![1]).toEqual({ local_time: '2023-03-29T15:08:00', description: 'Paket telah di pick up', stage: 'accepted', stage_source: 'carrier_map' });
  });

  it('leaves out who picked a parcel up or took it', () => {
    expect(jtlExpressDescription('Paket telah di pick up oleh [SIGESIT - Nama Kurir]')).toBe('Paket telah di pick up');
    expect(jtlExpressDescription('Paket diterima oleh BUDI - Ybs')).toBe('Paket diterima - Ybs');
    expect(jtlExpressDescription('Terima permintaan pick up dari [JTL]')).toBe('Terima permintaan pick up dari [JTL]');
  });

  it('keeps a row it cannot stage, once, and newest first', () => {
    // Invented: a later row in words the map does not know, and the first row repeated.
    const reply = copy();
    reply.tabel = step('30-03-2023', '08:00', 'Paket dalam perjalanan ke Kab. Malang') + reply.tabel + step('29-03-2023', '14:05:31',
      'Barang di terima di POS  (C4BLT002) di Kota Kota Blitar - Jawa Timur');
    const result = parseJtlExpress(reply, NUMBER);
    expect(result.events).toHaveLength(5);
    expect(result.events![0]).toEqual({ local_time: '2023-03-30T08:00:00', description: 'Paket dalam perjalanan ke Kab. Malang' });
    expect(result).toMatchObject({ current_stage: 'exception', last_status_text: 'Paket dalam perjalanan ke Kab. Malang', last_update_local: '2023-03-30T08:00:00' });
    reply.tabel = step('30-03-2023', '08:00', 'Paket dalam perjalanan ke Kab. Malang');
    reply.layanan = 'Standart';
    expect(parseJtlExpress(reply, NUMBER)).toMatchObject({ status: 'unknown', service_name: 'Standart' });
    expect(parseJtlExpress(reply, NUMBER)).not.toHaveProperty('current_stage');
    expect(parseJtlExpress(reply, NUMBER)).not.toHaveProperty('unread_estimates');
  });

  it('answers only for the resi asked', () => {
    expect(() => parseJtlExpress(unknown, NUMBER)).toThrow(NotFoundError);
    expect(() => parseJtlExpress({ hasil: 0, pesan: 'Synthetic refusal' }, NUMBER)).toThrow(IndeterminateError);
    expect(() => parseJtlExpress(sample, 'C4BLT002-0323-00001')).toThrow(IndeterminateError);
    expect(parseJtlExpress({ ...copy(), resi: NUMBER.toLowerCase() }, NUMBER).events).toHaveLength(4);
  });

  it('refuses a reply it cannot read', () => {
    expect(() => parseJtlExpress(null, NUMBER)).toThrow(SchemaError);
    expect(() => parseJtlExpress({ pesan: 'ok' }, NUMBER)).toThrow(SchemaError);
    expect(() => parseJtlExpress({ ...copy(), resi: '' }, NUMBER)).toThrow(SchemaError);
    expect(() => parseJtlExpress({ ...copy(), tabel: null }, NUMBER)).toThrow(SchemaError);
    for (const [day, clock, caption] of [['2023-03-29', '14:05', 'x'], ['29-03-1999', '14:05', 'x'], ['31-02-2023', '14:05', 'x'],
      ['29-03-2023', '24:05', 'x'], ['29-03-2023', '14:05', ' ']]) {
      expect(() => parseJtlExpress({ ...copy(), tabel: step(day!, clock!, caption!) }, NUMBER), `${day} ${clock}`).toThrow(SchemaError);
    }
    expect(() => parseJtlExpress({ ...copy(), tabel: step('29-03-2023', '14:05', 'x').repeat(301) }, NUMBER)).toThrow(SchemaError);
    expect(() => parseJtlExpress({ ...copy(), tabel: '' }, NUMBER)).toThrow(NoHistoryError);
  });

  it('takes a resi with or without its hyphens and refuses anything else before asking', async () => {
    expect(normalizeJtlExpressNumber(' c4blt002-0323-00006 ')).toBe(NUMBER);
    // As the library hands it over, without hyphens.
    expect(normalizeJtlExpressNumber('C4BLT002032300006')).toBe(NUMBER);
    const h = harness();
    for (const number of ['C4BL', '-C4BLT002-0323', 'C4BLT002--0323-00006', 'C4BLT002/0323/00006', 'C4BLT002-032-300006', '0323-00006',
      `${'A'.repeat(13)}-0323-00006`, '']) {
      await expect(h.tracker.fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const { number } of numbers.records) expect(detectCarrierMatch(number).carrier, number).not.toBe('jtl-express-id');
  });

  it('tries once more when the tracker cannot be reached', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify(sample), { headers: { 'content-type': 'text/html; charset=UTF-8' } }));
    await expect(new JtlExpressTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'exception' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('asks the lookup the page makes, without the picture code', async () => {
    const h = harness();
    await expect(h.tracker.fetch('C4BLT002032300006')).resolves.toMatchObject({ current_stage: 'exception' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(String(h.fetcher.mock.calls[0]?.[0])).toBe('https://www.jtlexpress.co.id/Tracking/Resitracking?resi=C4BLT002-0323-00006');
    expect(jtlExpressLookupUrl(NUMBER)).toBe(String(h.fetcher.mock.calls[0]?.[0]));
    expect(adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null, fetcher: h.fetcher }))
      .toMatchObject({ id: 'jtl-express-id', steps: ['direct', 'retry'] });
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
  });

  it('reads an unknown resi as not found, a browser check as a challenge, and other answers as what they are', async () => {
    await expect(harness({ body: JSON.stringify({ ...unknown, cap_img: '<img>', cap_wrd: 'PRIVATE' }) }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness({ status: 403, body: '<title>Just a moment...</title>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness({ body: '<title>Attention Required! | Cloudflare</title>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness({ body: '<html>maintenance</html>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness({ status: 404 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness({ status: 302 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness({ status: 429 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(harness({ status: 503 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'maintenance', status: 503 });
  });

  it('maps every status it has seen', () => {
    for (const entry of statuses.entries) {
      expect(jtlExpressStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'jtl-express-id', description: entry.wording }), entry.wording).toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
    expect(jtlExpressStage('Paket di kembalikan di Blitar [Blitar Sananwetan]')).toBeUndefined();
  });
});
