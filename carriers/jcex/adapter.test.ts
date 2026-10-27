import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, JCEX_API, JcexTracker } from './adapter.js';
import { normalizeJcexNumber, parseJcex } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'JCZ9900000001DH';
const HANDED_OVER = 'JCZ9900000002DH';
const RELAYED = 'JCZ9900000003DH';
const UNKNOWN = 'JCZ9999999999DH';
const READ = Date.parse('2026-05-01T00:00:00Z');

type Row = Record<string, unknown>;
type Content = Row & { trackDetails: Row[] };
type Envelope = { code: unknown; msg: unknown; data: { number: unknown; content: Content }[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Envelope;
const changed = (name: string, change: (content: Content, envelope: Envelope) => void) => {
  const envelope = fixture(name);
  change(envelope.data[0]!.content, envelope);
  return envelope;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('JCEX numbers', () => {
  it('claims JCZ, ten digits and DH, and nothing shorter, longer or under another affix', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'jcex', confidence: 'high', candidates: ['jcex'] });
    for (const other of ['JCZ990000001DH', 'JCZ99000000011DH', 'JCX9900000001DH', 'JCZ9900000001DE', 'XJCZ9900000001DH', 'JCZ9900000001DHX']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('jcex');
    }
  });

  it('reads the number out of a link to its tracker', () => {
    for (const link of [`https://track.jcex.com/?nums=${NUMBER}`, `https://track.jcex.com?nums=${NUMBER}`]) {
      expect(parseTrackingInput(link)).toMatchObject({ trackingNumber: NUMBER, carrier: 'jcex' });
    }
  });
});

