import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { Stage } from '../../core/status/index.js';
import { TrawlClient, type TrawlCapturedResponse } from '../../core/transport/trawl.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HUAHAN_TRACKING, HuahanTracker, parseHuahanCapture, solveHuahanQuestion } from './adapter.js';
import { parseHuahan } from './parser.js';
import { huahanStage } from './status.js';

const NUMBER = 'HHWAA0000000001YQ';
const fixture = () => ({ ask: 1, data: [{ Code: NUMBER, Error_code: '0000', Status: 'Delivered',
  Shipper_Hawbcode: 'PRIVATE', Local_Carrier: 'CAINIAO', Local_Number: 'DOFR9999999999980HD', Country_code: 'FR', Detail: [
    { Occur_date: '2026-01-03 12:15:00', Status: 'CC', Comment: 'The parcel has been successfully delivered.', track_area: 'Destination facility', recipient: 'PRIVATE' },
    { Occur_date: '2026-01-01 10:00:00', Status: 'DF', Comment: 'Departed from origin facility', track_area: 'SHENZHEN' },
  ] }] });
const response = (value: unknown) => Response.json(value);
const init = () => {
  const reply = response({ ask: 1, token: 'synthetic-token' });
  Object.defineProperty(reply, 'url', { value: 'https://www.hh-exp.cn/WebTrack/init.php' });
  reply.headers.set('Set-Cookie', 'PHPSESSID=synthetic; Path=/');
  return reply;
};
function fetcher() {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(init())
    .mockResolvedValueOnce(response({ ask: 1, type: 'text', question: '26 - 18 = ?' }))
    .mockResolvedValueOnce(new Response('ok')).mockResolvedValueOnce(response(fixture()));
}

