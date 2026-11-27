import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

// The public sample's reply; see fixtures/README.md.
const WAYBILL = '1886880ACT';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ACT Logistics waybill replies', () => {
  it('reads the public waybill with its local clocks and depots', () => {
    const result = parseTracking(fixture('found'), WAYBILL, 200);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Proof of delivery details captured', last_update_local: '2023-01-26T12:50:00' });
    expect(result.events).toHaveLength(7);
    expect(result.events![0]).toMatchObject({ local_time: '2023-01-26T12:50:00', location: 'Johannesburg' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2023-01-24T14:40:00', location: 'Cape Town' });
    expect(result.events!.every(event => !('time' in event))).toBe(true);
  });

  it('keeps the stage the parcel has through a capture after it has left the depot', () => {
    expect(parseTracking(fixture('found'), WAYBILL, 200).events!.map(event => `${event.description} ${event.stage}`)).toEqual([
      'Proof of delivery details captured delivered', 'Dispatched in_transit', 'Consignment details captured in_transit',
      'Loaded on manifest to Johannesburg facility in_transit', 'Collection checked in at Cape Town facility in_transit',
      'Collected from origin address accepted', 'Ready for collection registered',
    ]);
  });

  it('reads a depot it has not seen named in a known wording', () => {
    const elsewhere = fixture('found').replaceAll('Johannesburg facility', 'Durban facility');
    expect(parseTracking(elsewhere, WAYBILL, 200).events![3]).toMatchObject({ description: 'Loaded on manifest to Durban facility', stage: 'in_transit' });
  });

  it('answers a waybill whose scans are all hidden as one without history', () => {
    const reply = JSON.parse(fixture('found'));
    for (const row of reply.results) row.hidden = '1';
    expect(() => parseTracking(JSON.stringify(reply), WAYBILL, 200)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects scans for another waybill', () => {
    expect(() => parseTracking(fixture('found'), '1886880', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes the tracker\'s explicit absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), '0000000ACT', 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('never reads another error, a page or a short reply as an unknown waybill', () => {
    const token = JSON.stringify({ errorcode: '1', errormessage: 'Invalid security token', total: 0, results: [] });
    const short = JSON.parse(fixture('found'));
    short.total = 8;
    for (const [text, status] of [[token, 200], ['<html>Unavailable</html>', 200], ['<html>Unavailable</html>', 404],
      [fixture('unknown'), 404], [JSON.stringify(short), 200], ['{"errorcode":"0"}', 200]] as const) {
      expect(() => parseTracking(text, WAYBILL, status), text.slice(0, 40)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('refuses a scan without a readable clock', () => {
    const reply = JSON.parse(fixture('found'));
    reply.results[3].eventtime = '25:61:00';
    expect(() => parseTracking(JSON.stringify(reply), WAYBILL, 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('ACT Logistics tracking adapter', () => {
  it('asks the tenant service with the public tenant code and the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ homepage_url: 'https://www.act-logistics.co.za/', cryptcust: '1000.2000.3000' }))
      .mockResolvedValueOnce(json(fixture('found')));
    await expect(carrier(fetcher).track({ number: ` ${WAYBILL.toLowerCase()} ` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://actlogistics.pperfect.com/config/config.json');
    const lookup = new URL(String(fetcher.mock.calls[1]![0]));
    expect(lookup.origin + lookup.pathname).toBe('https://actlogistics.pperfect.com/trackappservice/Json/index.php');
    expect(Object.fromEntries(lookup.searchParams)).toEqual({ class: 'Waybill', method: 'getEventData', token_id: '1000.2000.3000',
      params: JSON.stringify({ waybill: WAYBILL, rectype: 'waybill' }) });
  });

  it('reports the tracker\'s absence reply as not found', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ cryptcust: '1000.2000.3000' }))
      .mockResolvedValueOnce(json(fixture('unknown')));
    await expect(carrier(fetcher).track({ number: '0000000ACT' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('never reads a challenge page or a server error as an unknown waybill', async () => {
    for (const reply of [new Response('<html><title>Just a moment...</title></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      new Response('Bad gateway', { status: 502 })]) {
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(json({ cryptcust: '1000.2000.3000' }))
        .mockResolvedValueOnce(reply);
      await expect(carrier(fetcher).track({ number: WAYBILL })).rejects.not.toMatchObject({ kind: 'not_found' });
    }
  });

  it('stops when the tenant configuration has no public code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ homepage_url: 'https://www.act-logistics.co.za/' }));
    await expect(carrier(fetcher).track({ number: WAYBILL })).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('takes five to ten digits followed by ACT and asks nothing for anything else', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['1886880', '1234ACT', '12345678901ACT', 'ACT1886880', '1886880-ACT', '18868A0ACT', '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