describe('JCEX HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JcexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jcz-9900-0000-01dh ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(JCEX_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://track.jcex.com', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ numberList: [NUMBER] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jcex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates a scan on its place’s clock and keeps the clocks no place settles', () => {
    const result = parseJcex(fixture('delivered'), NUMBER, READ);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-04-20T10:05:00-05:00', delivered_at: '2026-04-20T10:05:00-05:00',
      expected_delivery: null, destination_country: 'US' });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code ?? null, event.stage, event.location ?? null])).toEqual([
      ['2026-04-20T10:05:00-05:00', 'Delivered_Other', 'delivered', 'EXAMPLE, MO'],
      ['2026-04-20T06:44:00-05:00', 'OutForDelivery_Other', 'out_for_delivery', 'EXAMPLE, MO'],
      ['2026-04-20T06:33:00-05:00', 'InTransit_Other', 'in_transit', 'EXAMPLE, MO'],
      ['2026-04-18T13:07:00-05:00', 'InTransit_Other', 'in_transit', 'EXAMPLE CITY KS DISTRIBUTION CENTER'],
      ['2026-04-18T04:10:00-05:00', null, 'in_transit', 'EXAMPLE TOWN IL DISTRIBUTION CENTER'],
      // The United States keeps several clocks, and these rows name no state.
      ['2026-04-17T11:10:00', 'InTransit_Other', 'in_transit', 'US'],
      ['2026-04-17T02:23:58', 'InTransit_CustomsReleased', 'in_transit', 'US'],
      ['2026-04-16T13:19:52', 'InTransit_CustomsProcessing', 'customs', 'US'],
      // The Hong Kong hub's rows carry the destination's offset, which Hong Kong does not keep.
      ['2026-04-15T13:47:40', null, 'in_transit', 'HK'],
      // The timeline JCEX wrote after the receipt, on :21 every time, is set aside.
      // The origin warehouse's receipt, which the shared rules would read as a parcel waiting for collection; it comes twice.
      ['2026-04-11T01:09:38+08:00', 'InTransit_Other', 'in_transit', 'CN'],
      // JCEX's order data, filed under neither a country nor a place, is on Beijing's clock.
      ['2026-04-08T12:01:25+08:00', 'InfoReceived', 'registered', null],
    ]);
    // The recipient's city and postcode and the shipment's reference are never read.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLEVILLE|99999|9900000000001/);
  });

  it('reads the handover to the delivering partner as transit and orders the rows by their clocks', () => {
    const result = parseJcex(fixture('handed-over'), HANDED_OVER, Date.parse('2026-11-01T00:00:00Z'));
    expect(result).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_update: null, last_update_local: '2026-10-19T13:00:46', destination_country: 'FR' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.provider_code, event.stage, event.location ?? null])).toEqual([
      // Colissimo's rows keep France's wall clock: JCEX gives them China's offset.
      ['2026-10-19T13:00:46', 'Exception_Other', 'failed_attempt', 'FR'],
      ['2026-10-19T08:34:41', 'OutForDelivery_Other', 'out_for_delivery', 'FR'],
      ['2026-10-17T15:39:42', 'InTransit_Other', 'in_transit', 'FR'],
      // JCEX lists its handover first and files it as delivered.
      ['2026-10-17T14:47:28', 'Delivered_Other', 'in_transit', 'Exampleville, FR'],
      ['2026-10-17T07:47:40', 'InTransit_Other', 'in_transit', null],
      ['2026-10-16T22:22:29+08:00', 'InTransit_Departure', 'in_transit', 'SH, CN'],
      ['2026-10-09T09:14:17+08:00', 'InTransit_Departure', 'in_transit', 'SH, CN'],
      ['2026-10-07T19:55:12+08:00', 'InTransit_PickedUp', 'accepted', 'GUANG ZHOU'],
      ['2026-10-06T10:21:14+08:00', 'InfoReceived', 'registered', null],
      // Colissimo's announcement, at the time JCEX received the order on France's clock.
      ['2026-10-06T04:21:14', 'InTransit_Other', 'registered', 'FR'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLEVILLE|99999|XYZ0000000001|00000"/);
  });

  it('counts a delivered code only with wording that reads as a delivery', () => {
    const handover = parseJcex(changed('handed-over', (content) => {
      content.trackDetails.splice(1, 3);
      content.trackDetails[0]!.eventDetailEn = 'Handed to the last-mile carrier';
    }), HANDED_OVER, Date.parse('2026-11-01T00:00:00Z'));
    expect(handover.events![0]).toMatchObject({ provider_code: 'Delivered_Other', description: 'Handed to the last-mile carrier' });
    expect(handover.current_stage).not.toBe('delivered');
    expect(statusMapAnswer({ carrier: 'jcex', providerCode: 'Delivered_Other', description: 'Handed to the last-mile carrier' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'jcex', providerCode: 'Delivered_Other', description: 'Delivered, in mailbox' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });

  it('keeps a wall clock whose offset its place does not have then', () => {
    const result = parseJcex(changed('delivered', (content) => {
      content.trackDetails[3]!.timeZone = '-06:00';
      content.trackDetails[12]!.timeZone = '-05:00';
      content.trackDetails[13]!.timeZone = '-05:00';
      content.trackDetails[0]!.timeZone = '+05:00';
    }), NUMBER, READ);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2026-04-20T10:05:00' });
    expect(result.delivered_at).toBeUndefined();
    expect([0, 3, 9].map((index) => result.events![index]!.local_time)).toEqual(['2026-04-20T10:05:00', '2026-04-18T13:07:00', '2026-04-11T01:09:38']);
  });

  it('drops the copies JCEX dates on Beijing\'s clock and keeps the offsets of the scans it relays', () => {
    const departed = 'Package has departed from a particular location in carrier network.';
    const label = 'Package has been created and is ready for pickup at the shippers location. This is a pre-transit status event code.';
    const result = parseJcex(fixture('relayed'), RELAYED, Date.parse('2026-10-01T00:00:00Z'));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-09-22T09:15:20Z',
      delivered_at: '2026-09-22T09:15:20Z', destination_country: 'IT' });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.description, event.location ?? null])).toEqual([
      // The partner's scans keep UTC, wherever their place and country.
      ['2026-09-22T09:15:20Z', 'Delivered', 'SAMPLECITY, IT'],
      ['2026-09-22T06:40:10Z', 'Package is out for delivery.', 'IT, Sampleville, Lazio'],
      // JCEX's copies go: under China's offset at the same instant, under Italy's six hours late.
      ['2026-09-22T00:30:05Z', 'Consignment Received At Transit Point', 'IT, Sampleville, Lazio'],
      ['2026-09-20T19:12:44Z', departed, 'IT, Exampletown, Lombardy'],
      // Yanwen's scans in the destination keep its offset, and its words rather than JCEX's.
      ['2026-09-20T15:40:31+01:00', 'Batch delivery to carrier', null],
      ['2026-09-18T12:05:00+01:00', 'Port of destination - Arrival', null],
      // A scan both list on Beijing's clock stays in both words.
      ['2026-09-17T23:30:00+08:00', 'Port of departure - Departure', 'SH, CN'],
      ['2026-09-17T23:30:00+08:00', 'Depart from international airport', 'CN'],
      // The partner prints its label seconds after JCEX takes the order in.
      ['2026-09-16T14:10:02Z', label, null],
      ['2026-09-16T22:09:56+08:00', 'Processing information input', null],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLEVILLE|99999|XYZ0000000003|00000"/);
  });

  it('keeps a copy\'s offset when JCEX lists no scan it copies', () => {
    const result = parseJcex(changed('relayed', (content) => {
      content.trackDetails = content.trackDetails.filter((row) => row.timeZone !== '+00:00');
    }), RELAYED, Date.parse('2026-10-01T00:00:00Z'));
    expect(result.events!.slice(0, 2).map((event) => [event.time ?? null, event.local_time ?? null, event.description])).toEqual([
      ['2026-09-22T08:30:05+08:00', null, 'Consignment Received At Transit Point'],
      ['2026-09-21T03:12:44+02:00', null, 'Package has departed from a particular location in carrier network.'],
    ]);
  });

  it('reads JCEX\'s order data on Beijing\'s clock, whatever offset it carries', () => {
    const result = parseJcex(changed('delivered', (content) => { content.trackDetails.at(-1)!.timeZone = '-05:00'; }), NUMBER, READ);
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-04-08T12:01:25+08:00', provider_code: 'InfoReceived' });
  });

  it('holds back rows written ahead of their time', () => {
    const result = parseJcex(fixture('delivered'), NUMBER, Date.parse('2026-04-19T00:00:00Z'));
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: '2026-04-18T13:07:00-05:00' });
    expect(result.events).toHaveLength(8);
  });

  it('sets aside the timeline JCEX writes once it takes a parcel in, and names it when nothing else is left', () => {
    // Seconds after the receipt, two rows at once, then rows a whole number of six minutes apart on the same second.
    const written: [string, string, string][] = [
      ['2026-04-11 01:09:45', 'Departed from sort facility', 'InTransit_Other'],
      ['2026-04-11 01:09:45', 'Picked up by shipping partner', 'InTransit_Other'],
      ['2026-04-11 13:45:45', 'Hand over to airline', 'InTransit_Other'],
      ['2026-04-12 03:15:45', 'Departed from origin country', 'InTransit_Departure'],
    ];
    const rows = (content: Content) => written.map(([eventTime, eventDetailEn, platformEventCode]) =>
      ({ ...content.trackDetails[12]!, eventTime, eventDetailEn, platformEventCode }));
    const result = parseJcex(changed('delivered', (content) => {
      content.trackDetails.splice(9, 3, ...rows(content));
    }), NUMBER, Date.parse('2026-04-13T00:00:00Z'));
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Arrive at the delivery point', last_update: '2026-04-11T01:09:38+08:00' });
    // Two such rows, or rows whose spacing breaks the six minutes, stay.
    const kept = parseJcex(changed('delivered', (content) => {
      content.trackDetails.splice(9, 3, ...rows(content).slice(1, 3), { ...rows(content)[3]!, eventTime: '2026-04-12 03:16:45' });
    }), NUMBER, Date.parse('2026-04-13T00:00:00Z'));
    expect(kept.events!.slice(0, 3).map((event) => event.description)).toEqual(['Departed from origin country', 'Hand over to airline', 'Picked up by shipping partner']);
    let error: unknown;
    try {
      parseJcex(changed('delivered', (content) => {
        content.trackDetails.splice(0, content.trackDetails.length, ...rows(content));
      }), NUMBER, Date.parse('2026-04-13T00:00:00Z'));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ name: 'NoHistoryError', reason: 'written_ahead',
      writtenAhead: ['2026-04-11T01:09:45+08:00', '2026-04-11T13:45:45+08:00', '2026-04-12T03:15:45+08:00'] });
  });

  it('reads a row without a code by its wording, and one with a code the map lacks by the shared rules', () => {
    const result = parseJcex(changed('delivered', (content) => {
      content.trackDetails[0]!.platformEventCode = 'Synthetic_Other';
      content.trackDetails[1]!.eventDetailEn = '';
    }), NUMBER, READ);
    expect(result.events![0]).toMatchObject({ provider_code: 'Synthetic_Other', stage: 'delivered', stage_source: expect.stringMatching(/^wording/) });
    // Without its English text the row reads in Chinese.
    expect(result.events![1]).toMatchObject({ description: '正在派送', stage: 'out_for_delivery', stage_source: 'carrier_map' });
  });

  it('counts a shipment only when the number asked is its own', () => {
    expect(() => parseJcex(fixture('delivered'), UNKNOWN, READ)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJcex(changed('delivered', (content) => { content.orderNumber = UNKNOWN; content.waybillNumber = UNKNOWN; }), NUMBER, READ))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJcex(changed('delivered', (_content, envelope) => { envelope.data.push(envelope.data[0]!); }), NUMBER, READ))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The order number alone binds it.
    expect(parseJcex(changed('delivered', (content) => { content.waybillNumber = null; }), NUMBER, READ)).toMatchObject({ current_stage: 'delivered' });
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (content: Content) => { content.trackDetails[0]!.eventTime = '2026-04-20 10:05'; },
      (content: Content) => { content.trackDetails[0]!.eventTime = '2026-02-30 10:05:00'; },
      (content: Content) => { content.trackDetails[0]!.eventTime = '2026-04-20 24:00:00'; },
      (content: Content) => { content.trackDetails[0]!.eventDetailEn = { en: 'Delivered' }; },
      (content: Content) => { content.trackDetails[0] = 'Delivered' as never; },
      (content: Content) => { content.trackDetails = {} as never; },
      (content: Content) => { content.trackDetails = Array.from({ length: 501 }, () => content.trackDetails[0]!); },
      (content: Content) => { content.waybillNumber = [NUMBER] as never; },
      (_content: Content, envelope: Envelope) => { envelope.data[0]!.content = NUMBER as never; },
      (_content: Content, envelope: Envelope) => { envelope.data = {} as never; },
    ]) {
      expect(() => parseJcex(changed('delivered', change), NUMBER, READ)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    // A shipment without its numbers that is not the unknown-number answer.
    expect(() => parseJcex(changed('delivered', (content) => { content.orderNumber = null; content.waybillNumber = null; }), NUMBER, READ))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a waybill without scans, a refused lookup and a browser check apart', async () => {
    const lookup = (body: unknown, number = UNKNOWN, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
    await expect(lookup(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('no-scans'), NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
    await expect(lookup({ ...fixture('not-found'), code: 500, msg: '系统繁忙' })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=0"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>JCEX</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', UNKNOWN, { status: 302, headers: { Location: 'https://track.jcex.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    // The route answers every number: without it, the service moved.
    await expect(lookup('', UNKNOWN, { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('rejects numbers JCEX does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['JCZ990000001DH', 'JCZ99000000011DH', 'JCZ9900000001D1', 'JCZ9900000001DH-1', 'JCX9900000001DH', '9400100000000000000000']) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeJcexNumber('jcz 9900.0000.01 dh')).toBe(NUMBER);
  });

  it('sends a read that failed to reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a hanging read inside the caller’s budget', async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    // A busy runner can spend the budget before the request starts; a request that did start was aborted.
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('routes a JCEX waybill to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'jcex', source: 'jcex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === JCEX_API)).toBe(true);
  });
});

describe('JCEX status vocabulary', () => {
  it('records every row the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code ?? null : null;
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording))).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'jcex', providerCode: code ?? '', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // The code decides, whatever the wording.
    expect(statusMapAnswer({ carrier: 'jcex', providerCode: 'InTransit_Other', description: 'Synthetic note' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'jcex', providerCode: 'Exception_Returned', description: 'Synthetic note' })).toEqual({ kind: 'mapped', stage: 'returned' });
    expect(statusMapAnswer({ carrier: 'jcex', providerCode: 'SYNTHETIC', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
