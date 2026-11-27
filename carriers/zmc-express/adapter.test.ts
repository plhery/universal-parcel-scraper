import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { relayedWordingStage, statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { carrierTrackingNumber, formatTrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ZMC_LOOKUP, ZMC_PAGE } from './adapter.js';
import { zmcReference } from './number.js';
import { normalizeZmcNumber, parseZmc } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample, and the other reference its rows join to it.
const SAMPLE = 'A13477-12-2536003', OTHER = '21139034-14830421';
const INVENTED = 'Z90817-03-7316594';

type Row = Record<string, string | null>;
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const rows = () => JSON.parse(raw('delivered.json')) as Row[];
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The lookup labels its JSON as HTML.
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
/** The sample's rows, changed. */
const changed = (change: (rows: Row[]) => void) => {
  const body = rows();
  change(body);
  return body;
};

describe('ZMC Express references', () => {
  it('takes letters and digits with every hyphen, as the tracker does', () => {
    expect(normalizeZmcNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeZmcNumber('A13477 - 12 - 2536003')).toBe(SAMPLE);
    expect(normalizeZmcNumber('A13477–12—2536003')).toBe(SAMPLE);
    expect(normalizeZmcNumber('A13477--12-2536003-')).toBe(SAMPLE);
    expect(normalizeZmcNumber(OTHER)).toBe(OTHER);
    for (const other of ['', 'A-12', 'ABCDE-FGHIJ', 'A13477/12/2536003', 'A13477_12_2536003', `A${'1'.repeat(40)}`]) {
      expect(() => normalizeZmcNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps the hyphens when ZMC Express is the carrier, and only then', () => {
    expect(zmcReference(' a13477-12-2536003 ')).toBe(SAMPLE);
    expect(zmcReference('A13477122536003')).toBeUndefined();
    expect(carrierTrackingNumber(' a13477 -12-2536003 ', 'zmc-express')).toBe(SAMPLE);
    expect(directTrackingNumber('zmc-express', SAMPLE)).toBe(SAMPLE);
    expect(formatTrackingNumber(SAMPLE, 'zmc-express')).toBe(SAMPLE);
    expect(carrierTrackingNumber(SAMPLE, 'iqfulfillment')).toBe(SAMPLE);
    expect(carrierTrackingNumber(SAMPLE, 'danx')).toBe(normalizeTrackingNumber(SAMPLE));
    expect(carrierTrackingNumber(SAMPLE, undefined)).toBe('A13477122536003');
  });
});

describe('ZMC Express tracking adapter', () => {
  it('asks the lookup for the whole reference with the page’s source and a fresh random token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(raw('delivered.json')));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    await carrier(fetcher).track({ number: SAMPLE });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[0]!;
    const address = new URL(String(url));
    expect(`${address.origin}${address.pathname}`).toBe(ZMC_LOOKUP);
    expect(address.searchParams.get('cusRef')).toBe(SAMPLE);
    expect(address.searchParams.get('source')).toBe('system');
    expect(address.searchParams.get('random')).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('random')).not.toBe(address.searchParams.get('random'));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Referer: ZMC_PAGE }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'zmc-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s own answer for an unknown reference as not found', async () => {
    for (const body of [raw('not-found.txt'), 'error\n']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(body));
      await expect(carrier(fetcher).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
    }
  });

  it('keeps empty and malformed replies, error pages and redirects apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: INVENTED }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => reply(''))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('[]'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('{'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('"error"'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('<html><body>Error</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('<title>Just a moment...</title>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => reply('<title>Just a moment...</title>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => reply('{}', 429))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => reply('error', 500))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => reply('<title>504 Gateway Time-out</title>', 504))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://zmcexpress.com/' } }))).toMatchObject({ kind: 'transport' });
  });
});

