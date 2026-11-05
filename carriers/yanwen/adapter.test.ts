import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, parse, YanwenTracker, yanwenTrackingUrl } from './adapter.js';
import { sameInstantIdentityPolicy } from './app.js';
import { InvalidInputError } from '../../core/errors/index.js';
import statuses from './statuses.json' with { type: 'json' };
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { statusMap, yanwenCategory, yanwenStatus } from './status.js';

const NUMBER = 'UK000000005YP';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const NONE_ICON = '/static/img/timeline_none.png';

/** The fixture with its delivery scan reworded and, unless kept, without its LM40 icon. */
function reworded(wording: string, keepIcon = false) {
  const $ = load(fixture());
  $('.cz_r h6').filter((_, element) => $(element).text().endsWith('Delivered.')).text(wording);
  if (!keepIcon) $('.cz_c img[src$="LM40.png"]').attr('src', NONE_ICON);
  return $;
}

type Row = [day: string, clock: string, place: string, wording: string, icon?: string];

/** The fixture with both timelines replaced by these rows, newest first, and the category and destination given. */
function history(rows: Row[], category?: string, country?: string) {
  const $ = load(fixture());
  if (category) $('input[name=wcdhA]').attr('status', category);
  if (country) $('.cx_top_nr').each((_, element) => { $(element).children('.colFlex').eq(3).text(country); });
  $('.czhaodl dl').html(rows.map(([day, clock, where, wording, icon]) => `<dt>${day}</dt><dd><p class="timePoint">${clock}</p>`
    + `<div class="cz_c"><img src="${icon ? `/static/img/${icon}.png` : NONE_ICON}"></div>`
    + `<div class="cz_r">${where ? `<h6>[${where}]</h6>` : ''}<h6>${wording}</h6></div></dd>`).join(''));
  return parse($.html(), NUMBER);
}

/** The fixture with a last-mile reference and the notes naming its distributor. */
function distributed(reference: string, name: string, site: string) {
  const $ = load(fixture());
  $('.cx_top_nr').each((_, element) => { $(element).children('.colFlex').eq(1).html(`${reference}<a></a>`); });
  $('.cx_lb').append(`<div class="addNotes"><span>Additional Notes</span><p>Distributor: ${name}</p><p>Distributor
    Website: ${site}</p><p>Contact Number: PRIVATE_CONTACT</p></div>`);
  return parse($.html(), NUMBER);
}

