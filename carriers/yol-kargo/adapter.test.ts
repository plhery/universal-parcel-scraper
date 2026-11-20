import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { arasNumberFor, normalizeYolNumber, parseYolShipment } from './parser.js';
import { statusMap, yolStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample Yol Kargo carried itself; the synthetic numbers lie far beyond the range in use.
const OWN = '950443351';
const HANDED = '999999000001';
const UNKNOWN = '999999000002';
const GUID = '0123456789ABCDEF0123456789ABCDEF';
const SHIPMENT_PAGE = 'http://185.130.59.105/Elci2017/KargoSorgulaDetay.aspx';
const ARAS = 'https://kargotakip.araskargo.com.tr';
const ARAS_NUMBER = '9900000000001';
const ACCOUNT = `accountid=${GUID}&sifre=SYNTHETIC`;

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const arasPage = (name: string) => readFileSync(new URL(`../aras-kargo/fixtures/${name}.html`, import.meta.url), 'utf8');
const shipment = page('shipment');
const edit = (body: string, change: (document: ReturnType<typeof load>) => void) => { const $ = load(body); change($); return $.html(); };
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
/** The lookup's answer: a redirect to the system that holds the number, which it also lists in its body. */
const lookup = (location: string, body: string) => new Response(`\uFEFF\r\n${body}`, { status: 302,
  headers: { Location: location, 'Content-Type': body ? 'application/json' : 'text/html; charset=UTF-8' } });
const own = (guid = GUID) => lookup(`${SHIPMENT_PAGE}?Guid=${guid}`, JSON.stringify([{ url: guid, cpy: 4 }]));
const handed = (number = HANDED) => lookup(`http://kargotakip.araskargo.com.tr/CargoInfoV2.aspx?${ACCOUNT}&alici_kod=${number}`,
  JSON.stringify([{ url: `${ACCOUNT}&alici_kod=${number}`, cpy: 1 }]));
const unknown = (number = UNKNOWN) => lookup(`http://kargotakip.fulkargo.com.tr:9999/tracking?har_kod=${number}`, '');
const serve = (...replies: (() => Response)[]) => vi.fn<typeof fetch>(async () => replies.shift()!());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// Aras Kargo's summary frame for the shipment Yol Kargo handed it, naming Yol Kargo's number as the sender's waybill.
const arasSummary = (waybill = `AB${HANDED}`) => edit(arasPage('summary'), $ => { $('#labelTradingWaybillNumber').text(waybill); });
const arasFound = () => new Response(null, { status: 302, headers: [['Location', '/kargotakip.aspx'],
  ['Set-Cookie', 'ASP.NET_SessionId=syntheticsession0000000000; path=/; HttpOnly; SameSite=Lax']] });

describe('Yol Kargo HTTP adapter', () => {
  it('asks the tracking form’s lookup for the whole number and opens the page it redirects to, through the supplied transport', async () => {
    const fetcher = serve(own, () => html(shipment));
    await expect(carrier(fetcher).track({ number: OWN })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`https://yolkargo.com.tr/kargo?q=${OWN}`, `${SHIPMENT_PAGE}?Guid=${GUID}`]);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'manual' && init.signal instanceof AbortSignal)).toBe(true);
  });

  it('reads Yol Kargo’s own movements newest first as wall clocks, leaving the recipient out', () => {
    const result = normalizeCarrierResult(parseYolShipment(shipment, OWN));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'TESLİM GİRİŞİ', last_update: null, last_update_local: '2025-04-25T14:35:20', expected_delivery: null });
    expect(result.events?.map(event => [event.local_time, event.description, event.stage])).toEqual([
      ['2025-04-25T14:35:20', 'TESLİM GİRİŞİ', 'delivered'],
      ['2025-04-25T14:35:08', 'DAĞITIMA ÇIKTI', 'out_for_delivery'],
      ['2025-04-23T09:00:22', 'TESLİMAT ŞUBESİNDE', 'in_transit'],
      ['2025-04-22T19:16:12', 'KARGO YOLA ÇIKTI', 'in_transit'],
      ['2025-04-21T12:55:04', 'KARGO YOLA ÇIKTI', 'in_transit'],
    ]);
    expect(result.events?.every(event => !event.time && !event.provider_code && !event.location)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Mur\*\*|TAÇ/);
  });

  it('keeps an unmapped movement without a stage and takes the stage of the newest one that has it', () => {
    const changed = edit(shipment, $ => { $('#GridTarihce tr').last().after('<tr><td>950443351</td><td>SYNTHETIC NOTE</td><td>26.04.2025</td><td>08:00:00</td></tr>'); });
    const result = parseYolShipment(changed, OWN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'SYNTHETIC NOTE', last_update_local: '2025-04-26T08:00:00' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
  });

  it('counts a page only when it is Yol Kargo’s and names the number asked on itself and on every movement', () => {
    expect(() => parseYolShipment(shipment, '950443352')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYolShipment(edit(shipment, $ => { $('#GridTarihce td').first().text('950443352'); }), OWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYolShipment(edit(shipment, $ => { $('#LBL_KARGO_HEADER').text('ÖRNEK KARGO ÜZERİNDE KARGO HAREKETLERİ'); }), OWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYolShipment(edit(shipment, $ => { $('#lblBarkodNo').text(''); }), OWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a shipment without movements as listed, and rejects a changed table', () => {
    expect(() => parseYolShipment(edit(shipment, $ => { $('#GridTarihce').remove(); }), OWN)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseYolShipment(edit(shipment, $ => { $('#GridTarihce th').first().text('BARKOD'); }), OWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYolShipment(edit(shipment, $ => { $('#GridTarihce td').eq(2).text('31.02.2025'); }), OWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYolShipment(edit(shipment, $ => { $('#GridTarihce td').eq(1).text(''); }), OWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('follows a shipment Yol Kargo handed Aras Kargo to Aras Kargo’s tracker under the number Aras Kargo gave it', async () => {
    const fetcher = serve(handed, () => html(page('aras-partner')), () => html(arasSummary()),
      arasFound, () => html(arasPage('tracker')), () => html(arasPage('summary')), () => html(arasPage('movements')));
    const result = await carrier(fetcher).track({ number: HANDED });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'TESLİM EDİLDİ',
      delivery_carrier: 'aras-kargo', delivery_tracking_number: ARAS_NUMBER });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://yolkargo.com.tr/kargo?q=${HANDED}`,
      `${ARAS}/CargoInfoV2.aspx?${ACCOUNT}&alici_kod=${HANDED}`,
      `${ARAS}/CargoInfoWaybillAndDelivered.aspx?shipmentid=A880E77C0FCEF1478DE7FA7F4EF7B4B1&subekod=`,
      `${ARAS}/mainpage.aspx?code=${ARAS_NUMBER}`,
      `${ARAS}/kargotakip.aspx`,
      `${ARAS}/CargoInfoWaybillAndDelivered.aspx?shipmentid=0123456789ABCDEF0123456789ABCDEF&subekod=`,
      `${ARAS}/CargoInfoTransactionAndRedirection.aspx`,
    ]);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });

  it('takes Aras Kargo’s number only from a summary naming Yol Kargo’s number as the sender’s waybill', () => {
    expect(arasNumberFor(arasSummary(), HANDED)).toBe(ARAS_NUMBER);
    expect(arasNumberFor(arasSummary(HANDED), HANDED)).toBe(ARAS_NUMBER);
    expect(() => arasNumberFor(arasSummary('AB999999000009'), HANDED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => arasNumberFor(arasSummary('PRIVATE_SYNTHETIC_WAYBILL'), HANDED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => arasNumberFor('<html lang="tr"><body></body></html>', HANDED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a number neither Yol Kargo nor Ful Kargo, where its lookup sends it, knows as not found, and nothing else', async () => {
    const ask = (...replies: (() => Response)[]) => carrier(serve(...replies)).track({ number: UNKNOWN });
    await expect(ask(unknown, () => html(page('ful-not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(ask(unknown, () => html('<html><body><table><tr><td>KARGO</td></tr></table></body></html>'))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(ask(() => unknown('999999000003'))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps a changed lookup, a moved route, a bot check and other partners apart', async () => {
    const ask = (...replies: (() => Response)[]) => carrier(serve(...replies)).track({ number: OWN });
    const listed = (body: string, location = `${SHIPMENT_PAGE}?Guid=${GUID}`) => () => lookup(location, body);
    await expect(ask(listed('[{"url":"SYNTHETIC","cpy":4}]'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(listed(`[{"url":"${GUID}","cpy":4}]`, `${SHIPMENT_PAGE}?Guid=FEDCBA9876543210FEDCBA9876543210`))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(listed('{"url":1}'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(listed('not json'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(listed(`[{"url":"${GUID}","cpy":4},{"url":"${GUID}","cpy":4}]`))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(ask(listed(`[{"url":"har_kod=${OWN}","cpy":2}]`))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(ask(() => handed(OWN), () => html(page('aras-partner')), () => html(arasSummary()))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => html('<html><body>Yol Kargo</body></html>'))).rejects.toMatchObject({ kind: 'transport', status: 200 });
    await expect(ask(() => html('', 404))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(ask(own, () => html('', 404))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(ask(() => html('<html><head><title>Just a moment...</title></head></html>', 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(ask(own, () => html('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(ask(() => html('', 503))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(own()).mockResolvedValueOnce(html(shipment));
    await expect(carrier(flaky).track({ number: OWN })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(3);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: OWN }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('takes seven to twelve digits and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['950443', '9504433510000', 'AB950443351', 'SAMPLETRACKING', `${'1'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: OWN }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeYolNumber(' 950 443 351 ')).toBe(OWN);
  });

  it('is asked when the number is filed under Yol Kargo or comes in its tracking link', async () => {
    expect(detectCarrierMatch(OWN).carrier).not.toBe('yol-kargo');
    expect(parseTrackingInput(`https://yolkargo.com.tr/kargo.php?q=${OWN}`)).toMatchObject({ trackingNumber: OWN, carrier: 'yol-kargo' });
    const fetcher = serve(own, () => html(shipment));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: OWN, carrier: 'yol-kargo' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'yol-kargo', source: 'yol-kargo', result: { current_stage: 'delivered' } });
  });
});

describe('Yol Kargo status vocabulary', () => {
  it('maps every wording it records to its stage', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(yolStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'yol-kargo', description: 'Sample note' })).toEqual({ kind: 'unknown' });
    expect(yolStage('Sample note')).toBeNull();
  });
});
