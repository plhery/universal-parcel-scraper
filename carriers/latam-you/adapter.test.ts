import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LATAM_YOU_LOOKUP } from './adapter.js';
import { normalizeLatamYouNumber, parseLatamYou } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's reply; the tests derive replies for invented numbers from it.
const SAMPLE = 'LTYBRPD2304000216';
const OTHER = 'LTYMXPD9912000017';

type Row = Record<string, unknown> & { sourceNo: string; currentState: number; currentStateShow: string; actTimeShow: string };
type Reply = { totalCount: number; obj: Row[]; success: boolean };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The sample's rows under another number, with some rows changed or replaced. */
const reply = (change: (rows: Row[]) => Row[] = (rows) => rows): Reply => {
  const sample = fixture(SAMPLE);
  return { ...sample, obj: change(sample.obj.map((row) => ({ ...row, sourceNo: OTHER }))) };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scans = (result: ReturnType<typeof parseLatamYou>) => result.events!.map((event) => [event.time, event.description, event.provider_code, event.stage ?? null]);

describe('Latam You numbers', () => {
  it('takes LTY and letters or digits, in capitals', () => {
    expect(normalizeLatamYouNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const other of ['', 'LTY', 'LTYBRPD', 'LTYABCDEFGHIJ', 'XTYBRPD2304000216', 'LTYBRPD2304000216/1', `LTY${'1'.repeat(38)}`, 'BR123456789CN']) {
      expect(() => normalizeLatamYouNumber(other), other).toThrow('Latam You order numbers start with LTY');
    }
  });

  it('claims the order numbers', () => {
    expect(detectCarrierMatch(SAMPLE)).toMatchObject({ carrier: 'latam-you', confidence: 'high' });
    expect(detectCarrierMatch(OTHER)).toMatchObject({ carrier: 'latam-you', confidence: 'high' });
  });
});

describe('Latam You tracking adapter', () => {
  it('asks the lookup behind the guest tracker for the number in capitals', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(SAMPLE)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LATAM_YOU_LOOKUP}?inputNo=${SAMPLE}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'latam-you', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the empty list the tracker shows as no order found as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, checks, failures, pages and moved routes apart from a missing order', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({ message: 'Too Many Requests' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('<html>Request blocked</html>', { status: 403, headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('<title>502 Bad Gateway</title>', { status: 502, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://latamyou.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('Action not found', { status: 404, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    // The service's refusal of an empty number, or any other failed lookup.
    expect(await answer(() => json({ success: false, msg: '请输入单号' }))).toMatchObject({ kind: 'indeterminate' });
    // A reply for another order says nothing about this one.
    expect(await answer(() => json(fixture(SAMPLE)))).toMatchObject({ kind: 'indeterminate' });
  });
});

