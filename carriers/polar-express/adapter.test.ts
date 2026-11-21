import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, polarExpressTrackerUrl } from './adapter.js';
import { normalizePolarExpressNumber, parsePolarExpress, timelineRows } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples' replies; the tests derive invented parcels from them.
const SAMPLE = 'PE912472376US';
const INVENTED = 'PE000000017US';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The public sample's page with its travel history replaced. */
const withTimeline = (rows: string) => fixture(SAMPLE).replace(/var timeline_data=\[.*?\];/s, `var timeline_data=[${rows}];`);
const row = (date: string, content: string, title = '<b> --- </b>') => `{type:'blog_post',date:'${date}',title:'${title}',content:'${content}',},`;

describe('Polar Express numbers', () => {
  it('takes two letters, nine digits and two letters', () => {
    expect(normalizePolarExpressNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizePolarExpressNumber('CT311228110UZ')).toBe('CT311228110UZ');
    for (const other of ['', 'PE91247237US', 'PE9124723766US', '912472376', 'P1912472376US', 'X'.repeat(70)]) {
      expect(() => normalizePolarExpressNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Polar Express tracking adapter', () => {
  it('asks the tracker’s page for the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture(SAMPLE)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://the-tracking.com/PE912472376US/');
    expect(polarExpressTrackerUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'polar-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s Not Found notice and its blank table as not found', async () => {
    for (const page of ['not-found', 'not-found-again']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture(page)));
      await expect(carrier(fetcher).track({ number: INVENTED }), page).rejects.toMatchObject({ kind: 'not_found' });
    }
    // A blank number beside a filled field or a history is a changed page.
    const blank = fixture('not-found-again');
    for (const page of [blank.replace('<td>Service:</td>\n                    <td><b></b></td>', '<td>Service:</td><td><b>Polar Express (USA)</b></td>'),
      blank.replace('var timeline_data=[]', `var timeline_data=[${row('2023-01-04 17:18:17', 'In Transit.')}]`)]) {
      expect(() => parsePolarExpress(page, INVENTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps refusals, verification pages, error pages and redirects apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><body>DDoS-Guard</body></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>502 Bad Gateway</title>', { status: 502 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Maintenance</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 301, headers: { Location: 'https://polexp.com/' } }))).toMatchObject({ kind: 'transport' });
  });
});

describe('Polar Express pages', () => {
  it('reads the public sample: its rows on their wall clock, its service, weight and destination', () => {
    expect(parsePolarExpress(fixture(SAMPLE), SAMPLE)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived Helsinki', last_update: null, last_update_local: '2023-01-08T17:30:05',
      expected_delivery: null, destination_country: 'RU', weight_kg: 9.8, service_name: 'PE_STANDARD',
      events: [
        { local_time: '2023-01-08T17:30:05', description: 'Arrived Helsinki', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-01-05T16:34:59', description: 'International Dispatch', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-01-04T17:18:17', description: 'Электронное сообщение об отправке', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads a Canadian parcel that bpost delivered: the partner’s places without its tag', () => {
    const result = parsePolarExpress(fixture('PE259451929CA'), 'PE259451929CA');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', destination_country: 'IL', weight_kg: 1.1, service_name: 'BPOST_EMS_CA' });
    expect(result.events).toHaveLength(19);
    expect(result.events![0]).toEqual({ local_time: '2022-08-15T09:10:09', description: 'Item delivered', location: 'Jerusalem, ISRAEL', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toEqual({ local_time: '2022-07-20T08:44:45', description: 'Shipment Data Uploaded', location: 'Englishtown, NJ', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.find((event) => event.description === 'Received at international processing center')).not.toHaveProperty('location');
    expect(result.events!.find((event) => event.description === 'Item presented at the Customs')).toMatchObject({ location: 'Israel', stage: 'customs' });
    // Every row gets a stage; the partner's number stays behind.
    expect(result.events!.every((event) => event.stage)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/LTN\d|landmarkglobal/);
  });

  it('reads a parcel Emirates Post delivered, without the name of whoever took it', () => {
    const result = parsePolarExpress(fixture('PE967067300US'), 'PE967067300US');
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', destination_country: 'RU', service_name: 'PE_EMS' });
    expect(result.events![0]).toEqual({ local_time: '2023-05-02T17:38:00', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.find((event) => event.description === 'Received at counter')).toMatchObject({ location: 'DUBAI SORTING CENTRE', stage: 'in_transit' });
    expect(result.events!.at(-1)).toMatchObject({ description: 'Scheduled for delivery', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/Recipient|Received {1,2}by|EE506906145AE/);
  });

  it('reads a parcel collected at a Boxberry point: one copy of a repeated row, the town without the point’s address', () => {
    const result = parsePolarExpress(fixture('PE924935636US'), 'PE924935636US');
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Выдано', destination_country: 'RU' });
    expect(result.events).toHaveLength(9);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2019-12-11T18:37:00', description: 'Выдано', location: 'Санкт-Петербург', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2019-12-11T17:20:00', description: 'Поступило в пункт выдачи', location: 'Санкт-Петербург', stage: 'ready_for_pickup', stage_source: 'carrier_map' },
    ]);
    // Boxberry's data record, with no stage, sits between Polar Express's own rows.
    expect(result.events!.find((event) => event.description === 'Загружен реестр ИМ')).not.toHaveProperty('stage');
    expect(result.events!.filter((event) => event.description === 'Электронное сообщение об отправке')).toHaveLength(1);
    // Of two rows at one clock, the later on the page comes first.
    expect(result.events!.slice(4, 6).map((event) => event.description)).toEqual(['Принято к доставке', 'Передано на сортировку']);
  });

  it('answers a parcel Polar Express sends under a post’s number', () => {
    const page = fixture(SAMPLE).replaceAll(SAMPLE, 'CT311228110UZ');
    expect(parsePolarExpress(page, 'CT311228110UZ')).toMatchObject({ current_stage: 'in_transit' });
  });

  it('refuses a page for another carrier or another number, as the tracker shows other carriers’ numbers too', () => {
    for (const service of ['UPS', '']) {
      const page = fixture(SAMPLE).replace('<b>Polar Express (USA)</b>', `<b>${service}</b>`);
      expect(() => parsePolarExpress(page, SAMPLE), service).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parsePolarExpress(fixture(SAMPLE).replace('Polar Express (USA)', 'Polar Express (USA, NJ)'), SAMPLE)).toMatchObject({ current_stage: 'in_transit' });
    expect(() => parsePolarExpress(fixture(SAMPLE), 'PE912472377US')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the day notices without a stage, and keeps the stage of the row before', () => {
    const page = withTimeline(row('2017-12-12 10:14:47', 'Электронное сообщение об отправке') + row('2017-12-14 00:43:34', 'Задержка вылета до 15.12.17')
      + row('2017-12-15 23:58:43', 'Ориентировочная дата прибытия в Москву 25 Ноября.'));
    const result = parsePolarExpress(page, SAMPLE);
    expect(result).toMatchObject({ current_stage: 'accepted', last_status_text: 'Ориентировочная дата прибытия в Москву 25 Ноября.' });
    expect(result.events!.slice(0, 2).every((event) => !('stage' in event))).toBe(true);
  });

  it('answers a listed parcel without rows as one without history', () => {
    expect(() => parsePolarExpress(withTimeline(''), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    const summary = withTimeline('').replace(/<td>Status:<\/td>\s*<td>--<\/td>/, '<td>Status:</td><td>Arrived Moscow. In customs.</td>');
    expect(parsePolarExpress(summary, SAMPLE)).toMatchObject({ current_stage: 'customs', summary_only: true, events: [] });
  });

  it('reads the script’s strings without running it', () => {
    expect(timelineRows(`<script>var timeline_data=[{date:'2023-01-04 17:18:17',title:"<b>A</b>",content:'It\\'s \\u0041\\x42',}, ];</script>`))
      .toEqual([{ date: '2023-01-04 17:18:17', title: '<b>A</b>', content: "It's AB" }]);
    expect(timelineRows('var timeline_data=[];')).toEqual([]);
  });

  it('refuses a changed page', () => {
    for (const page of [fixture(SAMPLE).replace('Parcel information:', ''), fixture(SAMPLE).replace('var timeline_data=', 'var history='),
      withTimeline("{date:'2023-01-04 17:18:17',content:'open"), withTimeline("{date:2023,content:'x'}"), withTimeline(row('04.01.2023 17:18', 'x')),
      withTimeline(row('2023-02-30 10:00:00', 'x')), withTimeline(row('2023-01-04 17:18:17', '')), fixture(SAMPLE).replace(/<td width="150px"><b>PE912472376US<\/b><\/td>/, '')]) {
      expect(() => parsePolarExpress(page, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Polar Express statuses', () => {
  it('maps each wording the tracker shows', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      const answer = statusMapAnswer({ carrier: 'polar-express', providerCode: null, description: entry.wording });
      expect(answer, entry.wording).toMatchObject(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap' });
    }
    for (const [wording, stage] of [['Arrived Berlin', 'in_transit'], ['Arrived Moscow. In customs.', 'customs'], ['Shipped to TBILISI', 'in_transit'],
      ['Arrived at GEORGIA', 'in_transit'], ['Grouped when pallet scanned to crossing (ILPOST 2 030822 S)', 'in_transit']] as const) {
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'polar-express', providerCode: null, description: 'Задержка вылета до 17 Декабря' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMap.stage(null, 'something else')).toBeUndefined();
  });
});
