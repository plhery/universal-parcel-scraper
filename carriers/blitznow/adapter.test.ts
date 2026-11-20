import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { BlitzTracker } from './adapter.js';
import { blitzPayload, normalizeBlitzNumber, parseBlitz } from './parser.js';
import { blitzStage, statusMap } from './status.js';

type Reply = { result: { shipmentDetails: Record<string, unknown>; trackingDetails: Record<string, unknown>[] } };
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const reply = (name = 'delivered.json') => JSON.parse(text(name)) as Reply;
const NUMBER = reply().result.shipmentDetails.awbnumber as string;
const statuses = JSON.parse(text('../statuses.json')) as { entries: { wording: string; stage?: string }[] };
const response = (body: string, status = 200) => new Response(body, { status });

/** A synthetic parcel on its way, with the scan rows the tracker's script reads. */
function onTheWay(rows: unknown, status = 'Out for Delivery'): Record<string, unknown> {
  const copy = reply().result;
  Object.assign(copy.shipmentDetails, { shipmentstatus: status, delivered: false, modifieddate: '2026-04-11T08:15:00.5+05:30' });
  copy.trackingDetails[0]!.tracking = rows;
  return copy;
}
const ROWS = [
  { shipmentStatus: 'Out for Delivery', remarks: 'Synthetic remark', timestamp: '2026-04-11T08:15:00+05:30' },
  { shipmentStatus: 'Picked-up', timestamp: Date.parse('2026-04-10T13:00:00Z') },
  { shipmentStatus: 'Awb Generated', timestamp: '2026-04-10T10:26:12.295182Z' },
];

describe('Blitz tracker', () => {
  it('posts the number as the tracking page does, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new BlitzTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' })
      .fetch(` ${NUMBER.slice(0, 6)}-${NUMBER.slice(6).toLowerCase()} `, { budgetMs: 4000 });
    expect(result.status).toBe('delivered');
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe('https://track-api.blitznow.in/whitelisttrack/api/track/');
    expect(JSON.parse(init.body as string)).toEqual({ field: 'shipment', value: NUMBER });
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json', Origin: 'https://track.blitznow.in', 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'blitznow', step: 'direct', outcome: 'ok' }));
  });

  it("reads a delivered parcel's status and the day the tracker shows for it, without a history", () => {
    expect(parseBlitz(reply().result, NUMBER)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-04-11T10:01:58+05:30', expected_delivery: null, delivered_at: '2026-04-11T10:01:58+05:30',
      summary_only: true, events: [],
    });
    const other = reply('delivered-2.json').result;
    expect(parseBlitz(other, other.shipmentDetails.awbnumber as string)).toMatchObject({ status: 'delivered', delivered_at: '2026-04-10T22:23:31+05:30' });
  });

  it('reads the scan rows newest first at the instants they state, without their remarks', () => {
    const result = parseBlitz(onTheWay([ROWS[2], ROWS[0], ROWS[1]]), NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-04-11T08:15:00+05:30',
      expected_delivery: '2026-04-11' });
    expect(result.summary_only).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
    expect(result.events).toEqual([
      { time: '2026-04-11T08:15:00+05:30', description: 'Out for Delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-04-10T13:00:00Z', description: 'Picked-up', stage: 'accepted', stage_source: 'carrier_map' },
      { time: '2026-04-10T10:26:12Z', description: 'Awb Generated', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toContain('Synthetic remark');
  });

  it('rejects scan rows without a stated offset, and leaves out an estimate without one', () => {
    for (const timestamp of ['2026-04-11T08:15:00', '2026-02-30T08:15:00+05:30', '2026-04-11T08:15:00+25:00', 1_000]) {
      expect(() => parseBlitz(onTheWay([{ ...ROWS[0], timestamp }]), NUMBER), String(timestamp)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBlitz(onTheWay([{ timestamp: ROWS[0]!.timestamp }]), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBlitz(onTheWay({}), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const naive = onTheWay(null);
    (naive.shipmentDetails as Record<string, unknown>).buyerEDD = '2026-04-11T00:00:00.000';
    expect(parseBlitz(naive, NUMBER)).toMatchObject({ expected_delivery: null, summary_only: true });
  });

  it('binds the reply to the number asked', () => {
    expect(() => parseBlitz(reply().result, `${NUMBER.slice(0, -1)}${NUMBER.endsWith('1') ? '2' : '1'}`))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const missing = reply().result;
    delete missing.shipmentDetails.awbnumber;
    expect(() => parseBlitz(missing, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const blank = reply().result;
    blank.shipmentDetails.shipmentstatus = '';
    expect(() => parseBlitz(blank, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reports an unknown number as not found, and never a refusal or an outage', async () => {
    expect(() => blitzPayload(text('not-found.json'), 500)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The same words without the HTTP 500, or another failure, are not an answer about the parcel.
    expect(() => blitzPayload(text('not-found.json'), 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => blitzPayload('{"result":null,"status":"Internal Server Error : timeout","code":"501"}', 500))
      .not.toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => blitzPayload('{"code":"200","status":"Success","result":null}', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => blitzPayload('<html><title>Just a moment...</title></html>', 403)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => blitzPayload('<html>Error</html>', 200)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => blitzPayload('<html>Error</html>', 500)).not.toThrow(expect.objectContaining({ kind: 'not_found' }));
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(text('not-found.json'), 500));
    await expect(new BlitzTracker({ fetcher: unknown }).fetch('ZZ0000000000')).rejects.toMatchObject({ kind: 'not_found' });
    for (const status of [403, 429, 503]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('not-found.json'), status));
      await expect(new BlitzTracker({ fetcher }).fetch(NUMBER, { budgetMs: 2000 })).rejects.not.toMatchObject({ kind: 'not_found' });
    }
  });

  it('rejects malformed input before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new BlitzTracker({ fetcher }).fetch('GS/845')).rejects.toMatchObject({ kind: 'invalid_input' });
    for (const raw of ['GS12', 'ABCDEFGH', `GS${'1'.repeat(39)}`]) expect(() => normalizeBlitzNumber(raw), raw).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Blitz status map', () => {
  it('stages every status the tracker lists and leaves its placeholder without one', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(blitzStage(entry.wording), entry.wording).toBe(entry.stage);
    }
    expect(statusMap.gaps.map(gap => gap.wording)).toEqual(['status not defined']);
    expect(blitzStage('IN-TRANSIT')).toBe('in_transit');
    expect(parseBlitz(onTheWay(null, 'Status Not Defined'), NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Status Not Defined' });
  });
});
