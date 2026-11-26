import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, xendnowApiUrl } from './adapter.js';
import { normalizeXendnowNumber, parseXendnow } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

type Row = Record<string, string>;
// The example box on XendNow's tracking page (numbers.json), and an invented one.
const SAMPLE = 'EX03200305NC0410';
const UNKNOWN = 'EX03991231ZZ9999';
const fixture = (name: string): Row[] => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const history = fixture('history');
const detail = fixture('detail');
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const routes = (answers: { history?: () => Response; detail?: () => Response }) => vi.fn<typeof fetch>().mockImplementation(async (url) => (
  String(url).includes('/track_parcel_history/') ? (answers.history ?? (() => json(history)))() : (answers.detail ?? (() => json(detail)))()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, userAgent: 'XendNow test agent', recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A card that names a DHL number.
const handedOver = (id: string) => [{ ...detail[0]!, is_dhl: '1', trackingid_for_dhl: id }];

describe('XendNow numbers', () => {
  it('takes a box id in letters and digits', () => {
    expect(normalizeXendnowNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const other of ['', 'EX123', 'EXABCDEFGH', `${SAMPLE},${SAMPLE}`, `EX${'1'.repeat(29)}`]) {
      expect(() => normalizeXendnowNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('XendNow tracking adapter', () => {
  it('asks the tracking API for the scans and the box’s card with the tracking page’s credential', async () => {
    const fetcher = routes({});
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `https://integration.xendnow.my/delivery_history.svc/track_parcel_detail/${SAMPLE}`,
      `https://integration.xendnow.my/delivery_history.svc/track_parcel_history/${SAMPLE}`,
    ]);
    expect(xendnowApiUrl('track_parcel_history', SAMPLE)).toBe(`https://integration.xendnow.my/delivery_history.svc/track_parcel_history/${SAMPLE}`);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
      const headers = new Headers(init?.headers);
      expect(atob(headers.get('Authorization')!.replace(/^Basic /, ''))).toMatch(/^xenduser:/);
      expect(headers.get('User-Agent')).toBe('XendNow test agent');
    }
    expect(carrier(fetcher)).toMatchObject({ id: 'xendnow', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads two empty lists as not found, and a card without scans as no history', async () => {
    await expect(carrier(routes({ history: () => json([]), detail: () => json([]) })).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(routes({ history: () => json([]) })).track({ number: SAMPLE }))
      .rejects.toMatchObject({ name: 'NoHistoryError' });
  });

  it('keeps refusals, error pages and moved routes apart from a missing box', async () => {
    const answer = async (response: () => Response, which: 'history' | 'detail' = 'history') =>
      carrier(routes({ [which]: response })).track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('', { status: 500 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('', { status: 500 }), 'detail')).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => new Response('', { status: 401 }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('<p>Request Error</p>', { status: 400, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('<title>404</title>', { status: 404, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.xendnow.my/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('<title>Just a moment...</title>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html>Server Error</html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('XendNow replies', () => {
  it('reads the example box: coded wordings on a wall clock, without the receiver or the remarks', () => {
    const result = parseXendnow(history, detail, SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: '2',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2020-03-12T12:58:12', expected_delivery: null,
    });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events).toHaveLength(12);
    expect(result.events!.slice(0, 3)).toEqual([
      { local_time: '2020-03-12T12:58:12', description: 'Delivered', provider_code: '2', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2020-03-12T09:13:22', description: 'Ready For Pickup', provider_code: '1', stage: 'ready_for_pickup', stage_source: 'carrier_map' },
      { local_time: '2020-03-11T17:39:59', description: 'Failed Attempt-No Receiver', provider_code: '8', stage: 'failed_attempt', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.at(-1)).toEqual({ local_time: '2020-03-05T20:31:34', description: 'Shipment Picked Up', provider_code: '13', stage: 'accepted', stage_source: 'carrier_map' });
    // Rows listed oldest first come out in the same order.
    expect(parseXendnow([...history].reverse(), detail, SAMPLE).events).toEqual(result.events);
  });

  it('never carries the receiver, the signature, the remarks or the card’s address and phone', () => {
    const personal = history.map((row) => ({ ...row, receiver_name: 'Invented Receiver', receiver_ic: '000000000000',
      signature: 'invented-signature', dropoffsign: 'invented-proof', remark: 'Received by Invented Receiver' }));
    const card = [{ ...detail[0]!, address: 'Invented Street', hp: '0000000000' }];
    const text = JSON.stringify(parseXendnow(personal, card, SAMPLE));
    for (const value of ['Invented', '000000000000', 'invented-signature', 'invented-proof', '0000000000', 'family member', 'Mon-Thu']) {
      expect(text).not.toContain(value);
    }
  });

  it('names the DHL number of a box DHL delivers', () => {
    // Invented numbers: ten digits with DHL Express's check digit, which several networks' rules offer,
    // and a plate only DHL Paket issues.
    expect(parseXendnow(history, handedOver('1234567891'), SAMPLE)).toMatchObject({ delivery_tracking_number: '1234567891', delivery_carrier: 'dhl-express' });
    expect(parseXendnow(history, handedOver('jjd000390007171234567'), SAMPLE)).toMatchObject({ delivery_tracking_number: 'JJD000390007171234567', delivery_carrier: 'dhl' });
    // A number no DHL network's rules take is named without a carrier.
    for (const id of ['1234567890', 'ZZ12AB']) {
      const unclaimed = parseXendnow(history, handedOver(id), SAMPLE);
      expect(unclaimed).toMatchObject({ delivery_tracking_number: id });
      expect(unclaimed).not.toHaveProperty('delivery_carrier');
    }
    for (const card of [handedOver(''), handedOver('12+34'), handedOver(SAMPLE), [{ ...detail[0]!, trackingid_for_dhl: '1234567891' }],
      [...handedOver('1234567891'), ...handedOver('1234567892')]]) {
      expect(parseXendnow(history, card, SAMPLE)).not.toHaveProperty('delivery_tracking_number');
    }
    expect(() => parseXendnow([], handedOver('1234567891'), SAMPLE)).toThrow(expect.objectContaining({
      name: 'NoHistoryError', deliveryCarrier: 'dhl-express', deliveryTrackingNumber: '1234567891',
    }));
  });

  it('stages an uncoded wording by the shared wording rules, else leaves it without a stage', () => {
    const rows = (status: string, DelStatus: string) => [{ ...history[0]!, status, DelStatus }, ...history.slice(1)];
    expect(parseXendnow(rows('3', 'Out For Delivery'), detail, SAMPLE)).toMatchObject({ provider_code: '3', current_stage: 'out_for_delivery' });
    const unknown = parseXendnow(rows('21', 'Zzz'), detail, SAMPLE);
    expect(unknown).toMatchObject({ provider_code: '21', last_status_text: 'Zzz', current_stage: 'ready_for_pickup' });
    expect(unknown.events![0]).toEqual({ local_time: '2020-03-12T12:58:12', description: 'Zzz', provider_code: '21' });
  });

  it('needs every row to be about the box asked', () => {
    expect(() => parseXendnow(history, detail, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXendnow([], detail, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXendnow([...history, { ...history[0]!, boxid: UNKNOWN }], detail, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const row = (change: Row) => [{ ...history[0]!, ...change }];
    for (const [rows, card] of [
      [{ d: [] }, detail], [history, {}], [null, detail], [[null], detail], [row({ boxid: '' }), detail],
      [row({ pdate: '12/03/2020 12:58' }), detail], [row({ pdate: '2020-02-30 12:58:12' }), detail],
      [row({ status: 'D' }), detail], [row({ DelStatus: '' }), detail], [row({ DelStatus: '<br/>Mon-Thu' }), detail],
    ] as const) {
      expect(() => parseXendnow(rows, card, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('XendNow statuses', () => {
  it('maps each status code the API returned', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'xendnow', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('99', 'zzz')).toBeUndefined();
  });
});
