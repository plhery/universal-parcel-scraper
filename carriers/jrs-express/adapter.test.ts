import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { carrierTrackingNumber, formatTrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JRS_API, jrsLookupUrl, JrsTracker } from './adapter.js';
import { jrsReference } from './number.js';
import { normalizeJrsReference, parseJrs } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample, an airbill and its branch code; a synthetic reference the tracker holds nothing for.
const REFERENCE = '66088-3033', UNKNOWN = '90817263-9182';

type Row = Record<string, unknown>;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Row[];
/** The sample's reply with each row changed. */
const edit = (change: (row: Row, index: number) => Row | Row[]) => fixture('delivered').flatMap(change);
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('JRS Express references', () => {
  it('takes the airbill and its branch code joined by a hyphen, as typed', () => {
    expect(normalizeJrsReference(` ${REFERENCE.replace('-', ' - ')} `)).toEqual({ reference: REFERENCE, airbill: '66088', branch: '3033' });
    // The tracker ignores leading zeros, so the reply names the parts without them.
    expect(normalizeJrsReference('066088-3033')).toEqual({ reference: '066088-3033', airbill: '66088', branch: '3033' });
    expect(normalizeJrsReference('481817-0161')).toEqual({ reference: '481817-0161', airbill: '481817', branch: '161' });
    for (const other of ['', '660883033', '66088-0000', '000-3033', '66088-30333', '66088-3033-1', 'ABC-123', '66088/3033', `${'1'.repeat(11)}-123`]) {
      expect(() => normalizeJrsReference(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps the hyphen when JRS Express is the carrier, and only then', () => {
    expect(jrsReference(' 66088 - 3033 ')).toBe(REFERENCE);
    expect(carrierTrackingNumber(' 66088 - 3033 ', 'jrs-express')).toBe(REFERENCE);
    expect(directTrackingNumber('jrs-express', REFERENCE)).toBe(REFERENCE);
    expect(formatTrackingNumber(REFERENCE, 'jrs-express')).toBe(REFERENCE);
    expect(carrierTrackingNumber(REFERENCE, 'dpd-ie')).toBe(normalizeTrackingNumber(REFERENCE));
    expect(carrierTrackingNumber(REFERENCE, undefined)).toBe('660883033');
    // A reference of another shape, or with a part of zeros alone, normalizes as before.
    expect(carrierTrackingNumber('66088-0000', 'jrs-express')).toBe('660880000');
    expect(carrierTrackingNumber('481817', 'jrs-express')).toBe('481817');
  });
});

describe('JRS Express tracking adapter', () => {
  it('asks the tracking API with the whole reference, as the tracking page does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JrsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(REFERENCE, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${JRS_API}?airbill=${REFERENCE}`);
    expect(jrsLookupUrl(REFERENCE)).toBe(`https://jrs-core-api.azurewebsites.net/api/Tracking/v1/track-airbill?airbill=${REFERENCE}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' }) });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jrs-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(carrier(fetcher)).toMatchObject({ id: 'jrs-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses the digits without their hyphen before asking, since they do not say where the airbill ends', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: normalizeTrackingNumber(REFERENCE) })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the empty list as not found', async () => {
    expect(() => parseJrs(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, challenges, error pages and redirects apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: UNKNOWN }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => json({ error: 'Too many requests' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>Forbidden</h1>', 403))).toMatchObject({ kind: 'challenge', reason: 'api_denied' });
    expect(await answer(() => html('<h1>Not Found</h1>', 404))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>Service Unavailable</h1>', 503))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('<h1>Server Error</h1>', 500))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html('<html></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://jrs-express.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('[', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ success: false, errror: 'Airbill is required.' }))).toMatchObject({ kind: 'schema' });
  });
});

describe('JRS Express replies', () => {
  it('reads the sample: its scans newest first, the branches, and the release on the page\'s Manila clock', () => {
    const result = parseJrs(fixture('delivered'), REFERENCE);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Released To / Delivered To',
      last_update: null, last_update_local: '2025-12-19T14:30:56', expected_delivery: null, events: [
        { local_time: '2025-12-19T14:30:56', description: 'Released To / Delivered To', location: 'San Mateo, Isabela, Isabela',
          stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2025-12-19T02:10:23Z', description: 'Received at Delivery Branch', location: 'San Mateo, Isabela, Isabela',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2025-12-18T13:40:37Z', description: 'Departed', location: 'Head Office, Pasig City', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2025-12-18T09:05:28Z', description: 'Departed', location: 'Alabang South Supermarket (JRS Office+), Muntinlupa City',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2025-12-18T05:33:09Z', description: 'Accepted at JRS Branch', location: 'Alabang South Supermarket (JRS Office+), Muntinlupa City',
          stage: 'accepted', stage_source: 'carrier_map' },
      ] });
    // The person a release names, the relationship and the remarks stay behind.
    expect(JSON.stringify(result)).not.toMatch(/RECEIVER NAME|PICK UP|LUZON CARGO|RXS|receiver|relation|remarks/);
  });

  it('reads a clock in UTC with Z or without an offset, and one with an offset as the page shows it in the Philippines', () => {
    const at = (dateReceived: string) => parseJrs(edit((row, index) => (index === 0 ? { ...row, dateReceived } : [])), REFERENCE).events![0]!;
    expect(at('2025-12-18T05:33:09.1506393Z')).toMatchObject({ time: '2025-12-18T05:33:09Z' });
    expect(at('2025-12-18T05:33:09')).toMatchObject({ time: '2025-12-18T05:33:09Z' });
    expect(at('2025-12-18T22:30:56.295+00:00')).toMatchObject({ local_time: '2025-12-19T14:30:56' });
    expect(at('2025-12-18T22:30:56.295+00:00').time).toBeUndefined();
  });

  it('dates a delivery on its instant when its clock comes with Z', () => {
    const result = parseJrs(edit((row) => (row.statusText === 'Released To / Delivered To' ? { ...row, dateReceived: '2025-12-19T06:30:56.295Z' } : row)), REFERENCE);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2025-12-19T06:30:56Z', delivered_at: '2025-12-19T06:30:56Z' });
    expect(result.last_update_local).toBeUndefined();
  });

  it('keeps only the rows of the reference asked, whatever zeros lead its parts', () => {
    const other = edit((row, index) => (index === 1 ? [row, { ...row, trackingCode: 3034, statusText: 'Delivered To' }] : row));
    expect(parseJrs(other, REFERENCE).events).toHaveLength(5);
    expect(parseJrs(edit((row) => ({ ...row, trackingID: 66088, trackingCode: '3033' })), '066088-3033').events).toHaveLength(5);
    expect(() => parseJrs(fixture('delivered'), '66088-3034')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJrs(fixture('delivered'), '66089-3033')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('skips a row without a status text, and reads a reply of such rows alone as listed without a scan', () => {
    const tested = edit((row, index) => (index === 0 ? [{ ...row, statusText: '', receiver: 'test', dateReceived: 'unknown' }, row] : row));
    expect(parseJrs(tested, REFERENCE).events).toHaveLength(5);
    expect(() => parseJrs(edit((row) => ({ ...row, statusText: null })), REFERENCE))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate', reason: 'listed' }));
  });

  it('leaves a status text it does not know without a stage, and takes the parcel\'s from the newest scan that has one', () => {
    const result = parseJrs(edit((row) => (row.statusText === 'Released To / Delivered To' ? { ...row, statusText: 'Zzz' } : row)), REFERENCE);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Zzz' });
    expect(result.events![0]).toEqual({ local_time: '2025-12-19T14:30:56', description: 'Zzz', location: 'San Mateo, Isabela, Isabela' });
  });

  it('refuses a changed reply', () => {
    for (const reply of [null, {}, { success: false }, ['row'], edit((row) => ({ ...row, trackingID: null })),
      edit((row) => ({ ...row, trackingCode: '30-33' })), edit((row) => ({ ...row, statusText: 7 })),
      edit((row) => ({ ...row, branchLocation: { name: 'Head Office' } })), edit((row) => ({ ...row, dateReceived: '2025-02-30T05:33:09Z' })),
      edit((row) => ({ ...row, dateReceived: '18/12/2025 1:33 PM' })), edit((row) => ({ ...row, dateReceived: '0001-01-01T00:00:00' })),
      Array.from({ length: 201 }, () => fixture('delivered')[0])]) {
      expect(() => parseJrs(reply, REFERENCE), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('JRS Express statuses', () => {
  it('maps each status text the tracker gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'jrs-express', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('1', 'Departed')).toBeUndefined();
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