describe('ZMC Express replies', () => {
  it('reads the sample: its scans newest first, each on the clock of the branch that wrote it', () => {
    const result = parseZmc(rows(), SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered successfully',
      last_update: '2023-01-14T15:37:07+03:00', delivered_at: '2023-01-14T15:37:07+03:00', expected_delivery: null, weight_kg: 3.5,
    });
    const scan = (event: Record<string, unknown>) => [event.local_time, event.description, event.location ?? null, event.provider_code, event.stage,
      event.time_zone, event.time_zone_basis];
    expect(result.events!.map(scan)).toEqual([
      // The delivery saved again two seconds later is one scan.
      ['2023-01-14T15:37:07', 'Delivered successfully', null, '440', 'delivered', 'Asia/Baghdad', 'carrier'],
      ['2023-01-11T17:21:49', 'Pending delivery | Duplicated order', null, '445', 'failed_attempt', 'Asia/Baghdad', 'carrier'],
      ['2023-01-11T15:56:44', 'On vehicle for delivery', null, '430', 'out_for_delivery', 'Asia/Baghdad', 'carrier'],
      ['2023-01-11T15:46:40', 'Transfering between WH and Courier', null, '402', 'in_transit', 'Asia/Baghdad', 'carrier'],
      ['2023-01-11T12:07:41', 'Received in Iraq COD warehouse', 'Baghdad supplying warehouse', '400', 'in_transit', 'Asia/Baghdad', 'place'],
      ['2023-01-10T22:34:50', 'Received by cargo warehouse', 'ERBIL', '200', 'in_transit', 'Asia/Baghdad', 'place'],
      // A warehouse the gazetteer does not place keeps ZMC Express's own clock.
      ['2023-01-10T18:59:57', 'Received by cargo warehouse', 'Sulaymania', '200', 'in_transit', 'Asia/Baghdad', 'carrier'],
      ['2023-01-10T18:19:29', 'Transfering between warehouses', null, '401', 'in_transit', 'Asia/Baghdad', 'carrier'],
      ['2023-01-10T18:01:17', 'Received in Iraq COD warehouse', 'Erbil Store', '400', 'in_transit', 'Asia/Baghdad', 'place'],
      ['2023-01-10T17:52:08', 'Customs declaration finished => IN IRAQ', null, '315', 'in_transit', 'Asia/Baghdad', 'place'],
      ['2023-01-10T14:22:59', 'Assigned to trip by land => ISU EBL 25', null, '302', 'in_transit', 'Asia/Baghdad', 'carrier'],
      ['2023-01-09T12:44:58', 'Assigned to flight by air => 2114', null, '300', 'in_transit', 'Asia/Baghdad', 'carrier'],
      // Dubai's branch writes on ZMC Express's own clock, as its customs row minutes before shows.
      ['2023-01-07T16:36:51', 'Received by cargo warehouse', 'DUBAI IMPORT LOACL', '200', 'in_transit', 'Asia/Baghdad', 'carrier'],
      ['2023-01-07T16:34:49', 'Customs declaration finished', null, '315', 'in_transit', 'Asia/Baghdad', 'carrier'],
      ['2022-12-29T09:24:17', 'Assigned to flight by air => 9327 DXB', null, '300', 'in_transit', 'Asia/Baghdad', 'carrier'],
      ['2022-12-28T16:36:48', 'Received by cargo warehouse', 'GUANGZHOU-AIR', '200', 'in_transit', 'Asia/Shanghai', 'place'],
      ['2022-12-27T13:33:22', 'Booked', null, '100', 'registered', 'Asia/Baghdad', 'carrier'],
    ]);
    expect(result.events![15]).toMatchObject({ time: '2022-12-28T16:36:48+08:00', original_description: 'Received by cargo warehouse => GUANGZHOU-AIR' });
    expect(result.events![0]).toMatchObject({ time: '2023-01-14T15:37:07+03:00' });
    // The recipient, the destination town, the boxes and the other reference stay behind.
    expect(JSON.stringify(result)).not.toMatch(/RECIPIENT|Bayaa|21139034|PicesNo|"34"/);
  });

  it('answers for either reference the rows join, and only for a whole one', () => {
    expect(parseZmc(rows(), OTHER)).toMatchObject({ current_stage: 'delivered' });
    expect(parseZmc(rows(), SAMPLE.toLowerCase())).toMatchObject({ current_stage: 'delivered' });
    for (const number of [INVENTED, 'A13477-12-253600', '13477-12-2536003', '21139034']) {
      expect(() => parseZmc(rows(), number), number).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // A row of another shipment, or rows two shipments sharing the reference asked, are no one shipment's.
    expect(() => parseZmc(changed((body) => { body[3]!.CustomerRefNo = `${INVENTED} | ${OTHER}`; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseZmc(changed((body) => { body[3]!.CustomerRefNo = `${INVENTED} | ${OTHER}`; }), OTHER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseZmc(changed((body) => { for (const row of body) row.CustomerRefNo = SAMPLE; }), SAMPLE)).toMatchObject({ current_stage: 'delivered' });
  });

  it('leads with the newest staged scan and leaves a new code to the wording rules', () => {
    const pending = parseZmc(changed((body) => body.splice(0, 2)), SAMPLE);
    expect(pending).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Pending delivery | Duplicated order' });
    expect(pending).not.toHaveProperty('delivered_at');
    const renamed = parseZmc(changed((body) => { body[0]!.StatusCode = '999'; body[0]!.Status = 'Handed over'; body.splice(1, 1); }), SAMPLE);
    expect(renamed.events![0]).toMatchObject({ description: 'Handed over', provider_code: '999' });
    expect(renamed.events![0]!.stage_source).not.toBe('carrier_map');
  });

  it('leaves out a phone number typed into a reason, and a weight it cannot read', () => {
    const result = parseZmc(changed((body) => { body[2]!.Status = 'Pending delivery | call 07701234567'; body[0]!.TotalWeight = 'n/a'; }), SAMPLE);
    expect(result.events![1]).toMatchObject({ description: 'Pending delivery', stage: 'failed_attempt' });
    expect(JSON.stringify(result)).not.toMatch(/0770/);
    expect(result).not.toHaveProperty('weight_kg');
  });

  it('refuses a changed reply', () => {
    for (const body of [null, {}, [], ['row'], changed((body) => { body[0]!.CustomerRefNo = ''; }), changed((body) => { body[0]!.Status = ''; }),
      changed((body) => { body[0]!.Status = '<b>Delivered successfully</b>'; }), changed((body) => { body[0]!.StatusCode = 'A1'; }),
      changed((body) => { body[0]!.StatusCode = null; }), changed((body) => { body[0]!.RegDate = '2023-01-14T15:37:09'; }),
      changed((body) => { body[0]!.RegDate = '2023-02-30 15:37:09'; }), changed((body) => { body[0]!.RegDate = null; })]) {
      expect(() => parseZmc(body, SAMPLE), JSON.stringify(body)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('ZMC Express statuses', () => {
  it('maps each code the tracker gives, and its wording relayed without the code', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'zmc-express', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(relayedWordingStage('zmc-express', 'Received by cargo warehouse => GUANGZHOU-AIR')).toBe('in_transit');
    expect(relayedWordingStage('zmc-express', 'Pending delivery | Duplicated order')).toBe('failed_attempt');
    expect(statusMap.stage(null, 'handed over')).toBeUndefined();
  });
});