describe('Latam You replies', () => {
  it("reads the sample: the line's rows and Cainiao's last mile in Brazil, as instants at GMT+08:00", () => {
    const result = normalizeCarrierResult(parseLatamYou(fixture(SAMPLE), SAMPLE));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Successful', last_update: '2023-05-09T20:46:00+08:00', delivered_at: '2023-05-09T20:46:00+08:00',
      expected_delivery: null, destination_country: 'BR' });
    expect(scans(result)).toEqual([
      ['2023-05-09T20:46:00+08:00', 'Delivery Successful', '40', 'delivered'],
      ['2023-05-04T11:39:00+08:00', 'Waiting Delivery', '35', 'in_transit'],
      ['2023-04-26T18:16:00+08:00', 'In Clearance Completed', '33', 'in_transit'],
      ['2023-04-26T17:01:00+08:00', 'Waiting Delivery', '35', 'in_transit'],
      ['2023-04-23T09:51:12+08:00', 'Arriving in the local country', '30', 'in_transit'],
      ['2023-04-22T10:48:22+08:00', 'DEPARTURE', '28', 'in_transit'],
      ['2023-04-21T10:18:22+08:00', 'CLEARANCE_COMPLETED', '27', 'in_transit'],
      ['2023-04-21T10:17:52+08:00', 'STOCKOUT', '25', 'in_transit'],
      ['2023-04-21T09:53:51+08:00', 'PACK', '23', 'in_transit'],
      ['2023-04-18T13:24:36+08:00', 'Collected', '20', 'accepted'],
      ['2023-04-18T13:11:19+08:00', 'Order Place', '10', 'registered'],
    ]);
    // The operator, the rows' second line and the notification fields stay behind.
    expect(JSON.stringify(result)).not.toMatch(/operator|example\.com|GTMS|CC_IM|place order|receive successful|pack order|CAINIAO|root|运单/i);
  });

  it("reads each row's clock as the instant it states, whatever the row's place", () => {
    const result = parseLatamYou(reply((rows) => {
      rows[0]!.actTimeShow = '2023-05-09 08:46:00GMT-03:00';
      return rows;
    }), OTHER);
    expect(result.events![0]).toMatchObject({ time: '2023-05-09T08:46:00-03:00' });
    expect(result.events![0]).not.toHaveProperty('local_time');
  });

  it('orders rows by their instants, newest first, and reads a repeated row once', () => {
    const result = parseLatamYou(reply((rows) => [...rows].reverse().concat({ ...rows[1]!, id: 1 })), OTHER);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['40', '35', '33', '35', '30', '28', '27', '25', '23', '20', '10']);
    // Of two rows at one instant, the reply lists the newer first.
    const tied = parseLatamYou(reply((rows) => [{ ...rows[0]!, currentState: 2000, currentStateShow: 'Other' }, ...rows]), OTHER);
    expect(tied.events!.slice(0, 2).map((event) => event.provider_code)).toEqual(['2000', '40']);
  });

  it("reads the line's other states by their codes, and a code it does not know by its label", () => {
    const newest = (state: number, label: string) => parseLatamYou(reply((rows) => [{ ...rows[0]!, currentState: state, currentStateShow: label }, ...rows.slice(1)]), OTHER);
    expect(newest(1300, 'Import Customs Exception')).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Import Customs Exception' });
    expect(newest(800, 'Return')).toMatchObject({ current_stage: 'returned' });
    expect(newest(29, '')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'FLIGHT_ARRIVAL' });
    // Other says nothing of where the parcel is: the row before it sets the stage.
    expect(newest(2000, 'Other')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Waiting Delivery' });
    expect(newest(2000, 'Other').events![0]).not.toHaveProperty('stage');
    // A code the state list does not give keeps its label and no stage; it may have undone nothing but the delivery.
    const unknown = newest(45, 'Example new state');
    expect(unknown.events![0]).toMatchObject({ description: 'Example new state', provider_code: '45' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ current_stage: 'in_transit' });
    expect(newest(45, '').events![0]).toMatchObject({ description: '45' });
    // A delivery a newer unknown row follows is not taken as the stage.
    const after = parseLatamYou(reply((rows) => [{ ...rows[0]!, currentState: 45, currentStateShow: 'Example new state', actTimeShow: '2023-05-10 10:00:00GMT+08:00' }, ...rows]), OTHER);
    expect(after).toMatchObject({ status: 'unknown' });
    expect(after).not.toHaveProperty('delivered_at');
    // Other after the delivery leaves the delivery standing.
    const noted = parseLatamYou(reply((rows) => [{ ...rows[0]!, currentState: 2000, currentStateShow: 'Other', actTimeShow: '2023-05-10 10:00:00GMT+08:00' }, ...rows]), OTHER);
    expect(noted).toMatchObject({ current_stage: 'delivered', delivered_at: '2023-05-09T20:46:00+08:00' });
  });

  it('gives the destination only for a country the line serves', () => {
    expect(parseLatamYou(reply(), OTHER)).toMatchObject({ destination_country: 'MX' });
    const elsewhere = 'LTYZZPD9912000017';
    const result = parseLatamYou({ ...reply(), obj: reply().obj.map((row) => ({ ...row, sourceNo: elsewhere })) }, elsewhere);
    expect(result).not.toHaveProperty('destination_country');
  });

  it('keeps a reply naming another order, or several, inconclusive', () => {
    expect(() => parseLatamYou(fixture(SAMPLE), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = reply((rows) => [{ ...rows[0]!, sourceNo: SAMPLE }, ...rows.slice(1)]);
    expect(() => parseLatamYou(mixed, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLatamYou({ success: false, msg: '系统异常' }, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLatamYou(fixture('not-found'), OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('refuses a changed reply', () => {
    const row = (changes: Record<string, unknown>) => reply((rows) => [{ ...rows[0]!, ...changes }, ...rows.slice(1)]);
    const changed = [null, {}, { success: 'true', obj: [] }, { success: true }, { success: true, obj: {} }, { success: true, obj: [7] },
      row({ sourceNo: undefined }), row({ sourceNo: 7 }), row({ currentState: '40' }), row({ currentState: 40.5 }), row({ currentState: undefined }),
      row({ actTimeShow: '2023-05-09 20:46:00' }), row({ actTimeShow: '2023-02-30 20:46:00GMT+08:00' }), row({ actTimeShow: 'May 9, 2023, 8:46:0 PM' }),
      row({ currentStateShow: 7 })];
    for (const payload of changed) {
      expect(() => parseLatamYou(payload, OTHER), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Latam You status vocabulary', () => {
  it('records every state with the stage it gives, and the catch-all as a gap', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string; note: string }[]) {
      const answer = statusMapAnswer({ carrier: 'latam-you', providerCode: entry.code, description: entry.wording });
      expect(answer, entry.code).toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: entry.note });
    }
    expect(statusMap.stage('45', 'example new state')).toBeUndefined();
    expect(statusMap.stage(null, 'delivery successful')).toBeUndefined();
  });
});