describe('Yanwen result projection', () => {
  it('binds both responsive result copies and reads per-scan GMT offsets', () => {
    const result = normalizeCarrierResult(parse(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-03-05T12:00:00+01:00',
      delivered_at: '2026-03-05T12:00:00+01:00', destination_country: 'IT', delivery_tracking_number: '6000000000001' });
    expect(result.events).toHaveLength(4);
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'accepted']);
    expect(result.events?.at(-1)?.time).toBe('2026-03-02T14:00:00+08:00');
    expect(result.events?.[0]!.location).toBe('Example facility');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('requires actual result identity and rejects disagreeing responsive copies', () => {
    expect(() => parse(`<input value="${NUMBER}">${fixture().replaceAll(NUMBER, 'UK000000014YP')}`, NUMBER)).toThrow('different or ambiguous');
    expect(() => parse(fixture().replaceAll(NUMBER, 'UK000000014YP'), NUMBER)).toThrow('different or ambiguous shipment (1 listed, 0 matching)');
    expect(() => parse('<html><body></body></html>', NUMBER)).toThrow('different or ambiguous shipment (0 listed, 0 matching)');
    const $ = load(fixture());
    $('.cx_lb').last().find('.cz_r h6').last().text('Different history');
    expect(() => parse($.html(), NUMBER)).toThrow('inconsistent');
    const duplicates = load(fixture());
    duplicates('.ny_cxjg').append(duplicates('input[name=wcdhA]').clone());
    expect(() => parse(duplicates.html(), NUMBER)).toThrow('ambiguous');
  });

  it('recognizes only the explicit identity-bound missing-item result', () => {
    expect(() => parse(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(fixture('not-found').replaceAll('No information was found', 'Maintenance'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(fixture('not-found').replace('查询不到', '未知'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse('<input id="numbers_en"><h1>YW TRACKING</h1>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('answers a last-mile number with the parcel whose page names it', () => {
    const LAST_MILE = 'YWABC000000000001';
    const page = (reference = LAST_MILE, named = LAST_MILE) => {
      const $ = load(fixture());
      $('.ny_cxjg').append(`<input name="wcdhB${NUMBER}" type="hidden" value="${named}">`);
      $('.cx_top_nr').each((_, element) => { $(element).children('.colFlex').eq(1).html(`${reference}<a></a>`); });
      return $.html();
    };
    const result = normalizeCarrierResult(parse(page(), LAST_MILE));
    expect(result).toMatchObject({ status: 'delivered', canonical_tracking_number: NUMBER, delivered_at: '2026-03-05T12:00:00+01:00' });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.events).toHaveLength(4);
    // Asked by its own number, the parcel still hands off to the last-mile number.
    const own = parse(page(), NUMBER);
    expect(own.delivery_tracking_number).toBe(LAST_MILE);
    expect(own.canonical_tracking_number).toBeUndefined();
    // The identity field and every summary copy must name the number.
    expect(() => parse(page('YWABC000000000002'), LAST_MILE)).toThrow('different or ambiguous');
    expect(() => parse(page(LAST_MILE, 'YWABC000000000002'), LAST_MILE)).toThrow('different or ambiguous');
    const $ = load(page());
    $('.cx_top_nr').last().children('.colFlex').eq(1).html('YWABC000000000002<a></a>');
    expect(() => parse($.html(), LAST_MILE)).toThrow('different or ambiguous shipment (another last-mile number)');
  });

  it.each(['date', 'offset', 'empty', 'missing-timeline'])('rejects invalid %s instead of promoting earlier scans', (mode) => {
    const $ = load(fixture());
    if (mode === 'date') $('.czhaodl dt').first().text('2026-02-30');
    if (mode === 'offset') $('.timePoint').first().text('12:00:00 [GMT+unknown]');
    if (mode === 'empty') $('.cz_r').first().find('h6').last().empty();
    if (mode === 'missing-timeline') $('.czhaodl').first().remove();
    expect(() => parse($.html(), NUMBER)).toThrow();
  });

  it('reports a delivery only from a delivered scan, never from the category or progress rail', () => {
    const result = parse(reworded('Expected delivery').html(), NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]!.stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads the LM40 delivery scan whatever wording the last-mile carrier used', () => {
    const $ = reworded('Synthetic delivery wording', true);
    expect(parse($.html(), NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-03-05T12:00:00+01:00' });
    // A later notice leaves the delivery and its time in place.
    $('.czhaodl dl').prepend(`<dt>2026-03-06</dt><dd><p class="timePoint">08:00:00 [GMT+01]</p><div class="cz_c"><img src="${NONE_ICON}"></div><div class="cz_r"><h6>Synthetic notice</h6></div></dd>`);
    expect(parse($.html(), NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Synthetic notice',
      delivered_at: '2026-03-05T12:00:00+01:00' });
  });

  it.each([
    ['正在派送', 'out_for_delivery', 'out_for_delivery'], ['到达待取', 'out_for_delivery', 'ready_for_pickup'], ['制单完成', 'pending', 'registered'],
    ['投递失败', 'exception', 'failed_attempt'], ['包裹异常', 'exception', 'exception'], ['包裹退回', 'exception', 'returned'],
    ['运输途中', 'in_transit', undefined], ['追踪结束', 'unknown', undefined],
  ])('takes the status from the %s category when the newest wording is new', (category, status, stage) => {
    const $ = reworded('Synthetic partner wording');
    $('input[name=wcdhA]').attr('status', category);
    const result = parse($.html(), NUMBER);
    expect(result.status).toBe(status);
    expect(result.current_stage).toBe(stage);
    expect(result.events?.[0]!.stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
  });

  it('names the distributor only when the catalog knows it and its detection offers the reference', () => {
    expect(distributed('UUS0000000000000001', 'UniUni', 'https://www.uniuni.com/')).toMatchObject({ delivery_carrier: 'uniuni', delivery_tracking_number: 'UUS0000000000000001' });
    const unoffered = distributed('UNI00Z0000000000001', 'UniUni', 'https://www.uniuni.com/');
    expect(unoffered.delivery_carrier).toBeUndefined();
    expect(unoffered.delivery_tracking_number).toBe('UNI00Z0000000000001');
    expect(distributed('YWEXA010000000001', 'YANWEN', 'https://www.yanwenexpress.com/').delivery_carrier).toBeUndefined();
    expect(distributed('UUS0000000000000001', 'Example Post', 'https://www.example.com/').delivery_carrier).toBeUndefined();
    expect(JSON.stringify(distributed('UUS0000000000000001', 'UniUni', 'https://www.uniuni.com/'))).not.toContain('PRIVATE');
  });

  it('names Emile as the distributor of its EM…CA reference', () => {
    expect(distributed('EM000000000001CA', 'Emile', 'https://www.emileps.com/'))
      .toMatchObject({ delivery_carrier: 'emile', delivery_tracking_number: 'EM000000000001CA' });
  });

  it('keeps postcodes, PINs and door numbers out of scans', () => {
    const $ = load(fixture());
    $('.czhaodl').each((_, timeline) => {
      const rows = $(timeline).find('dd');
      rows.eq(0).find('h6').first().text('[Z9Z 9Z9, Example Town, ZZ]');
      rows.eq(0).find('h6').last().text('Delivered in the mailbox , PIN: 0000 , Door NO: 00. If you have any questions, please contact Example.');
      rows.eq(1).find('h6').first().text('[EXAMPLE TOWN, ZZ 00000]');
      rows.eq(2).find('h6').first().text('[Example Town,ZZ,00000-0000,US]');
    });
    const result = parse($.html(), NUMBER);
    expect(result.events?.slice(0, 3).map((event) => event.location)).toEqual(['Example Town, ZZ', 'EXAMPLE TOWN, ZZ', 'Example Town, ZZ, US']);
    $('.czhaodl').each((_, timeline) => { $(timeline).find('dd').eq(0).find('h6').first().text('[Not Available]'); });
    expect(parse($.html(), NUMBER).events?.[0]!.location).toBe('');
    $('.czhaodl').each((_, timeline) => { $(timeline).find('dd').eq(0).find('h6').first().text('[AA]'); });
    expect(parse($.html(), NUMBER).events?.[0]!.location).toBe('');
    // A scan stored with the placeholder as its place keeps its row.
    const incoming = { stage: 'in_transit', description: 'Arrived at delivery centre', location: '', providerCode: '' };
    expect(sameInstantIdentityPolicy.matches?.(incoming, { ...incoming, location: 'Not Available' })).toBe(true);
    expect(sameInstantIdentityPolicy.matches?.(incoming, { ...incoming, location: 'AA' })).toBe(true);
    expect(sameInstantIdentityPolicy.matches?.(incoming, { ...incoming, location: 'Example Town' })).toBe(false);
    expect(sameInstantIdentityPolicy.matches?.(incoming, { ...incoming, location: 'Not Available', description: 'Delivered' })).toBe(false);
    expect(result.last_status_text).toBe('Delivered in the mailbox. If you have any questions, please contact Example.');
    expect(result.status).toBe('delivered');
    for (const value of ['Z9Z', '00000', 'PIN', 'Door']) expect(JSON.stringify([result.last_status_text, result.events])).not.toContain(value);
  });

  it('drops the UTC copy of a relayed history and keeps each local scan with its place', () => {
    const result = history([
      ['2026-03-06', '16:47:56 [GMT-04]', '', 'Delivered, In/At Mailbox', 'LM40'],
      ['2026-03-06', '12:47:56 [GMT-04]', 'EXAMPLE TOWN, ZZ', 'Delivered, In/At Mailbox', 'LM40'],
      ['2026-03-06', '10:10:00 [GMT-04]', 'EXAMPLE TOWN, ZZ', 'Out for Delivery'],
      ['2026-03-06', '06:10:00 [GMT-04]', '', 'Out for Delivery'],
      ['2026-03-05', '04:00:00 [GMT-04]', '', 'In Transit to Next Facility'],
      ['2026-03-05', '00:00:00 [GMT-04]', '', 'In Transit to Next Facility'],
      ['2026-03-04', '21:11:42 [GMT-05]', 'EXAMPLE CITY, ZZ', 'Accepted at USPS Origin Facility'],
      ['2026-03-04', '16:11:42 [GMT-05]', 'EXAMPLE CITY, ZZ', 'Accepted at USPS Origin Facility'],
      ['2026-03-02', '14:00:00 [GMT+08]', '', 'Yanwen Pickup Scan'],
    ]);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-03-06T12:47:56-04:00', delivered_at: '2026-03-06T12:47:56-04:00' });
    // USPS dates its "In Transit to Next Facility" by its day alone, which the local copy gives at midnight.
    expect(result.events?.map((event) => [event.time ?? event.local_time, event.location])).toEqual([
      ['2026-03-06T12:47:56-04:00', 'EXAMPLE TOWN, ZZ'], ['2026-03-06T06:10:00-04:00', 'EXAMPLE TOWN, ZZ'], ['2026-03-05', ''],
      ['2026-03-04T16:11:42-05:00', 'EXAMPLE CITY, ZZ'], ['2026-03-02T14:00:00+08:00', ''],
    ]);
    // The copy carries the UTC wall clock, so under an eastern offset it reads early.
    expect(history([
      ['2026-03-03', '10:00:00 [GMT+08]', 'Example facility', 'Arrived at domestic terminal station'],
      ['2026-03-03', '02:00:00 [GMT+08]', '', 'Arrived at domestic terminal station'],
    ]).events?.map((event) => [event.time, event.location])).toEqual([['2026-03-03T10:00:00+08:00', 'Example facility']]);
  });

  it("reads La Poste's relayed scans of a parcel bound for France on UTC's wall clock", () => {
    const rows: Row[] = [
      ['2026-10-26', '18:40:00 [GMT+01]', 'EXAMPLE PLATFORM', 'Transport to delivery centre'],
      ['2026-10-23', '13:34:37 [GMT+02]', 'EXAMPLE HUB', 'Arrived at destination'],
      ['2026-10-22', '22:53:59 [GMT+01]', '', 'Batch delivery to carrier', 'LH40'],
      ['2026-10-22', '09:05:00 [GMT+01]', '', 'Pick up by local carrier at destination port'],
      ['2026-10-20', '11:42:17 [GMT+08]', 'Example facility', 'Arrived at domestic terminal station'],
      ['2026-10-20', '00:48:27 [GMT+00]', 'Example manifest', 'Manifest created'],
    ];
    const times = (country?: string, scans = rows) => history(scans, undefined, country).events?.map((event) => event.time);
    // Placed scans without an icon under France's offset; Yanwen's own scans and other offsets stay.
    expect(times('FR')).toEqual(['2026-10-26T19:40:00+01:00', '2026-10-23T15:34:37+02:00', '2026-10-22T22:53:59+01:00',
      '2026-10-22T09:05:00+01:00', '2026-10-20T11:42:17+08:00', '2026-10-20T00:48:27Z']);
    expect(times('IT')?.slice(0, 2)).toEqual(['2026-10-26T18:40:00+01:00', '2026-10-23T13:34:37+02:00']);
    // France was on +02:00 on 22 October: a +01:00 stamp then is not France's offset.
    expect(times('FR', [['2026-10-22', '14:00:00 [GMT+01]', 'EXAMPLE HUB', 'Arrived at destination']])).toEqual(['2026-10-22T14:00:00+01:00']);
    // La Poste's own French sentences come on the local clock, as its delivery under the icon does.
    expect(times('FR', [
      ['2026-10-30', '10:30:38 [GMT+01]', 'EXAMPLE OFFICE', 'Votre colis est livré dans votre boite aux lettres.', 'LM40'],
      ['2026-10-30', '09:23:12 [GMT+01]', 'EXAMPLE OFFICE', 'Votre colis est sur son site de distribution. Nous le préparons pour le mettre en livraison.'],
      ['2026-10-30', '06:54:48 [GMT+01]', 'EXAMPLE OFFICE', 'Votre Colissimo est en cours de traitement sur le site de tri local.'],
      ['2026-10-22', '09:33:45 [GMT+02]', 'EXAMPLE SENDER', 'Votre Colissimo va bientôt nous être confié ! Il est en cours de préparation chez votre expéditeur.'],
    ])).toEqual(['2026-10-30T10:30:38+01:00', '2026-10-30T09:23:12+01:00', '2026-10-30T06:54:48+01:00', '2026-10-22T09:33:45+02:00']);
    // A history that also came on the local clock already lost its UTC copies.
    expect(times('FR', [['2026-10-23', '15:34:37 [GMT+02]', 'EXAMPLE HUB', 'Arrived at destination'],
      ['2026-10-23', '13:34:37 [GMT+02]', 'EXAMPLE HUB', 'Arrived at destination']])).toEqual(['2026-10-23T15:34:37+02:00']);
  });

  it('keeps repeated scans that are not one UTC copy of another', () => {
    const result = history([
      // A day apart rather than an offset apart.
      ['2026-03-06', '09:00:00 [GMT-04]', 'EXAMPLE TOWN, ZZ', 'Out for Delivery'],
      ['2026-03-05', '09:00:00 [GMT-04]', 'EXAMPLE TOWN, ZZ', 'Out for Delivery'],
      // An offset apart, but in two places, under two icons or under two offsets.
      ['2026-03-04', '22:00:00 [GMT-04]', 'EXAMPLE CITY, ZZ', 'Departed USPS Regional Facility'],
      ['2026-03-04', '18:00:00 [GMT-04]', 'OTHER CITY, ZZ', 'Departed USPS Regional Facility'],
      ['2026-03-04', '12:00:00 [GMT-04]', '', 'Synthetic batch scan', 'LH40'],
      ['2026-03-04', '08:00:00 [GMT-04]', '', 'Synthetic batch scan'],
      ['2026-03-03', '21:00:00 [GMT-04]', '', 'Synthetic hub scan'],
      ['2026-03-03', '16:00:00 [GMT-05]', '', 'Synthetic hub scan'],
      // Three in a row an offset apart: no single pairing is sure.
      ['2026-03-03', '08:00:00 [GMT-04]', '', 'In Transit to Next Facility'],
      ['2026-03-03', '04:00:00 [GMT-04]', '', 'In Transit to Next Facility'],
      ['2026-03-03', '00:00:00 [GMT-04]', '', 'In Transit to Next Facility'],
      ['2026-03-02', '14:00:00 [GMT+08]', '', 'Yanwen Pickup Scan'],
    ]);
    expect(result.events).toHaveLength(12);
  });

  it("reads a partner's scans past their country's code, and a scan of the code alone as no stage", () => {
    for (const [wording, stage] of [['UA.Delivered to customs terminal', 'customs'], ['HK.He left the airport', 'in_transit'],
      ['UA.In the New Post Office', 'ready_for_pickup'], ['UA.Sent to storage', 'exception'], ['Delivery is not possible', 'failed_attempt'],
      ['Parcel accepted in the unclaimed cargo area', 'exception']] as const) {
      expect(yanwenStatus(wording)?.stage, wording).toBe(stage);
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
    }
    // Only a code joined to the words: a spaced abbreviation stays.
    expect(yanwenStatus('UA. Sent to storage')).toBeUndefined();
    const result = history([
      ['2026-03-10', '12:10:28 [GMT+00]', 'UA EXAMPLE', 'UA.'],
      ['2026-03-10', '12:04:17 [GMT+00]', 'UA EXAMPLE', 'Parcel accepted in the unclaimed cargo area'],
      ['2026-03-08', '06:10:38 [GMT+00]', 'UA EXAMPLE', 'Delivery is not possible'],
      ['2026-03-01', '11:18:05 [GMT+00]', 'UA EXAMPLE', 'UA.In the New Post Office'],
      ['2026-02-27', '09:40:22 [GMT+00]', '', 'UA.Delivered to customs terminal'],
    ], '投递失败');
    expect(result.events?.map((event) => event.stage)).toEqual([undefined, 'exception', 'failed_attempt', 'ready_for_pickup', 'customs']);
    // The newest scan names no stage, so the category gives the status.
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
  });

  it("reads China Post's domestic scans as China Post's map does, its receipt as Yanwen's hand-over and the security check's return as an exception", () => {
    for (const [wording, stage] of [['中国邮政已收取邮件', 'in_transit'], ['邮件到达【示例市处理中心】', 'in_transit'],
      ['邮件离开【示例市处理中心】，正在发往下一站', 'in_transit'], ['【示例市处理中心】退回，备注:安检退回', 'exception'],
      ['【示例市处理中心】已出口直封', 'in_transit'], ['出口海关/留存待验', 'customs']] as const) {
      expect(yanwenStatus(wording)?.stage, wording).toBe(stage);
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
    }
    const result = history([
      ['2026-03-02', '22:14:47 [GMT+08]', '', '【示例市处理中心】已出口直封'],
      ['2026-03-02', '22:13:47 [GMT+08]', '', '【示例市处理中心】退回，备注:安检退回'],
    ], '运输途中');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(result.events?.map((event) => event.stage)).toEqual(['in_transit', 'exception']);
  });

  it("keeps USPS's label notice on the stage before it, without its US place, and USPS's day-only step on its day", () => {
    const result = history([
      ['2026-03-07', '00:00:00 [GMT-05]', '', 'In Transit to Next Facility, Arriving On Time'],
      ['2026-03-07', '05:00:00 [GMT-05]', '', 'In Transit to Next Facility, Arriving On Time'],
      ['2026-03-06', '05:54:00 [GMT-05]', 'EXAMPLE CITY,ZZ', 'Arrived at USPS Regional Origin Facility'],
      ['2026-03-04', '12:21:29 [GMT+08]', '', 'Yanwen facility - Outbound'],
      ['2026-03-03', '13:41:00 [GMT-05]', 'EXAMPLE TOWN,ZZ', 'Shipping Label Created, USPS Awaiting Item'],
      ['2026-03-03', '11:44:30 [GMT+08]', '', 'Yanwen Pickup Scan'],
    ], '运输途中', 'US');
    expect(result.events?.map((event) => [event.description, event.stage, event.stage_source, event.location, event.time ?? event.local_time])).toEqual([
      ['In Transit to Next Facility, Arriving On Time', 'in_transit', undefined, '', '2026-03-07'],
      ['Arrived at USPS Regional Origin Facility', 'in_transit', undefined, 'EXAMPLE CITY,ZZ', '2026-03-06T05:54:00-05:00'],
      ['Yanwen facility - Outbound', 'in_transit', undefined, '', '2026-03-04T12:21:29+08:00'],
      ['Shipping Label Created, USPS Awaiting Item', 'accepted', 'none', '', '2026-03-03T13:41:00-05:00'],
      ['Yanwen Pickup Scan', 'accepted', undefined, '', '2026-03-03T11:44:30+08:00'],
    ]);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-03-07' });
    // Newest, the notice leaves the parcel where the pickup put it.
    const noticed = history([
      ['2026-03-03', '13:41:00 [GMT-05]', 'EXAMPLE TOWN,ZZ', 'Shipping Label Created, USPS Awaiting Item'],
      ['2026-03-03', '11:44:30 [GMT+08]', '', 'Yanwen Pickup Scan'],
    ], '运输途中', 'US');
    expect(noticed).toMatchObject({ current_stage: 'accepted', last_status_text: 'Shipping Label Created, USPS Awaiting Item' });
    expect(statusMap.stage(null, normalizeStatusWording('Shipping Label Created, USPS Awaiting Item'))).toBeUndefined();
    expect(statusMap.gaps?.map((gap) => gap.wording)).toContain(normalizeStatusWording('Shipping Label Created, USPS Awaiting Item'));
    // A step at another clock keeps it.
    expect(history([['2026-03-07', '07:29:00 [GMT-08]', '', 'In Transit to Next Facility']]).events?.[0]?.time).toBe('2026-03-07T07:29:00-08:00');
  });

  it("stages the delivering carrier's loading in Canada on the scan itself, as the category files it", () => {
    const result = history([
      ['2026-03-10', '07:43:04 [GMT-04]', 'EXAMPLE TOWN, ZZ', 'Loaded on Truck'],
      ['2026-03-10', '03:37:32 [GMT-04]', 'EXAMPLE TOWN, ZZ', 'Arrived at Terminal Location'],
      ['2026-03-09', '21:14:42 [GMT-04]', 'EXAMPLE CITY, ZZ', 'Received from Prior Carrier'],
      ['2026-03-09', '12:45:00 [GMT-04]', '', 'Scanned arrived at FB Canada'],
    ], '正在派送', 'CA');
    expect(result.events?.map((event) => event.stage)).toEqual(['out_for_delivery', 'in_transit', 'in_transit', 'in_transit']);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-03-10T07:43:04-04:00' });
  });

  it("reads a Turkish leg's postal events through customs to the collection point's hold, whatever country they name", () => {
    for (const [wording, stage] of [
      ['Shipment sent from destination transit centre,Despatched to overseas (Country code: TR)', 'in_transit'],
      ['Shipment received at Post Office,Arrival at Destination Post (Country: TR)', 'in_transit'],
      ['Shipment arrived at overseas hub/ branch,Arrival at Processing Center (Country code: GR)', 'in_transit'],
      ['IN TRANSIT,Present to Import Customs', 'customs'],
      ['Shipment released from customs/ government check point,Released from Custom', 'in_transit'],
      ['Shipment hold for collection,Receive item at collection point for pick-up (Country: TR)', 'ready_for_pickup'],
    ] as const) {
      expect(yanwenStatus(wording)?.stage, wording).toBe(stage);
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
    }
    const result = history([
      ['2026-03-12', '13:53:00 [GMT+03]', '', 'Shipment hold for collection,Receive item at collection point for pick-up (Country: TR)'],
      ['2026-03-12', '13:53:00 [GMT+03]', '', 'Shipment released from customs/ government check point,Released from Custom'],
      ['2026-03-12', '11:40:00 [GMT+03]', '', 'IN TRANSIT,Present to Import Customs'],
    ], '运输途中', 'TR');
    expect(result.events?.map((event) => event.stage)).toEqual(['ready_for_pickup', 'in_transit', 'customs']);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
  });

  it("reads J&T Australia's relayed scans as J&T's map does, its pickup after Yanwen's batch handover as transit", () => {
    for (const [wording, stage] of [
      ['The parcel has been successfully picked up and is being prepared for transportation. Customer service:130000', 'in_transit'],
      ['The parcel is dispatched from the transit center to the next destination', 'in_transit'],
      ['The parcel arrives at the distribution center and is prepared for transport to the next destination.', 'in_transit'],
      ['Your parcel is out for delivery. If you have any questions, please call customer service:130000, Thank you for your patience.', 'out_for_delivery'],
    ] as const) {
      expect(yanwenStatus(wording)?.stage, wording).toBe(stage);
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
    }
    const result = history([
      ['2026-10-27', '17:00:03 [GMT+08]', 'EXAMPLE DEPOT', 'Your parcel is out for delivery. If you have any questions, please call customer service:130000, Thank you for your patience.'],
      ['2026-10-27', '15:58:57 [GMT+08]', 'EXAMPLE HUB', 'The parcel has been successfully picked up and is being prepared for transportation. Customer service:130000'],
      ['2026-10-26', '17:04:50 [GMT+10]', '', 'Batch delivery to carrier', 'LH40'],
    ], '正在派送', 'AU');
    expect(result.events?.map((event) => event.stage)).toEqual(['out_for_delivery', 'in_transit', 'in_transit']);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    // Without J&T's customer service line and the courtesy that offers it, as J&T's own adapter.
    expect(result.events?.slice(0, 2).map((event) => event.description)).toEqual([
      'Your parcel is out for delivery.', 'The parcel has been successfully picked up and is being prepared for transportation.']);
    expect(JSON.stringify(result)).not.toMatch(/130000|customer service/i);
    for (const event of result.events!.slice(0, 2)) expect(statusMap.stage(null, normalizeStatusWording(event.description!)), event.description).toBe(event.stage);
    // Another courier's pickup sentence is not J&T's.
    expect(yanwenStatus('The parcel has been successfully picked up. Customer service:130000')).toBeUndefined();
  });

  it('files every recorded wording, code and category under its recorded stage', () => {
    for (const entry of statuses.entries) {
      if (entry.code === 'LM40') expect(yanwenStatus(entry.wording ?? '', entry.code)?.stage, entry.code).toBe(entry.stage);
      else if (entry.code) expect(yanwenCategory(entry.code)?.stage, entry.code).toBe(entry.stage);
      else expect(yanwenStatus(entry.wording ?? '')?.stage, entry.wording).toBe(entry.stage);
    }
  });

  it('deduplicates identical scans and proves each declared capability', () => {
    const $ = load(fixture());
    $('.czhaodl dl').each((_, element) => { const dl = $(element); dl.append(dl.find('dd').last().clone()); });
    const result = parse($.html(), NUMBER);
    expect(result.events).toHaveLength(4);
    const partner = distributed('UUS0000000000000001', 'UniUni', 'https://www.uniuni.com/');
    const checks: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.some((event) => event.location)),
      delivered_at: Boolean(result.delivered_at), delivery_partner: Boolean(partner.delivery_carrier && partner.delivery_tracking_number) };
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    for (const capability of metadata.capabilities) expect(checks[capability], capability).toBe(true);
  });
});

describe('Yanwen anonymous form retrieval', () => {
  it('uses the public browser signature with one fresh bounded form request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture()));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.track({ number: 'uk 000.000-005 yp' })).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://track.yw56.com.cn/en/querydel?nums=UK000000005YP&cyp=7cbe10bb0451c723ffac72e72cb79aa2');
    expect(yanwenTrackingUrl(NUMBER)).toBe(url);
    expect(init).toMatchObject({ method: 'POST', body: 'timeZone=1', cache: 'no-store', redirect: 'error' });
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited']])('classifies HTTP %s without treating it as shipment absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('failure', { status: Number(status) }));
    await expect(new YanwenTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported inputs before I/O, propagates cancellation and limits response size', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(new YanwenTracker({ fetcher: unused }).fetch('tracking&nums')).rejects.toThrow(InvalidInputError);
    // The adapter refuses it before its lookup starts, so an ended signal does not hide it.
    await expect(adapter({ fetcher: unused, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER })
      .track({ number: 'tracking&nums' }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(new YanwenTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new YanwenTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});
