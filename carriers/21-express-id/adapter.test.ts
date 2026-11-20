import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import {
  adapter, normalizeTwentyOneExpressNumber, parseTwentyOneExpress, TWENTY_ONE_EXPRESS_LOOKUP, TWENTY_ONE_EXPRESS_PAGE, TwentyOneExpressTracker,
} from './adapter.js';
import { twentyOneExpressStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import missed from './fixtures/waybill-100700345592.json' with { type: 'json' };
import sample from './fixtures/waybill-105400058018.json' with { type: 'json' };
import unknown from './fixtures/not-found.json' with { type: 'json' };

const NUMBER = sample.status[0]!.code;
const MISSED = missed.status[0]!.code;
// Invented: the page's token and the cookies it sets, in the shapes the page uses.
const TOKEN = 'synthetic_form_token_for_tests==';
const PAGE = `<!DOCTYPE html><html><head><meta name="csrf-param" content="_csrf"><meta name="csrf-token" content="${TOKEN}"></head>`
  + `<body><form id="form-tracking"><input type="hidden" name="_csrf" value="${TOKEN}"></form></body></html>`;
const COOKIES = ['PHPSESSID=synthetic0session; path=/; HttpOnly', '_csrf=synthetic0cookie; path=/; HttpOnly'];

type Answer = { status?: number; body?: string; cookies?: string[] };
function harness(lookup: Answer = { body: JSON.stringify(sample) }, page: Answer = { body: PAGE, cookies: COOKIES }) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const answer = String(url) === TWENTY_ONE_EXPRESS_PAGE ? page : lookup;
    return new Response(answer.body ?? '', { status: answer.status ?? 200, headers: [['Content-Type', 'text/html; charset=UTF-8'],
      ...(answer.cookies ?? []).map((cookie) => ['Set-Cookie', cookie] as [string, string])] });
  });
  return { fetcher, tracker: new TwentyOneExpressTracker({ fetcher, recorder: NOOP_RECORDER }) };
}

