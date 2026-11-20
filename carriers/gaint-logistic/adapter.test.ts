import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GAINT_CAPTCHA_API, GAINT_TRACK_API, GaintTracker } from './adapter.js';
import { normalizeGaintNumber, parseGaint, readGaintCode } from './parser.js';
import { gaintStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, its AWB in the reply, and an invented number.
const SAMPLE = '600011852';
const AWB = 'GNTB2B165397';
const UNKNOWN = 'ZZ0000000000';

type Order = { order: Record<string, unknown>; courier: Record<string, unknown>; events: Record<string, unknown>[] };
const fixture = <T = Record<string, unknown>>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
/** The sample's order with more scans, changed by `edit`. */
const order = (edit: (payload: Order) => void = () => {}) => {
  const payload = fixture<Order>('booked');
  edit(payload);
  return payload;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** A fetcher that shows the synthetic code, then answers the lookups in turn. */
const tracker = (...lookups: Response[]) => {
  const queue = [...lookups];
  return vi.fn<typeof fetch>(async (url) => String(url) === GAINT_CAPTCHA_API ? reply(fixture('captcha')) : queue.shift()!);
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Gaint Logistic HTTP adapter', () => {
  it('reads the security code from its picture and sends it with the whole number, through the supplied transport', async () => {
    const fetcher = tracker(reply(fixture('booked')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GaintTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 6000-11852 ', { budgetMs: 2000.5 }))
      .resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([[GAINT_CAPTCHA_API, 'GET'], [GAINT_TRACK_API, 'POST']]);
    const [, init] = fetcher.mock.calls[1]!;
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    // The picture lists its characters out of order; read by their place, they spell the code.
    expect(JSON.parse(String(init!.body))).toEqual({ awb: SAMPLE, captchaToken: 'synthetic-token.not-signed', captchaAnswer: 'K7Q2M' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'gaint-logistic', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the order under its LR or its AWB, with the scan Gaint gives', () => {
    for (const number of [SAMPLE, AWB]) {
      expect(parseGaint(fixture('booked'), number)).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
        last_status_text: 'Booking Received', last_update: '2026-10-10T09:36:56.625Z', expected_delivery: null, service_name: 'Gaint 10Kg Courier',
        events: [{ time: '2026-10-10T09:36:56.625Z', description: 'Booking Received', stage: 'registered', stage_source: 'carrier_map' }] });
    }
    expect(() => parseGaint(fixture('booked'), '600011853')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('lists relayed scans newest first and leads with the order’s delivery or return', () => {
    const scans = [
      { id: '2', eventDate: '2026-10-11T04:10:00.000Z', statusName: 'Picked Up', location: 'Bhiwandi' },
      { id: '3', eventDate: '2026-10-12T06:30:00.000Z', statusName: 'Out For Delivery', location: 'Sonepat' },
      { id: '4', eventDate: '2026-10-12T11:05:00.000Z', statusName: 'Delivered', location: 'Sonepat' },
    ];
    const delivered = parseGaint(order((payload) => {
      payload.events.push(...scans);
      Object.assign(payload.order, { status: 'Delivered', isDelivered: true });
    }), SAMPLE);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-10-12T11:05:00Z', delivered_at: '2026-10-12T11:05:00Z' });
    expect(delivered.events!.map((event) => [event.description, event.location, event.stage])).toEqual([
      ['Delivered', 'Sonepat', 'delivered'], ['Out For Delivery', 'Sonepat', 'out_for_delivery'],
      ['Picked Up', 'Bhiwandi', 'accepted'], ['Booking Received', undefined, 'registered']]);

    const returning = parseGaint(order((payload) => {
      payload.events.push(scans[0]!, { id: '5', eventDate: '2026-10-14T08:00:00.000Z', statusName: 'RTO Delivered', location: 'Bhiwandi' });
      Object.assign(payload.order, { status: 'RTO Delivered', isDelivered: true, isRto: true });
    }), SAMPLE);
    expect(returning).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'RTO Delivered' });
    expect(returning).not.toHaveProperty('delivered_at');
    expect(returning.events![0]).toMatchObject({ description: 'RTO Delivered', stage: 'returned', stage_source: 'carrier_map' });

    // A status no rule reads leaves the newest scan with a stage; a scan no rule reads keeps no stage.
    const unread = parseGaint(order((payload) => {
      payload.events.push(scans[0]!, { id: '6', eventDate: '2026-10-11T09:00:00.000Z', statusName: 'Manifested', location: '' });
      payload.order.status = 'Manifested';
    }), SAMPLE);
    expect(unread).toMatchObject({ current_stage: 'accepted', last_status_text: 'Manifested' });
    expect(unread.events![0]).not.toHaveProperty('stage');
  });

  it('reads an unknown number as not found and an order without scans as listed', async () => {
    await expect(carrier(tracker(reply(fixture('not-found'), { status: 404 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(tracker(reply({ message: 'Not here' }, { status: 404 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => parseGaint(order((payload) => { payload.events = []; }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => parseGaint(order((payload) => { payload.events[0]!.eventDate = '10/10/2026'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGaint({ message: 'ok' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes one more code when the first does not match, and stops at the second', async () => {
    const once = tracker(reply(fixture('code-mismatch'), { status: 400 }), reply(fixture('booked')));
    await expect(carrier(once).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'registered' });
    expect(once).toHaveBeenCalledTimes(4);
    const twice = tracker(reply(fixture('code-mismatch'), { status: 400 }), reply(fixture('code-mismatch'), { status: 400 }));
    await expect(carrier(twice).track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'challenge' });
    expect(twice).toHaveBeenCalledTimes(4);
  });

  it('keeps a changed picture, a firewall, a rate limit and a moved route apart from a missing order', async () => {
    expect(() => readGaintCode({ token: 't', image: 'data:image/png;base64,AAAA' })).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => readGaintCode({ token: 't', image: `data:image/svg+xml;base64,${btoa('<svg><text x="1">A</text></svg>')}` }))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(readGaintCode({ token: 't', image: `data:image/svg+xml;base64,${btoa('<svg><text x="9">d</text><text x="2.5">a</text><text x="4">7</text><text x="8">c</text></svg>')}` }))
      .toEqual({ token: 't', answer: 'A7CD' });
    const answer = (response: Response) => carrier(tracker(response)).track({ number: SAMPLE });
    await expect(answer(reply('<html><title>Just a moment...</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(reply('{}', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(reply('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(answer(reply('<html>maintenance</html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer(reply({ message: 'Enter a number', field: 'awb' }, { status: 400 }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('retries once when the first request does not reach Gaint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('captcha'))).mockResolvedValueOnce(reply(fixture('booked')));
    await expect(carrier(fetcher).track({ number: SAMPLE }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('sends only letters and digits of an AWB or LR', () => {
    expect(normalizeGaintNumber(' gntb2b-165397 ')).toBe(AWB);
    for (const bad of ['60001', 'ABCDEFGH', '600011852!', '1'.repeat(31), '']) {
      expect(() => normalizeGaintNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the wordings statuses.json records', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'gaint-logistic', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
      expect(gaintStage(wording)).toEqual({ stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'gaint-logistic', providerCode: null, description: 'Picked Up' })).toEqual({ kind: 'unknown' });
  });
});