describe('HuaHan guest tracking', () => {
  it('solves the issued question in one session and binds the complete waybill', async () => {
    const fetch = fetcher();
    const result = await new HuahanTracker({ fetcher: fetch }).fetch(NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-01-03T12:15:00' });
    expect(result.events).toHaveLength(2);
    expect(result.events![1]).toMatchObject({ local_time: '2026-01-01T10:00:00', provider_code: 'DF', stage: 'in_transit' });
    expect(result.events!.every(event => !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const verify = new URL(String(fetch.mock.calls[2]![0]));
    expect(verify.searchParams.get('token')).toBe('synthetic-token');
    expect(verify.searchParams.get('answer')).toBe('8');
    expect(new URL(String(fetch.mock.calls[1]![0])).pathname).toBe('/WebTrack/tncode.php');
    expect(String(fetch.mock.calls[3]![0])).toBe('https://www.hh-exp.cn/WebTrack/CargoTrackActionPlus.php');
    const request = fetch.mock.calls[3]![1]!;
    expect(request.method).toBe('POST');
    expect(new URLSearchParams(String(request.body)).get('ordernumber')).toBe(NUMBER);
    expect(new Headers(request.headers).get('cookie')).toBe('PHPSESSID=synthetic');
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it('never evaluates code or guesses unsupported challenge types', async () => {
    for (const question of ['1;process.exit() = ?', '1 + 2 + 3 = ?', '1000 + 1 = ?', '1 / 0 = ?', '1 / 2 = ?', null]) {
      expect(() => solveHuahanQuestion(question)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(solveHuahanQuestion('12 × 3 = ?')).toBe('36');
    expect(solveHuahanQuestion('12 / 3 = ?')).toBe('4');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(init()).mockResolvedValueOnce(response({ ask: 1, type: 'click', question: '1 + 2 = ?' }));
    await expect(new HuahanTracker({ fetcher: fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('names the picture verification, which it does not solve, and reads the hourly cap as a rate limit', async () => {
    const picture = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(init())
      .mockResolvedValueOnce(response({ ask: 1, tip: ['华', '翰'], count: 2, img: 'data:image/webp;base64,AAAA' }));
    await expect(new HuahanTracker({ fetcher: picture }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', reason: 'click_captcha' });
    expect(picture).toHaveBeenCalledTimes(2);
    const capped = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ ask: 0, msg: '请求次数已达每小时上限，请稍后再试', data: [] }));
    await expect(new HuahanTracker({ fetcher: capped }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(capped).toHaveBeenCalledTimes(1);
  });

  describe('through the browser service', () => {
    let services = 0;
    const captured = (fields: Partial<TrawlCapturedResponse> = {}): TrawlCapturedResponse => ({ url: HUAHAN_TRACKING, status: 200,
      headers: {}, body: JSON.stringify(fixture()), truncated: false, base64Encoded: false, error: null, trackingNumberSubmitted: NUMBER, ...fields });
    const setup = (entries: TrawlCapturedResponse[]) => {
      const trawl = new TrawlClient(`http://browser.test/huahan-${services += 1}`);
      const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null,
        tier: 2, statusCode: 200, capturedResponses: entries, raw: {} });
      const picture = () => vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(init())
        .mockResolvedValueOnce(response({ ask: 1, tip: ['华', '翰'], count: 2, img: 'data:image/webp;base64,AAAA' }));
      return { trawl, scrape, picture };
    };

    it('reads the parcel there after the picture, then rests the direct step', async () => {
      const { trawl, scrape, picture } = setup([captured()]);
      const first = picture();
      const result = await new HuahanTracker({ fetcher: first, trawl }).fetch(NUMBER);
      expect(result).toMatchObject({ current_stage: 'delivered' });
      expect(first).toHaveBeenCalledTimes(2);
      expect(scrape.mock.calls[0]![0]).toMatchObject({ url: `https://www.hh-exp.cn/WebTrack/CargoTrack.html?ordernumber=${NUMBER}`,
        skipHttp: true, captureResponses: [HUAHAN_TRACKING] });
      const later = picture();
      await new HuahanTracker({ fetcher: later, trawl }).fetch(NUMBER);
      expect(later).not.toHaveBeenCalled();
      expect(scrape).toHaveBeenCalledTimes(2);
    });

    it('sends the configured proxy with the browser service\'s read, and refuses one that is not an HTTP(S) origin at setup', async () => {
      const proxy = 'http://user:opaque@proxy.invalid:8080';
      const { trawl, scrape, picture } = setup([captured()]);
      const make = (env: Record<string, string>) => adapter({ env, fetcher: picture(), trawl, browserExecutablePath: null, recorder: NOOP_RECORDER });
      await expect(make({ HUAHAN_BROWSER_PROXY_URL: ` ${proxy} ` }).track({ number: NUMBER }, {})).resolves.toMatchObject({ current_stage: 'delivered' });
      expect(scrape.mock.calls[0]![0]).toMatchObject({ proxy });
      for (const bad of ['relay.internal:3128', `${proxy}/path`]) expect(() => make({ HUAHAN_BROWSER_PROXY_URL: bad })).toThrow(TypeError);
      const { trawl: own, scrape: unproxied, picture: shown } = setup([captured()]);
      await adapter({ env: { HUAHAN_BROWSER_PROXY_URL: '  ' }, fetcher: shown(), trawl: own, browserExecutablePath: null, recorder: NOOP_RECORDER })
        .track({ number: NUMBER }, {});
      expect(unproxied.mock.calls[0]![0]).not.toHaveProperty('proxy');
    });

    it('does not ask the browser service after a rate limit', async () => {
      const { trawl, scrape } = setup([captured()]);
      const capped = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response({ ask: 0, msg: '请求次数已达每小时上限，请稍后再试', data: [] }));
      await expect(new HuahanTracker({ fetcher: capped, trawl }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
      expect(scrape).not.toHaveBeenCalled();
    });

    it('keeps each failure kind of the helper\'s answer', () => {
      expect(() => parseHuahanCapture([], NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge', reason: 'click_captcha' }));
      expect(() => parseHuahanCapture([captured({ trackingNumberSubmitted: 'HHWAA0000000002YQ' })], NUMBER))
        .toThrow(expect.objectContaining({ kind: 'challenge' }));
      expect(() => parseHuahanCapture([captured({ body: JSON.stringify({ ask: 0, msg: '请求次数已达每小时上限' }) })], NUMBER))
        .toThrow(expect.objectContaining({ kind: 'rate_limited' }));
      expect(() => parseHuahanCapture([captured({ body: JSON.stringify({ ask: 0, msg: '没有找到记录', data: [] }) })], NUMBER))
        .toThrow(expect.objectContaining({ kind: 'not_found' }));
      expect(() => parseHuahanCapture([captured({ status: 403, body: null, error: 'HuaHan verification returned a page' })], NUMBER))
        .toThrow(expect.objectContaining({ kind: 'challenge' }));
      expect(() => parseHuahanCapture([captured({ body: null, error: 'HuaHan tracking reply is not JSON' })], NUMBER))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
      expect(() => parseHuahanCapture([captured({ body: null, truncated: true })], NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
      expect(() => parseHuahanCapture([captured({ status: 503, body: null })], NUMBER)).toThrow(expect.objectContaining({ status: 503 }));
      expect(parseHuahanCapture([captured()], NUMBER).events).toHaveLength(2);
    });
  });

  it('requires accepted verification before looking up a shipment', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(init())
      .mockResolvedValueOnce(response({ ask: 1, type: 'text', question: '1 + 2 = ?' })).mockResolvedValueOnce(new Response('error'));
    await expect(new HuahanTracker({ fetcher: fetch }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('only treats an explicit absence as not-found', () => {
    expect(() => parseHuahan({ ask: 0, msg: '没有找到记录', data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHuahan({ ask: 0, msg: '请先通过滑块验证', data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseHuahan({ ask: 0, msg: 'too many requests', data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseHuahan({ ask: 0, data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHuahan({ ask: 1, data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = fixture(); empty.data[0]!.Detail = [];
    expect(() => parseHuahan(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('rejects unrelated identities, contradictory results and malformed clocks', () => {
    const wrong = fixture(); wrong.data[0]!.Code = 'HHWAA0000000002YQ';
    expect(() => parseHuahan(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const failed = fixture(); failed.data[0]!.Error_code = '9999';
    expect(() => parseHuahan(failed, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const clock = fixture(); clock.data[0]!.Detail[0]!.Occur_date = '2026-02-30 12:00:00';
    expect(() => parseHuahan(clock, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const duplicate = fixture(); duplicate.data.push(duplicate.data[0]!);
    expect(() => parseHuahan(duplicate, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads HuaHan arranging flights as transit', () => {
    const reply = fixture();
    const wording = 'The shipment is still in the process of arranging flights';
    Object.assign(reply.data[0]!.Detail[0]!, { Status: '', Comment: wording });
    const result = parseHuahan(reply, NUMBER);
    expect(result.events!.find(({ description }) => description === wording)).toMatchObject({
      stage: 'in_transit', stage_source: 'carrier_map',
    });
  });

  it('reads a missed delivery told again the same day without a new round as that attempt', () => {
    const reply = fixture();
    Object.assign(reply.data[0]!, { Status: 'Delivery Attempted' });
    reply.data[0]!.Detail = [
      { Occur_date: '2026-01-03 12:02:00', Status: '', Comment: 'Delivery Attempted, Unfortunately we have not been able to deliver your parcel. Pickup parcelshop delivery after first delivery attempt.', track_area: '' },
      { Occur_date: '2026-01-03 10:15:00', Status: '', Comment: 'Delivery Attempted', track_area: '' },
      { Occur_date: '2026-01-03 09:27:00', Status: 'CB', Comment: 'Out for Delivery, Out for delivery.', track_area: '' },
      ...reply.data[0]!.Detail.slice(1),
    ];
    const result = parseHuahan(reply, NUMBER);
    expect(result.events!.slice(0, 3).map((event) => [event.stage, event.stage_source])).toEqual([
      ['failed_attempt', 'none'], ['failed_attempt', 'carrier_map'], ['out_for_delivery', 'carrier_map']]);
    expect(result).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });
  });

  it('names the carrier of the number a transfer row gives when the partner fields name none', () => {
    const transfer = (local: Record<string, unknown>, comment = '转单:1Z999AA10123456784') => {
      const reply = fixture();
      Object.assign(reply.data[0]!, { Country_code: 'US', ...local });
      reply.data[0]!.Detail.splice(1, 0, { ...reply.data[0]!.Detail[1]!, Status: '', Comment: comment });
      return parseHuahan(reply, NUMBER);
    };
    const handed = transfer({ Local_Carrier: '', Local_Number: 'HZZX000000001' });
    expect(handed).toMatchObject({ delivery_carrier: 'ups', delivery_tracking_number: '1Z999AA10123456784' });
    // The row moves nothing: it keeps the stage of the scan before it.
    const row = handed.events!.findIndex((event) => event.description?.startsWith('转单'));
    expect(handed.events![row]).toMatchObject({ stage: handed.events![row + 1]!.stage, stage_source: 'none' });
    expect(handed.events![row]!.stage).toBeTruthy();
    // A carrier the partner fields name keeps its number; a number no carrier's rules claim at high confidence names none.
    expect(transfer({ Local_Carrier: 'USPS', Local_Number: '9400100000000000000000' }).delivery_carrier).toBe('usps');
    expect(transfer({ Local_Carrier: '', Local_Number: 'HZZX000000001' }, '转单:1Z999AA10123456785')).toMatchObject({
      delivery_tracking_number: 'HZZX000000001' });
    expect(transfer({ Local_Carrier: '', Local_Number: 'HZZX000000001' }, '转单:1Z999AA10123456785').delivery_carrier).toBeUndefined();
  });

  it('names the destination carrier, its number and the destination country', () => {
    expect(parseHuahan(fixture(), NUMBER)).toMatchObject({ destination_country: 'FR', delivery_carrier: 'aliexpress',
      delivery_tracking_number: 'DOFR9999999999980HD' });
    const usps = fixture();
    Object.assign(usps.data[0]!, { Local_Carrier: 'USPS', Local_Number: '9214490000000000000010_D104', Country_code: 'US' });
    expect(parseHuahan(usps, NUMBER)).toMatchObject({ destination_country: 'US', delivery_carrier: 'usps',
      delivery_tracking_number: '9214490000000000000010' });
    // A partner the catalog does not know, or whose rules do not fit the number, keeps only the number.
    const unknown = fixture();
    Object.assign(unknown.data[0]!, { Local_Carrier: 'Sample Couriers', Local_Number: 'SMP12345678' });
    const result = parseHuahan(unknown, NUMBER);
    expect(result.delivery_tracking_number).toBe('SMP12345678');
    expect(result.delivery_carrier).toBeUndefined();
    const none = fixture();
    Object.assign(none.data[0]!, { Local_Carrier: '', Local_Number: NUMBER, Country_code: null });
    expect(parseHuahan(none, NUMBER)).not.toHaveProperty('delivery_tracking_number');
    expect(parseHuahan(none, NUMBER)).not.toHaveProperty('destination_country');
  });

  it('places the destination carrier\'s scans after the hand-off in a destination of one zone', () => {
    const relayed = fixture();
    relayed.data[0]!.Detail = [
      { Occur_date: '2026-01-06 11:17:00', Status: 'CC', Comment: 'Delivery Successful, Your shipment has been delivered successfully', track_area: 'SAMPLE TOWN' },
      { Occur_date: '2026-01-05 20:44:00', Status: 'IA', Comment: 'Sorting Center Inbound, Your shipment has arrived at sorting center', track_area: 'Sample Hub' },
      { Occur_date: '2026-01-04 15:28:22', Status: 'JY', Comment: 'Has been given to local carrier', track_area: 'NL' },
      { Occur_date: '2026-01-03 14:59:51', Status: 'LD', Comment: 'Arrived at destination airport', track_area: 'NL' },
      { Occur_date: '2026-01-01 10:00:00', Status: 'DF', Comment: 'Departed from origin facility', track_area: 'SHENZHEN' },
    ];
    const result = parseHuahan(relayed, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2026-01-06T11:17:00+01:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map(event => event.time ?? event.local_time)).toEqual(['2026-01-06T11:17:00+01:00',
      '2026-01-05T20:44:00+01:00', '2026-01-04T15:28:22', '2026-01-03T14:59:51', '2026-01-01T10:00:00']);
    expect(result.events![2]).toMatchObject({ provider_code: 'JY', stage: 'in_transit', stage_source: 'carrier_map' });
    // A destination of several zones keeps every clock local.
    relayed.data[0]!.Country_code = 'US';
    const several = parseHuahan(relayed, NUMBER);
    expect(several).toMatchObject({ last_update: null, last_update_local: '2026-01-06T11:17:00' });
    expect(several.events!.every(event => !event.time)).toBe(true);
  });

  it('reads Landmark Global\'s relay on US Central time, its record of the sender\'s data and everything after the hand-off', () => {
    const relayed = fixture();
    Object.assign(relayed.data[0]!, { Status: 'Out for delivery', Local_Carrier: '', Local_Number: '', Country_code: 'BE' });
    relayed.data[0]!.Detail = [
      { Occur_date: '2026-11-12 05:59:00', Status: 'ND', Comment: 'Out for delivery (On the way)', track_area: 'Sample Town' },
      { Occur_date: '2026-11-09 16:03:00', Status: 'CB', Comment: 'Outgoing scan at facility', track_area: 'Sample Depot' },
      { Occur_date: '2026-11-09 15:57:00', Status: 'CA', Comment: 'Incoming scan at facility', track_area: 'Sample Depot' },
      { Occur_date: '2026-11-09 15:25:38', Status: 'JY', Comment: 'Has been given to local carrier', track_area: 'NL' },
      { Occur_date: '2026-11-07 13:16:44', Status: 'LD', Comment: 'Arrived at destination airport', track_area: 'NL' },
      { Occur_date: '2026-11-01 04:39:00', Status: 'DF', Comment: 'Departed from origin facility', track_area: 'SHENZHEN' },
      { Occur_date: '2026-10-31 08:25:00', Status: '', Comment: 'Processed', track_area: 'Sample Depot' },
      { Occur_date: '2026-10-31 08:25:00', Status: '', Comment: 'Shipment Data Uploaded', track_area: 'Sample Depot' },
      { Occur_date: '2026-10-29 16:04:16', Status: 'IR', Comment: 'Shipment information received', track_area: '' },
    ];
    const result = parseHuahan(relayed, NUMBER);
    // bpost dated the round's start at 12:59 in Brussels and Landmark's record of the data at 14:25.
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_update: '2026-11-12T05:59:00-06:00' });
    expect(result.events!.map(event => event.time ?? event.local_time)).toEqual(['2026-11-12T05:59:00-06:00',
      '2026-11-09T16:03:00-06:00', '2026-11-09T15:57:00-06:00', '2026-11-09T15:25:38', '2026-11-07T13:16:44',
      '2026-11-01T04:39:00', '2026-10-31T08:25:00-05:00', '2026-10-31T08:25:00-05:00', '2026-10-29T16:04:16']);
    expect(result.events![0]).toMatchObject({ local_time: '2026-11-12T05:59:00', time_zone: 'America/Chicago', time_zone_basis: 'carrier' });
    // Landmark's processing of the data, at the minute of its upload and before HuaHan's receipt, moves nothing,
    // and neither row names a place the parcel has been.
    expect(result.events!.slice(6, 8)).toEqual([
      expect.objectContaining({ description: 'Processed', stage: 'registered', stage_source: 'none' }),
      expect.objectContaining({ description: 'Shipment Data Uploaded', stage: 'registered', stage_source: 'carrier_map' }),
    ]);
    for (const event of result.events!.slice(6, 8)) expect(event).not.toHaveProperty('location');
    // Without Landmark's own words, a destination of one zone places the relayed scans, and nothing before the hand-off.
    relayed.data[0]!.Detail = relayed.data[0]!.Detail.filter(scan => !/scan at facility|data uploaded/i.test(scan.Comment));
    expect(parseHuahan(relayed, NUMBER).events!.map(event => event.time ?? event.local_time)).toEqual(['2026-11-12T05:59:00+01:00',
      '2026-11-09T15:25:38', '2026-11-07T13:16:44', '2026-11-01T04:39:00', '2026-10-31T08:25:00', '2026-10-29T16:04:16']);
  });

  it('reads the destination post\'s posting of the parcel after the hand-off as a hand-over on the way, not the acceptance', () => {
    const posted = fixture();
    Object.assign(posted.data[0]!, { Status: 'In transport', Local_Carrier: '', Local_Number: '', Country_code: 'PL' });
    posted.data[0]!.Detail = [
      { Occur_date: '2026-11-10 03:42:00', Status: 'CA', Comment: 'In transport', track_area: '' },
      { Occur_date: '2026-11-09 20:41:00', Status: 'IA', Comment: 'Posting/collection', track_area: 'Exampletown' },
      { Occur_date: '2026-11-07 07:10:52', Status: 'JY', Comment: 'Has been given to local carrier', track_area: 'NL' },
      { Occur_date: '2026-11-06 14:27:30', Status: 'YG', Comment: 'Import Customs clearance completed', track_area: 'NL' },
      { Occur_date: '2026-11-02 10:29:34', Status: 'DF', Comment: 'Departed from origin facility', track_area: 'SHENZHEN' },
      { Occur_date: '2026-11-02 08:29:34', Status: 'AF', Comment: 'Arrived at origin facility', track_area: 'SHENZHEN' },
    ];
    const events = parseHuahan(posted, NUMBER).events!;
    expect(events[1]).toMatchObject({ description: 'Posting/collection', stage: 'in_transit', stage_source: 'carrier_map' });
    // HuaHan's own receipt before the hand-off stays its acceptance.
    expect(events[5]).toMatchObject({ description: 'Arrived at origin facility', stage: 'accepted' });
  });

  it('reads CTT Express\'s relayed notice of the parcel coming on Madrid\'s clock, before the hand-off', () => {
    const notice = fixture();
    Object.assign(notice.data[0]!, { Status: 'Departed from origin facility', Local_Carrier: 'CTT Express', Country_code: 'ES' });
    notice.data[0]!.Detail = [
      { Occur_date: '2026-01-03 04:20:23', Status: 'DF', Comment: 'Departed from origin facility', track_area: 'SHENZHEN' },
      { Occur_date: '2026-01-02 04:47:04', Status: 'AF', Comment: 'Arrived at origin facility', track_area: 'SHENZHEN' },
      { Occur_date: '2026-01-01 21:51:00', Status: '', Comment: 'Pendiente de recepción en CTT Express', track_area: '' },
      { Occur_date: '2026-01-01 14:51:15', Status: 'IR', Comment: 'Shipment information received', track_area: '' },
    ];
    const events = parseHuahan(notice, NUMBER).events!;
    expect(events[2]).toMatchObject({ local_time: '2026-01-01T21:51:00', time: '2026-01-01T21:51:00+01:00',
      time_zone: 'Europe/Madrid', time_zone_basis: 'carrier', stage: 'registered' });
    expect(events.filter(event => event.time)).toHaveLength(1);
    notice.data[0]!.Detail = notice.data[0]!.Detail.slice(2);
    expect(parseHuahan(notice, NUMBER)).toMatchObject({ last_update: '2026-01-01T21:51:00+01:00', current_stage: 'registered' });
    // CTT Express's Spanish notice keeps Madrid's clock on a parcel bound for Portugal too: read so, it fell minutes after
    // HuaHan's arrival scan, as on parcels bound for Spain, and an hour later on Lisbon's.
    notice.data[0]!.Country_code = 'PT';
    expect(parseHuahan(notice, NUMBER)).toMatchObject({ last_update: '2026-01-01T21:51:00+01:00' });
  });

  it('reads DHL Paket\'s rows relayed before the hand-off on Germany\'s clock', () => {
    const relayed = fixture();
    Object.assign(relayed.data[0]!, { Status: 'Flight departures', Local_Carrier: 'DHL', Country_code: 'DE' });
    relayed.data[0]!.Detail = [
      { Occur_date: '2026-01-04 17:30:00', Status: '', Comment: 'Flight departures', track_area: '' },
      { Occur_date: '2026-01-02 13:40:00', Status: '', Comment: 'The shipment is in transit to DHL', track_area: '' },
      { Occur_date: '2026-01-02 00:51:00', Status: '', Comment: 'The instruction data for this shipment have been provided by the sender to DHL electronically', track_area: '' },
      { Occur_date: '2026-01-01 23:10:00', Status: 'AF', Comment: 'Arrived at origin facility', track_area: 'SHENZHEN' },
    ];
    const events = parseHuahan(relayed, NUMBER).events!;
    expect(events.map((event) => event.time ?? null)).toEqual([null, '2026-01-02T13:40:00+01:00', '2026-01-02T00:51:00+01:00', null]);
    expect(events[1]).toMatchObject({ local_time: '2026-01-02T13:40:00', time_zone: 'Europe/Berlin', time_zone_basis: 'carrier' });
  });

  it('reads the flight, clearance and destination milestones by their codes', () => {
    const journey = fixture();
    journey.data[0]!.Detail = [
      { Occur_date: '2026-01-09 12:15:00', Status: 'CC', Comment: 'Delivered, Parcel was delivered successfully', track_area: '' },
      { Occur_date: '2026-01-09 05:44:00', Status: 'CB', Comment: 'Out for Delivery, Parcel is at courier, delivery expected soon.', track_area: '' },
      { Occur_date: '2026-01-07 20:38:00', Status: 'IA', Comment: 'In Transit', track_area: '' },
      { Occur_date: '2026-01-06 14:03:50', Status: 'YG', Comment: 'Import Customs clearance completed', track_area: 'NL' },
      { Occur_date: '2026-01-06 09:34:00', Status: 'LD', Comment: 'Arrived at destination airport', track_area: 'NL' },
      { Occur_date: '2026-01-06 06:34:00', Status: 'QG', Comment: 'Import Customs clearance started', track_area: 'NL' },
      { Occur_date: '2026-01-05 16:35:58', Status: 'QF', Comment: 'Departed from airport of Origin', track_area: 'HK' },
      { Occur_date: '2026-01-05 12:09:12', Status: 'AP', Comment: 'Received by airport of Origin', track_area: 'HK' },
      { Occur_date: '2026-01-03 12:54:49', Status: 'BG', Comment: 'Export customs clearance completed', track_area: 'HK' },
      { Occur_date: '2026-01-03 06:54:41', Status: 'GG', Comment: 'Transfer to Origin airport', track_area: 'CN' },
    ];
    const result = parseHuahan(journey, NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit',
      'in_transit', 'in_transit', 'customs', 'in_transit', 'in_transit', 'in_transit', 'in_transit']);
    expect(result.events!.filter(event => event.stage_source === 'carrier_map').map(event => event.provider_code))
      .toEqual(['CC', 'CB', 'IA', 'YG', 'LD', 'QG', 'QF', 'AP', 'BG', 'GG']);
  });

  it('keeps the destination carrier\'s placed line for a scan also listed in generic words', () => {
    const twice = fixture();
    twice.data[0]!.Detail = [
      { Occur_date: '2026-01-09 12:15:00', Status: 'CC', Comment: 'Delivered, Parcel was delivered successfully', track_area: '' },
      { Occur_date: '2026-01-09 12:15:00', Status: 'CC', Comment: 'The parcel has been successfully delivered.', track_area: 'Sample Town' },
      { Occur_date: '2026-01-09 05:44:00', Status: 'CB', Comment: 'Out for Delivery, Parcel is at courier, delivery expected soon.', track_area: '' },
      { Occur_date: '2026-01-09 05:44:00', Status: '', Comment: 'A courier has the parcel.', track_area: 'Sample Town' },
      { Occur_date: '2026-01-08 20:41:00', Status: 'IA', Comment: 'In Transit', track_area: '' },
      { Occur_date: '2026-01-08 20:38:00', Status: 'IA', Comment: 'In Transit', track_area: '' },
      { Occur_date: '2026-01-08 20:38:00', Status: 'IA', Comment: 'The parcel is in the central warehouse waiting to be processed.', track_area: 'Sample Hub' },
      { Occur_date: '2026-01-08 20:38:00', Status: 'IA', Comment: 'The parcel was sorted.', track_area: 'Sample Hub' },
      { Occur_date: '2026-01-06 14:03:50', Status: 'YG', Comment: 'Import Customs clearance completed', track_area: 'NL' },
    ];
    const result = parseHuahan(twice, NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'The parcel has been successfully delivered.' });
    expect(result.events!.map(event => [event.local_time, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-01-09T12:15:00', 'The parcel has been successfully delivered.', 'CC', 'delivered'],
      ['2026-01-09T05:44:00', 'A courier has the parcel.', 'CB', 'out_for_delivery'],
      ['2026-01-08T20:41:00', 'In Transit', 'IA', 'in_transit'],
      // Two placed lines at the generic line's minute: none of them is its copy.
      ['2026-01-08T20:38:00', 'In Transit', 'IA', 'in_transit'],
      ['2026-01-08T20:38:00', 'The parcel is in the central warehouse waiting to be processed.', 'IA', 'in_transit'],
      ['2026-01-08T20:38:00', 'The parcel was sorted.', 'IA', 'in_transit'],
      ['2026-01-06T14:03:50', 'Import Customs clearance completed', 'YG', 'in_transit'],
    ]);
  });

  it('keeps pickup-point arrival distinct from delivery to the recipient', () => {
    const pickup = fixture();
    pickup.data[0]!.Status = 'Available for collection';
    pickup.data[0]!.Detail[0]!.Status = 'PB';
    pickup.data[0]!.Detail[0]!.Comment = 'The parcel has arrived at the delivery point.';
    const result = parseHuahan(pickup, NUMBER);
    expect(result.current_stage).toBe('ready_for_pickup');
    expect(result.events![0]).toMatchObject({ stage: 'ready_for_pickup', stage_source: 'carrier_map' });
  });

  it('preserves blocked, missing-route and rate-limit failures without session diagnostics', async () => {
    for (const [status, body, kind] of [[200, '<html>Verification</html>', 'challenge'], [401, '{}', 'challenge'],
      [404, 'missing', 'transport'], [429, 'PRIVATE', 'rate_limited']] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { status }));
      const failure = await new HuahanTracker({ fetcher: fetch }).fetch(NUMBER).catch(error => error);
      expect(failure.kind).toBe(kind);
      expect(failure.diagnostics).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses unsupported numbers and respects cancellation before requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tracker = new HuahanTracker({ fetcher: fetch });
    await expect(tracker.fetch('HHWAA0000000001YQ,HHWAA0000000002YQ')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(tracker.fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('HuaHan status map', () => {
  it('reads its milestones a tracking provider relays under the provider\'s own codes by their words', () => {
    const relayed: [string, string, Stage][] = [
      ['InfoReceived', 'Shipment information received', 'registered'],
      ['InTransit_PickedUp', 'Arrived at origin facility', 'accepted'],
      ['InTransit_Other', 'Departed from origin facility', 'in_transit'],
      ['InTransit_Other', 'Transfer to Origin airport', 'in_transit'],
      ['InTransit_Other', 'Export customs clearance completed', 'in_transit'],
      ['InTransit_Departure', 'Departed from airport of Origin', 'in_transit'],
      ['InTransit_CustomsProcessing', 'Import Customs clearance started', 'customs'],
      ['InTransit_CustomsReleased', 'Import Customs clearance completed', 'in_transit'],
      ['InTransit_Other', 'Has been given to local carrier', 'in_transit'],
    ];
    for (const [code, wording, stage] of relayed) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: code, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    // HuaHan's own codes give the stage; one the map does not list is not read by its words.
    expect(statusMapAnswer({ carrier: 'huahan', providerCode: 'DF', description: 'Departed from origin facility' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'huahan', providerCode: 'ZZ', description: 'Departed from origin facility' })).toEqual({ kind: 'unknown' });
    // The destination carrier's address change, relayed without a code after the hand-off.
    expect(statusMapAnswer({ carrier: 'huahan', providerCode: null, description: 'Change of delivery address' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // Its transfer warehouse collecting the parcel after the departure from the origin facility and shipping it out.
    for (const description of ['Parcel has been collected.', 'Parcel has been shipped out of the warehouse.']) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: null, description }), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    // China Post's scans on the postal line, offices in 【】, and the destination post's as China Post copies them.
    for (const [code, description, stage] of [
      [null, '中国邮政已收取邮件', 'in_transit'],
      [null, '邮件到达【示例市国际互换局】', 'in_transit'],
      [null, '邮件离开【示例市国际互换局】，正在发往下一站', 'in_transit'],
      [null, '送交出口海关', 'customs'],
      ['DR', '到达寄达地处理中心', 'in_transit'],
      [null, '境外进口海关留存待验(等待提交给边境机构/安全部门)', 'customs'],
      [null, '境外进口互换局留存', 'customs'],
      ['IA', '寄达地海关允许进口（无需缴税）', 'in_transit'],
      [null, '离开【加拿大】处理中心', 'in_transit'],
      ['CA', '已到达【加拿大】投递局', 'in_transit'],
      [null, '【加拿大】安排投递', 'out_for_delivery'],
      [null, '【加拿大】已妥投', 'delivered'],
    ] as const) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: code, description }), description).toEqual({ kind: 'mapped', stage });
    }
    // CTT Express's pre-advice, relayed without a code before HuaHan's receipt in China.
    expect(statusMapAnswer({ carrier: 'huahan', providerCode: null, description: 'Pendiente de recepción en CTT Express' })).toEqual({ kind: 'mapped', stage: 'registered' });
    expect(huahanStage('', 'Pendiente de recepción en CTT Express')).toEqual({ stage: 'registered', source: 'carrier_map' });
    // DHL's record of the sender's data, with its full stop or without, and the order's data in Chinese, relayed without a code.
    for (const description of ['The instruction data for this shipment have been provided by the sender to DHL electronically.',
      'The instruction data for this shipment have been provided by the sender to DHL electronically', '货物电子信息已经收到']) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: null, description }), description).toEqual({ kind: 'mapped', stage: 'registered' });
      expect(huahanStage('', description), description).toEqual({ stage: 'registered', source: 'carrier_map' });
    }
    // The destination carrier's hub and trunk route under IA, by their words.
    for (const description of ['In Transit, Arrived to HU HUB', 'In Transit, Parcel has entered the Linehaul network.']) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: 'IA', description }), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    // DPD's depot inbound after the hand-off moves the parcel on; HuaHan accepted it in China.
    for (const description of ['In Transit, Picked Up | Einrollung', 'In Transit, At parcel delivery centre.']) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: 'IA', description }), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
      expect(huahanStage('IA', description)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    }
    // DPD's depot scans under CA are read by their words, like IA's.
    expect(statusMapAnswer({ carrier: 'huahan', providerCode: 'CA', description: 'In Transit, Scanned By DPD At parcel delivery centre.' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it('reads USPS\'s relayed facility scans by their words, even under its last-step codes', () => {
    for (const [code, description, stage] of [
      [null, 'Pre-Shipment Info Sent to USPS, USPS Awaiting Item', 'registered'],
      [null, 'Shipping Label Created', 'registered'],
      [null, 'Shipping Label Created, USPS Awaiting Item', 'registered'],
      ['ND', 'Accepted at USPS Facility, EXAMPLE CITY, CA 90000', 'in_transit'],
      ['ND', 'Arrived at USPS Facility, EXAMPLE CITY, CA 90000', 'in_transit'],
      ['ND', 'In Transit to Next Facility, ', 'in_transit'],
      ['ND', 'In Transit, Arriving On Time, ', 'in_transit'],
      // HuaHan puts its out-for-delivery code on USPS's departure from a distribution centre.
      ['CB', 'Departed USPS Facility, EXAMPLE CITY IL DISTRIBUTION CENTER', 'in_transit'],
      ['CB', 'Out for Delivery', 'out_for_delivery'],
      ['PB', 'Available for Pickup', 'ready_for_pickup'],
      ['CC', 'Delivered, In/At Mailbox', 'delivered'],
    ] as const) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: code, description }), description).toEqual({ kind: 'mapped', stage });
      expect(huahanStage(code ?? '', description), description).toEqual({ stage, source: 'carrier_map' });
    }
  });

  it("reads an American courier's scans after the hand-off by their words, its facility named by its code too", () => {
    for (const [code, description, stage] of [
      ['IA', 'Parcel departed from Facility.', 'in_transit'],
      [null, 'Parcel received by EXA01.', 'in_transit'],
      [null, 'Parcel received by local Facility.', 'in_transit'],
      [null, 'Parcel is out for delivery.', 'out_for_delivery'],
    ] as const) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: code, description }), description).toEqual({ kind: 'mapped', stage });
      expect(huahanStage(code ?? '', description), description).toEqual({ stage, source: 'carrier_map' });
    }
  });

  it('reads a destination post\'s posting after the hand-off as transit and its rounds under FI by their words', () => {
    for (const [code, description, stage] of [
      [null, 'Parcel departed from facility to service provider.', 'in_transit'],
      [null, 'The goods are clearing customs', 'customs'],
      // HuaHan accepted the parcel in China: the post's posting record takes it on.
      ['IA', 'Posting/collection', 'in_transit'],
      ['IA', 'Departure to country of destination', 'in_transit'],
      [null, 'Arrival from abroad', 'in_transit'],
      ['CA', 'In transport', 'in_transit'],
      ['FI', 'Unsuccessful (physical) delivery', 'failed_attempt'],
      ['FI', 'Not Delivered - addressee not present- message left', 'failed_attempt'],
    ] as const) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: code, description }), description).toEqual({ kind: 'mapped', stage });
      expect(huahanStage(code ?? '', description), description).toEqual({ stage, source: 'carrier_map' });
    }
  });

  it('reads Landmark Global\'s relayed depot scans by their words, its departure under CB as transit', () => {
    for (const [code, description, stage] of [
      [null, 'Shipment Data Uploaded', 'registered'],
      ['CA', 'Incoming scan at facility', 'in_transit'],
      // HuaHan puts its out-for-delivery code on the depot's departure, days before a round.
      ['CB', 'Outgoing scan at facility', 'in_transit'],
      ['ND', 'Out for delivery (On the way)', 'out_for_delivery'],
      [null, 'Delivery attempt (Delivery not possible)', 'failed_attempt'],
    ] as const) {
      expect(statusMapAnswer({ carrier: 'huahan', providerCode: code, description }), description).toEqual({ kind: 'mapped', stage });
      expect(huahanStage(code ?? '', description), description).toEqual({ stage, source: 'carrier_map' });
    }
    // Its processing of the sender's data at the minute of the upload is a notice.
    expect(statusMapAnswer({ carrier: 'huahan', providerCode: null, description: 'Processed' }))
      .toMatchObject({ kind: 'intentional_gap', note: expect.stringMatching(/keeps the stage/) });
    expect(huahanStage('', 'Processed')).toBeNull();
  });
});