describe('21 Express tracker', () => {
  it('reads a published waybill: picked up at Bekasi, sent on and received', () => {
    const result = parseTwentyOneExpress(sample, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'RECEIVED',
      last_update: null, last_update_local: '2023-04-08T16:59:00', expected_delivery: null, destination_country: 'ID' });
    expect(result.events!.map(({ local_time, description, stage }) => [local_time, description, stage])).toEqual([
      ['2023-04-08T16:59:00', 'RECEIVED', 'delivered'],
      ['2023-04-08T09:40:00', 'DELIVERY', 'out_for_delivery'],
      ['2023-04-07T14:36:00', 'INCOMING', 'in_transit'],
      ['2023-04-05T06:47:00', 'WAYBILLED', 'in_transit'],
      ['2023-04-04T21:48:00', 'MANIFESTED', 'in_transit'],
      ['2023-04-04T15:54:00', 'ACCEPTANCE', 'accepted'],
      ['2023-04-04T15:54:00', 'PICK UP', 'accepted'],
    ]);
    expect(result.events![0]).toEqual({ local_time: '2023-04-08T16:59:00', description: 'RECEIVED', provider_code: 'RECEIVED', stage: 'delivered', stage_source: 'carrier_map' });
    // The rows name the shipper, the consignee, the courier and whoever scanned the parcel; on
    // the delivery's row, whoever took it.
    const received = sample.pod.find((row) => row.status_type === 'RECEIVED')!;
    expect(result.signed_by).toBe(received.status_by);
    const names = sample.pod.flatMap((row) => [row.shipper_name, row.consignee_name, row.messenger_name, ...(row === received ? [] : [row.status_by])])
      .filter((name) => name.trim().length > 2);
    for (const name of names) expect(JSON.stringify({ ...result, signed_by: null }), 'a name').not.toContain(name.trim());
  });

  it('reads a missed delivery among the attempts of the other published waybill', () => {
    const result = parseTwentyOneExpress(missed, MISSED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2023-04-03T18:08:00' });
    expect(result.events).toHaveLength(10);
    expect(result.events!.filter((event) => event.stage === 'failed_attempt').map((event) => event.local_time)).toEqual(['2023-03-30T22:48:00']);
    expect(result.events!.filter((event) => event.description === 'DELIVERY')).toHaveLength(3);
  });

  it('keeps a row it cannot stage, once, and newest first', () => {
    // Invented: a status type the map does not know, and the first row repeated.
    const reply = structuredClone(sample);
    reply.pod.push({ ...reply.pod[0]!, status_type: 'RETURN TO SHIPPER', status_date: '2023-04-09', status_time: '10-00' }, { ...reply.pod[0]! });
    const result = parseTwentyOneExpress(reply, NUMBER);
    expect(result.events).toHaveLength(8);
    expect(result.events![0]).toEqual({ local_time: '2023-04-09T10:00:00', description: 'RETURN TO SHIPPER', provider_code: 'RETURN TO SHIPPER' });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'RETURN TO SHIPPER' });
    reply.pod = [reply.pod.at(-2)!];
    expect(parseTwentyOneExpress(reply, NUMBER)).toMatchObject({ status: 'unknown', events: [{ description: 'RETURN TO SHIPPER' }] });
    expect(parseTwentyOneExpress(reply, NUMBER)).not.toHaveProperty('current_stage');
    expect(parseTwentyOneExpress(reply, NUMBER)).not.toHaveProperty('signed_by');
  });

  it('answers only for the waybill asked', () => {
    expect(() => parseTwentyOneExpress(unknown, NUMBER)).toThrow(NotFoundError);
    expect(() => parseTwentyOneExpress(sample, MISSED)).toThrow(IndeterminateError);
    expect(() => parseTwentyOneExpress({ ...sample, status: [] }, MISSED)).toThrow(IndeterminateError);
    expect(() => parseTwentyOneExpress({ ...sample, pod: [] }, NUMBER)).toThrow(IndeterminateError);
  });

  it('refuses a reply it cannot read', () => {
    expect(() => parseTwentyOneExpress(null, NUMBER)).toThrow(SchemaError);
    expect(() => parseTwentyOneExpress({ pod: [] }, NUMBER)).toThrow(SchemaError);
    expect(() => parseTwentyOneExpress({ pod: null, status: [] }, NUMBER)).toThrow(SchemaError);
    const row = sample.pod[0]!;
    for (const change of [{ status_date: '08-04-2023' }, { status_date: '1999-04-08' }, { status_date: '2023-02-30' }, { status_time: '24-00' },
      { status_time: '' }, { status_type: ' ' }]) {
      expect(() => parseTwentyOneExpress({ ...sample, pod: [{ ...row, ...change }] }, NUMBER), JSON.stringify(change)).toThrow(SchemaError);
    }
    expect(() => parseTwentyOneExpress({ ...sample, pod: ['row'] }, NUMBER)).toThrow(SchemaError);
    expect(() => parseTwentyOneExpress({ ...sample, pod: Array.from({ length: 301 }, () => row) }, NUMBER)).toThrow(SchemaError);
  });

  it('takes twelve digits and refuses anything else before asking', async () => {
    expect(normalizeTwentyOneExpressNumber(' 1054-0005-8018 ')).toBe(NUMBER);
    const h = harness();
    for (const number of ['10540005801', '1054000580188', '10540005801A', 'ABCDEFGHIJKL', '']) {
      await expect(h.tracker.fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const { number } of numbers.records) expect(detectCarrierMatch(number).carrier, number).not.toBe('21-express-id');
  });

  it('posts the form token with the session the page opened', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(String(h.fetcher.mock.calls[0]?.[0])).toBe('https://21express.co.id/track');
    const [url, init] = h.fetcher.mock.calls[1]!;
    expect(String(url)).toBe(TWENTY_ONE_EXPRESS_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', headers: { Cookie: 'PHPSESSID=synthetic0session; _csrf=synthetic0cookie', Referer: TWENTY_ONE_EXPRESS_PAGE } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ _csrf: TOKEN, rec: NUMBER });
    expect(adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null, fetcher: h.fetcher }))
      .toMatchObject({ id: '21-express-id', steps: ['direct', 'retry'] });
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
  });

  it('tries once more when the tracker cannot be reached', async () => {
    const h = harness();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(h.fetcher);
    await expect(new TwentyOneExpressTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reads an unknown waybill as not found, a refused session as inconclusive and a browser check as a challenge', async () => {
    await expect(harness({ body: JSON.stringify(unknown) }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    const refused = harness({ status: 400, body: 'Bad Request (#400): Unable to verify your data submission.' });
    await expect(refused.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(harness(undefined, { body: PAGE }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(harness(undefined, { status: 403, body: '<title>Just a moment...</title>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness(undefined, { body: '<html>maintenance</html>', cookies: COOKIES }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness({ body: '<title>Attention Required! | Cloudflare</title>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness({ body: '<html>maintenance</html>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness({ status: 404 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness(undefined, { status: 302 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness({ status: 429 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(harness({ status: 503 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'maintenance', status: 503 });
  });

  it('keeps the session out of a failure', async () => {
    const error = await harness({ status: 500 }).tracker.fetch(NUMBER).catch((caught: unknown) => caught);
    expect(JSON.stringify(error)).not.toMatch(/synthetic/);
    expect(error).toMatchObject({ kind: 'indeterminate', status: 500 });
  });

  it('maps every status it has seen', () => {
    for (const entry of statuses.entries) {
      expect(twentyOneExpressStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: '21-express-id', providerCode: entry.code, description: entry.wording }), entry.code).toMatchObject({ kind: 'mapped', stage: entry.stage });
      expect(statusMapAnswer({ carrier: '21-express-id', description: entry.wording }), entry.wording).toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
    expect(twentyOneExpressStage('RETURN TO SHIPPER')).toBeUndefined();
  });
});
