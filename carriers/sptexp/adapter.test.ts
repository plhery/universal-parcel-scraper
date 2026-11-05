import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SptexpTracker } from './adapter.js';
import { parseSptexpPage, parseSptexpTrack, SPTEXP_ORIGIN } from './parser.js';
import { ENTRIES, statusMap } from './status.js';

const NUMBER = 'SPT999999999901YQ';
const UNKNOWN = 'SPT999999999999YQ';
// Noon in Beijing on 7 March, after every row of the fixture.
const READ_AT = Date.parse('2026-03-07T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
type Reply = [{ data: [{ trackDetails: Record<string, string>[] }] }];

describe('SPT Express numbers', () => {
  it('suggests SPT, twelve digits and YQ, and recognition asks the tracker about them', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['sptexp'] });
    expect(recognitionCandidates(NUMBER, {}).map((candidate) => candidate.carrier)).toEqual(['sptexp']);
    for (const other of ['SPT99999999901YQ', 'SPT9999999999901YQ', 'SPX999999999901YQ', 'SPT999999999901YX']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('sptexp');
    }
  });
});

describe('SPT Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new SptexpTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ destination_country: 'US' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SPTEXP_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(SPTEXP_ORIGIN).toBe('http://106.52.159.115:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'sptexp', recordsSteps: true, steps: ['direct', 'retry'], recognize: expect.any(Function) });
  });

  it('reads the rows on Beijing’s clock, rows written after their clocks included, without the parties', () => {
    const result = parseSptexpTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Arrived at Origin Port',
      last_update: '2026-03-04T22:48:30+08:00', service_name: 'SPT Global Small Parcel-M', destination_country: 'US', expected_delivery: null,
    });
    expect(result.events).toEqual([
      { time: '2026-03-04T22:48:30+08:00', description: 'Arrived at Origin Port', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-06T22:28:42+08:00' },
      { time: '2026-03-04T21:48:30+08:00', description: '国内清关完成 / Customs export clearance completed', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-06T22:28:42+08:00' },
      { time: '2026-03-04T09:07:57+08:00', description: 'Arrived at export center', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-04T20:46:42+08:00' },
      { time: '2026-03-03T11:26:12+08:00', description: 'Item outbound scanning', location: 'CN', provider_code: 'SHIPMENT', stage: 'in_transit', stage_source: 'carrier_map', written_at: '2026-03-03T11:26:12+08:00' },
      { time: '2026-03-02T17:17:08+08:00', description: 'Item inbound scanning', location: 'CN', provider_code: 'ARRIVAL', stage: 'accepted', stage_source: 'carrier_map', written_at: '2026-03-02T17:17:08+08:00' },
    ]);
    const text = JSON.stringify(result);
    for (const value of ['REF-TEST-01', 'SPT-TEST', '900001', '转运中']) expect(text, value).not.toContain(value);
  });

  it('holds back a row written ahead of its clock, as on every tenant of the platform, and names it', () => {
    const reply = structuredClone(fixture('track')) as Reply;
    const details = reply[0].data[0].trackDetails;
    details.unshift({ ...details[0]!, track_id: '9000006', track_content: 'Delivered', track_date: '2026-03-06 20:30:00', track_createdate: '2026-03-04 22:30:00' });
    const result = parseSptexpTrack(reply, NUMBER, READ_AT)!;
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Arrived at Origin Port', written_ahead: ['2026-03-06T20:30:00+08:00'] });
    expect(result.events!.map((event) => event.description)).not.toContain('Delivered');
    // Written at its clock, the same row is a scan.
    details[0]!.track_createdate = '2026-03-06 20:35:00';
    expect(parseSptexpTrack(reply, NUMBER, READ_AT)).toMatchObject({ current_stage: 'delivered', status: 'delivered' });
    // A row dated after the lookup is not shown yet.
    expect(parseSptexpTrack(reply, NUMBER, Date.parse('2026-03-06T12:00:00Z'))).toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${SPTEXP_ORIGIN}/trackIndex.htm`);
    expect(() => parseSptexpPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of ENTRIES) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage('ARRIVAL', normalizeStatusWording('Item inbound scanning'))).toBe('accepted');
    expect(statusMapAnswer({ carrier: 'sptexp', providerCode: 'SHIPMENT', description: 'Item outbound scanning' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'sptexp', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
  });
});
