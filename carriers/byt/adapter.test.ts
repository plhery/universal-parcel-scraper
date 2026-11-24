import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BytTracker } from './adapter.js';
import { BYT_ORIGIN, parseBytPage, parseBytTrack, splitBytRow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'BYT73915820461937';
const REFERENCE = 'FC9031857264013';
const UNKNOWN = 'BYT73915820461945';
const GOFO = 'GFUS62804719350286';
// Noon in Beijing on 10 March, after the fixture's rows.
const READ_AT = Date.parse('2026-03-10T04:00:00Z');
type Reply = [{ data: [Record<string, unknown> & { trackDetails: ({ track_content: string } & Record<string, string>)[] }] }];
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const track = (edit: (record: Reply[0]['data'][0]) => void = () => {}) => {
  const reply = structuredClone(fixture('track')) as Reply;
  edit(reply[0].data[0]);
  return reply;
};
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.each(['Clearance agency picked', 'Package picked up by last-mile carrier'])('reads the BYT handover %s as transit', (wording) => {
  const payload = track((record) => { record.trackDetails[0]!.track_content = wording; });
  expect(parseBytTrack(payload, NUMBER, READ_AT)?.events?.[0]).toMatchObject({
    description: wording, stage: 'in_transit', stage_source: 'carrier_map',
  });
});

describe('BYT numbers', () => {
  it('claims BYT and fourteen digits, and nothing shorter, longer or under another prefix', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'byt', confidence: 'high', candidates: ['byt'] });
    for (const other of ['BYT7391582046193', 'BYT739158204619370', 'BYS73915820461937', 'XBYT73915820461937', 'BYT7391582046193A']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('byt');
    }
    // Its last five digits are no postcode: Colis Privé's numbers open with two letters at most.
    expect(detectCarrierMatch('BYT73915820A61937').candidates ?? []).not.toContain('colis-prive');
  });
});

describe('BYT tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over HTTPS', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new BytTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ current_stage: 'customs' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${BYT_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    // The number never travels in the clear: the tracker's HTTPS host answers as its plain-HTTP port does.
    expect(BYT_ORIGIN).toBe('https://tms.byt56.com.cn');
    expect(String(url)).toMatch(/^https:\/\//);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'byt', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads its rows on Beijing time without their Chinese copies, the placeholder place or the parties', () => {
    const result = parseBytTrack(track(), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'customs', current_stage_source: 'carrier_map',
      last_status_text: 'Destination country customs clearance begins', last_update: '2026-03-08T23:49:00+08:00',
      service_name: 'Synthetic Line', destination_country: 'US',
    });
    expect(result.events!.map((event) => [event.time, event.description, event.location, event.provider_code, event.stage])).toEqual([
      ['2026-03-08T23:49:00+08:00', 'Destination country customs clearance begins', undefined, undefined, 'customs'],
      ['2026-03-08T19:21:00+08:00', 'The flight has landed', undefined, undefined, 'in_transit'],
      ['2026-03-06T10:16:49+08:00', 'Package handed over to airline', undefined, undefined, 'in_transit'],
      ['2026-03-06T10:03:25+08:00', 'Customs export clearance completed', undefined, undefined, 'in_transit'],
      ['2026-03-05T13:27:42+08:00', `The warehouse changed the last-mile vendor due to the weight difference, the new tracking number is ${GOFO}`,
        undefined, undefined, 'in_transit'],
      ['2026-03-04T13:21:21+08:00', 'Package departed from the warehouse', undefined, 'SHIPMENT', 'in_transit'],
      ['2026-03-04T09:34:52+08:00', 'Parcel Data Received', undefined, undefined, 'registered'],
      ['2026-03-04T09:06:34+08:00', 'Package received & scanned at warehouse', undefined, 'ARRIVAL', 'accepted'],
    ]);
    expect(result.canonical_tracking_number).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['中文', 'The carrier', 'Synthetic Recipient', 'Synthetic Shop', REFERENCE]) expect(text, value).not.toContain(value);
    expect(parseBytTrack(track(), REFERENCE, READ_AT)).toMatchObject({ canonical_tracking_number: NUMBER });
  });

  it('keeps a copy that is the only wording, and other places', () => {
    expect(splitBytRow('(中文:包裹已签收)', 'The carrier')).toEqual({ content: '包裹已签收', location: '' });
    expect(splitBytRow('Arrived at hub (Los Angeles)（中文：到达）', 'Los Angeles')).toEqual({ content: 'Arrived at hub (Los Angeles)', location: 'Los Angeles' });
    expect(splitBytRow('Package handed over to airline', '')).toEqual({ content: 'Package handed over to airline', location: '' });
  });

  it('hands the parcel to GOFO under the number the warehouse gives, and only to a carrier claiming it whole', () => {
    expect(parseBytTrack(track(), NUMBER, READ_AT)).toMatchObject({ delivery_carrier: 'gofo', delivery_tracking_number: GOFO });
    // A number no partner claims is still the delivery carrier's number, its carrier unnamed.
    const unclaimed = parseBytTrack(track((record) => {
      for (const row of record.trackDetails) row.track_content = row.track_content.replaceAll(GOFO, 'ZZ0000000001');
    }), NUMBER, READ_AT)!;
    expect(unclaimed).toMatchObject({ delivery_tracking_number: 'ZZ0000000001' });
    expect(unclaimed).not.toHaveProperty('delivery_carrier');
    // A record with its own transfer number holds the delivery carrier's: no row's number replaces it.
    const transferred = parseBytTrack(track((record) => { record.business_channeltransfercode = 'ZZ0000000002'; }), NUMBER, READ_AT)!;
    expect(transferred.delivery_carrier ?? transferred.delivery_tracking_number).toBeUndefined();
    const none = parseBytTrack(track((record) => { record.trackDetails = record.trackDetails.filter((row) => !row.track_content.includes(GOFO)); }), NUMBER, READ_AT)!;
    expect(none.delivery_carrier ?? none.delivery_tracking_number).toBeUndefined();
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${BYT_ORIGIN}/trackIndex.htm`);
    expect(() => parseBytPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'byt', providerCode: 'ARRIVAL', description: 'Package received & scanned at warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'byt', providerCode: null,
      description: `The warehouse changed the last-mile vendor due to the weight difference, the new tracking number is ${GOFO}` }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'byt', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
  });
});
