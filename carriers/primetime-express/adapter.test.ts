import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

// The found reply is synthetic, in the ParcelPerfect template; see fixtures/README.md.
const WAYBILL = 'ZZ00000001';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Primetime Express waybill replies', () => {
  it('reads a delivered waybill with its latest local clock and depots', () => {
    const result = parseTracking(fixture('synthetic-delivered'), WAYBILL, 200);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Proof of delivery details captured', last_update_local: '2025-03-04T12:30:09' });
    expect(result.events).toHaveLength(9);
    expect(result.events![0]).toMatchObject({ local_time: '2025-03-04T12:30:09', location: 'Johannesburg' });
    expect(result.events!.every(event => !('time' in event))).toBe(true);
  });

  it('keeps the stage the parcel has through a later capture and a dispatch on the round', () => {
    expect(parseTracking(fixture('synthetic-delivered'), WAYBILL, 200).events!.map(event => `${event.description} ${event.stage}`)).toEqual([
      'Proof of delivery details captured delivered', 'Dispatched out_for_delivery',
      'Loaded for delivery from Johannesburg facility out_for_delivery', 'Checked in at Johannesburg facility in_transit',
      'Dispatched in_transit', 'Loaded on manifest to Johannesburg facility in_transit', 'Ready for collection accepted',
      'Collected from origin address accepted', 'Consignment details captured registered',
    ]);
  });

  it('answers a waybill whose scans are all hidden as one without history', () => {
    const reply = JSON.parse(fixture('synthetic-delivered'));
    for (const row of reply.results) row.hidden = '1';
    expect(() => parseTracking(JSON.stringify(reply), WAYBILL, 200)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects scans for another waybill', () => {
    expect(() => parseTracking(fixture('synthetic-delivered'), 'ZZ00000002', 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes the tracker\'s explicit absence reply', () => {
    expect(() => parseTracking(fixture('unknown'), WAYBILL, 200)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('never reads another error, a page or a short reply as an unknown waybill', () => {
    const token = JSON.stringify({ errorcode: '1', errormessage: 'Invalid security token', total: 0, results: [] });
    const short = JSON.parse(fixture('synthetic-delivered'));
    short.total = 10;
    for (const [text, status] of [[token, 200], ['<html>Unavailable</html>', 200], ['<html>Unavailable</html>', 404],
      [fixture('unknown'), 404], [JSON.stringify(short), 200]] as const) {
      expect(() => parseTracking(text, WAYBILL, status), text.slice(0, 40)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('refuses a scan without a readable clock', () => {
    const reply = JSON.parse(fixture('synthetic-delivered'));
    reply.results[3].eventtime = '25:61:00';
    expect(() => parseTracking(JSON.stringify(reply), WAYBILL, 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Primetime Express tracking adapter', () => {
  it('asks the tenant service with the public tenant code and the whole waybill', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ homepage_url: 'https://www.ptexpress.co.za/', cryptcust: '1000.2000.3000' }))
      .mockResolvedValueOnce(json(fixture('synthetic-delivered')));
    await expect(carrier(fetcher).track({ number: ` ${WAYBILL.toLowerCase()} ` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://primetimeexpress.pperfect.com/config/config.json');
    const lookup = new URL(String(fetcher.mock.calls[1]![0]));
    expect(lookup.origin + lookup.pathname).toBe('https://primetimeexpress.pperfect.com/trackappservice/Json/index.php');
    expect(Object.fromEntries(lookup.searchParams)).toEqual({ class: 'Waybill', method: 'getEventData', token_id: '1000.2000.3000',
      params: JSON.stringify({ waybill: WAYBILL, rectype: 'waybill' }) });
  });

  it('reports the tracker\'s absence reply as not found', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ cryptcust: '1000.2000.3000' }))
      .mockResolvedValueOnce(json(fixture('unknown')));
    await expect(carrier(fetcher).track({ number: WAYBILL })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('stops when the tenant configuration has no public code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ homepage_url: 'https://www.ptexpress.co.za/' }));
    await expect(carrier(fetcher).track({ number: WAYBILL })).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('takes five to twenty letters and digits and asks nothing for anything else', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ01', 'ZZ0000/0001', 'Z'.repeat(21), '']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
