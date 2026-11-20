import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DANX_LOOKUP, danxTrackerUrl } from './adapter.js';
import { normalizeDanxNumber, parseDanx } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's reply, with its people and places replaced; the tests derive invented shipments from it.
const SAMPLE = 'KU00001';
const LABEL = 'ZZ90000001', REFERENCE = 'ZZ901';

type Reply = { d: string };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const rowsOf = (reply: Reply) => (JSON.parse(reply.d) as { aaData: string[][] }).aaData;
const replyOf = (rows: string[][]) => ({ d: JSON.stringify({ sEcho: 1, iTotalDisplayRecords: rows.length, aaData: rows }) });
const SAMPLE_ROW = rowsOf(fixture(`label-${SAMPLE}`))[0]!;
const scans = (...rows: string[]) => `<b>Status</b></div><div class='col-xs-8 col-sm-9 col-md-10'>${rows.join('')}</div></div>`;
const scan = (code: string, clock: string, ...extra: string[]) => `<font color= #000 >${code}</font><br/>${clock}<br/>${extra.map((line) => `${line}<br/>`).join('')}<br/>`;
/** The sample's row under another label, with its status column and its scans replaced when given. */
const row = (changes: { label?: string; reference?: string; pickup?: string; code?: string; scans?: string[] } = {}) => {
  const details = changes.scans
    ? SAMPLE_ROW[7]!.replace(/<b>Status<\/b><\/div><div[^>]*>.*?<\/div><\/div>/s, scans(...changes.scans)) : SAMPLE_ROW[7]!;
  return ['', changes.reference ?? REFERENCE, changes.label ?? LABEL, changes.pickup ?? SAMPLE_ROW[3]!, ...SAMPLE_ROW.slice(4, 7), details, changes.code ?? SAMPLE_ROW[8]!];
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('DANX numbers', () => {
  it('takes a label barcode in letters and digits', () => {
    expect(normalizeDanxNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const other of ['', 'KU01', 'ABCDEFG', 'KU0000!', 'X'.repeat(41) + '1']) {
      expect(() => normalizeDanxNumber(other), other).toThrow('barcode number on the DANX label');
    }
  });
});

describe('DANX tracking adapter', () => {
  it('asks the tracker page’s service with the page’s own address, as its script does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(`label-${SAMPLE}`)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(danxTrackerUrl(SAMPLE)).toBe('https://fasttrack.danx.com/?id=S1UwMDAwMQ%3D%3D');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DANX_LOOKUP}?id=https://fasttrack.danx.com/?id=S1UwMDAwMQ%3D%3D&sEcho=1`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'Content-Type': 'application/json; charset=utf-8' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'danx', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads an empty table as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: LABEL })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, error pages and redirects apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: LABEL }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('<title>Runtime Error</title>', { status: 500, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.danx.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('DANX replies', () => {
  it('reads the public sample: its scans on their wall clock, its terminal and where it went', () => {
    const result = parseDanx(fixture(`label-${SAMPLE}`), SAMPLE);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'POD',
      last_status_text: 'Successfully delivered', last_update: null, last_update_local: '2025-02-03T09:00:32',
      expected_delivery: null, destination_country: 'DK',
      events: [
        { local_time: '2025-02-03T09:00:32', description: 'Successfully delivered', provider_code: 'POD', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2025-02-03T07:55:03', description: 'Consolidated', provider_code: 'CONS', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-02-03T07:54:26', description: 'Terminal scan', provider_code: 'TERM', location: 'ISJ - Ishøj', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-01-31T11:50:00', description: 'Pickup collected', provider_code: 'PSIP', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The signer, names, addresses, weight and note stay behind.
    expect(JSON.stringify(result)).not.toMatch(/Signer|Clinic|Institute|Street|Town|Note|KG/);
  });

  it('follows a label used again to its newest shipment', () => {
    const older = row({ pickup: '02-01-2025' });
    const newer = row({ pickup: '10-03-2025', code: 'TERM', scans: [scan('TERM', '11-03-2025 06:10:00', 'ISJ - Ishøj'), scan('PSIP', '10-03-2025 15:00:00')] });
    for (const rows of [[older, newer], [newer, older]]) {
      expect(parseDanx(replyOf(rows), LABEL)).toMatchObject({ current_stage: 'in_transit', provider_code: 'TERM', last_update_local: '2025-03-11T06:10:00' });
    }
  });

  it('answers the other reference of one shipment, but not one that several labels share', () => {
    expect(parseDanx(replyOf([row()]), REFERENCE)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseDanx(replyOf([row(), row({ label: 'ZZ90000002' })]), REFERENCE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDanx(replyOf([row()]), 'ZZ90000003')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the legend’s failed pickup or delivery, and leaves an unknown code to the scans', () => {
    expect(parseDanx(replyOf([row({ code: 'CNA', scans: [scan('CNA', '04-02-2025 10:00:00', 'Lukket'), scan('PSIP', '03-02-2025 15:00:00')] })]), LABEL))
      .toMatchObject({ current_stage: 'exception', last_status_text: 'Pickup/Delivery not possible', events: [{ provider_code: 'CNA' }, { provider_code: 'PSIP' }] });
    const unknown = parseDanx(replyOf([row({ code: 'XYZ', scans: [scan('XYZ', '04-02-2025 10:00:00'), scan('PSIP', '03-02-2025 15:00:00')] })]), LABEL);
    expect(unknown).toMatchObject({ current_stage: 'accepted', provider_code: 'XYZ', last_status_text: 'XYZ' });
    expect(unknown.events![0]).toEqual({ local_time: '2025-02-04T10:00:00', description: 'XYZ', provider_code: 'XYZ' });
  });

  it('answers a booked shipment without scans by its code alone', () => {
    expect(parseDanx(replyOf([row({ code: 'PSIP', scans: [] })]), LABEL)).toMatchObject({ current_stage: 'accepted', summary_only: true, events: [] });
    expect(() => parseDanx(replyOf([row({ code: '', scans: [] })]), LABEL)).toThrow('without a status or scans');
  });

  it('refuses a changed reply', () => {
    for (const reply of [null, {}, { d: '{' }, { d: '{"aaData":{}}' }, replyOf([SAMPLE_ROW.slice(0, 8)]), replyOf([[...SAMPLE_ROW.slice(0, 8), 7 as unknown as string]]),
      replyOf([row({ code: 'pod' })]), replyOf([row({ pickup: '31-02-2025' })]), replyOf([row({ scans: [scan('TERM', '2025-02-03 07:54')] })]),
      replyOf([row({ scans: [scan('?', '03-02-2025 07:54:26')] })]), replyOf([[...row().slice(0, 7), '<p>moved</p>', 'POD']])]) {
      expect(() => parseDanx(reply, LABEL), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('DANX statuses', () => {
  it('maps each code of the tracker’s legend', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'danx', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('XYZ', 'anything')).toBeUndefined();
  });
});
