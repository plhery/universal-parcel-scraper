import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { readMendrixTrackingUrl } from '../../core/catalog/urls.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { MENDRIX_API, mendrixSessionOrder, normalizeMaxPakketCode, parseMaxPakket } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, with the order number of its archived link, and an invented code.
const SAMPLE = 'MXTT88F27D091ABA1889';
const ORDER = '39118';
const LINK = `https://emens.mendrix.cloud/TrackAndTrace/tnt?Tracecode=${SAMPLE}&OrderId=${ORDER}`;
const OTHER = 'MXTT00000000000000AB';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const MILESTONES = fixture('milestones-delivered');
const NO_TRACES = fixture('traces-empty');
const NOT_FOUND = fixture('not-found');
const ADDRESS = fixture('address');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const text = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/plain', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const track = (fetcher: typeof fetch, number = SAMPLE, trackingUrl: string | null = LINK) =>
  carrier(fetcher).track({ number, ...(trackingUrl ? { trackingUrl } : {}) }, { budgetMs: 2000 });

// The session cookie the address lookup sets: the order it opened, in base64 JSON, and a signature.
const session = (fields: Record<string, unknown> = {}) => `${btoa(JSON.stringify({
  OrderId: Number(ORDER), ClientId: 89, Tracecode: SAMPLE, type: 'TEoTraceInfo', Postalcode: '', Number: '', ...fields,
}))}.${'ab12'.repeat(16)}`;
const opened = (cookie = session()) => json(ADDRESS, { headers: { 'Set-Cookie': `mxtt_traceinfo=${cookie};Path=/;SameSite=Lax;Secure;HttpOnly` } });

/** A fetcher that answers the tracking app's reads by their path. */
function api(answers: { address?: () => Response; milestones?: () => Response; traces?: () => Response } = {}) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname.split('/').at(-1);
    if (path === 'address') return (answers.address ?? opened)();
    if (path === 'milestones') return (answers.milestones ?? (() => json(MILESTONES)))();
    if (path === 'traces') return (answers.traces ?? (() => json(NO_TRACES)))();
    return text('', { status: 404 });
  });
}

const milestones = (states: [string, string, string?][], summary: Record<string, unknown> = {}) => ({
  type: 'TEoTrackAndTrace_MilestoneList_Response',
  Milestones: states.map(([name, status, completion], index) => ({
    Name: `E_MILESTONES_NAME_${name}`, StatusCode: `E_MILESTONES_STATUSCODE_${status}`, SortId: index + 1,
    CompletionStatusCode: completion ? `E_MILESTONES_COMPLETION_STATUSCODE_${completion}` : 'E_MILESTONES_COMPLETION_STATUSCODE_NONE',
    StatusSummary: { ContactSigned: '', Consignor: 'Online sender', OrderMoment: '2026-11-20T09:15:00+01:00', MomentRta: '2026-11-25T08:00:00+01:00',
      MomentRtd: '2026-11-25T18:00:00+01:00', MomentPta: '0001-01-01T00:00:00+00:00', MomentPtd: '0001-01-01T00:00:00+00:00',
      MomentAta: '0001-01-01T00:00:00+00:00', MomentAtd: '0001-01-01T00:00:00+00:00', Signature: '', ...summary },
  })),
});
const traces = (rows: Record<string, unknown>[]) => ({ type: 'TEoTrackAndTrace_TraceList_Response', Traces: rows });

describe('MAX Pakket codes and links', () => {
  it('takes MXTT and hexadecimal digits, in capitals', () => {
    expect(normalizeMaxPakketCode(` ${SAMPLE.toLowerCase().slice(0, 8)} ${SAMPLE.slice(8)} `)).toBe(SAMPLE);
    for (const other of ['', 'MXTT1234567', 'MXTT88F27D091ABA188G', `XXTT${SAMPLE.slice(4)}`, `${SAMPLE};${OTHER}`, `MXTT${'A'.repeat(33)}`]) {
      expect(() => normalizeMaxPakketCode(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps the email’s track and trace link bound to the whole code and its order number', () => {
    expect(readMendrixTrackingUrl(`https://EMENS.mendrix.cloud/TrackAndTrace/tnt/?tracecode=${SAMPLE.toLowerCase()}&orderid=${ORDER}&utm_source=mail`,
      SAMPLE, 'max-pakket')).toEqual({ url: LINK, host: 'emens.mendrix.cloud', code: SAMPLE, orderId: ORDER });
    expect(normalizeCarrierInputs('max-pakket', SAMPLE, ` ${LINK} `, '')).toMatchObject({ trackingUrl: LINK });
    for (const other of [
      LINK.replace('https:', 'http:'), LINK.replace('emens.', 'other.'), LINK.replace('/tnt', '/track'), `${LINK}#x`, `${LINK}&OrderId=1`,
      LINK.replace(`&OrderId=${ORDER}`, ''), LINK.replace(ORDER, '0'), LINK.replace(SAMPLE, OTHER), `${LINK}&Postalcode=1234AB`,
      LINK.replace('https://', 'https://user@'), LINK.replace('.cloud/', '.cloud:8443/'),
    ]) {
      expect(() => readMendrixTrackingUrl(other, SAMPLE, 'max-pakket'), other).toThrow(TypeError);
    }
    expect(() => readMendrixTrackingUrl(LINK, SAMPLE, 'boxc')).toThrow(TypeError);
  });

  it('reads the order the session cookie names, and refuses one without a client', () => {
    expect(mendrixSessionOrder(session())).toEqual({ code: SAMPLE, orderId: ORDER });
    expect(mendrixSessionOrder(session({ ClientId: 0 }))).toBeNull();
    expect(mendrixSessionOrder(session({ OrderId: '39118' }))).toBeNull();
    expect(mendrixSessionOrder(`${btoa('not json')}.${'ab12'.repeat(16)}`)).toBeNull();
    expect(mendrixSessionOrder(session().split('.')[0]!)).toBeNull();
  });
});

describe('MAX Pakket tracking adapter', () => {
  it('opens the order with the link’s code and order number, then reads its milestones and scans in that session', async () => {
    const fetcher = api();
    await expect(track(fetcher)).resolves.toMatchObject({ current_stage: 'delivered', last_status_text: 'Succesvol afgeleverd' });
    const calls = fetcher.mock.calls.map(([url, init]) => ({ url: String(url), cookie: new Headers(init?.headers).get('cookie'), init }));
    expect(calls.map((call) => call.url)).toEqual([
      `${MENDRIX_API}/address?Tracecode=${SAMPLE}&Orderid=${ORDER}`, `${MENDRIX_API}/milestones`, `${MENDRIX_API}/traces`,
    ]);
    expect(calls[0]!.cookie).toBeNull();
    for (const call of calls.slice(1)) expect(call.cookie).toBe(`mxtt_traceinfo=${session()}`);
    for (const call of calls) expect(call.init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'max-pakket', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('asks for the link, and refuses one for another code', async () => {
    const fetcher = api();
    await expect(Promise.resolve().then(() => track(fetcher, SAMPLE, null))).rejects.toMatchObject({ kind: 'input_required' });
    await expect(Promise.resolve().then(() => track(fetcher, OTHER))).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads the API’s answer for a code and order number it holds no order under as not found', async () => {
    await expect(track(api({ address: () => text(NOT_FOUND, { status: 400 }) }))).rejects.toMatchObject({ kind: 'not_found' });
    const task = '{"Msg":"Invalid TraceInfo: unable to find traced route (invalid task))","type":"TEoTrackAndTrace_Error_Response","Code":400}';
    await expect(track(api({ address: () => text(task, { status: 400 }) }))).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, challenges, outages and changed replies apart from a missing order', async () => {
    const answer = (answers: Parameters<typeof api>[0]) => track(api(answers)).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    const refusal = (message: string, status = 400) => () => text(JSON.stringify({ Msg: message, type: 'TEoTrackAndTrace_Error_Response', Code: status }), { status });
    expect(await answer({ address: () => html(challenge, { status: 403 }) })).toMatchObject({ kind: 'challenge' });
    expect(await answer({ address: () => html(challenge) })).toMatchObject({ kind: 'challenge' });
    expect(await answer({ milestones: () => html(challenge, { status: 503 }) })).toMatchObject({ kind: 'challenge' });
    expect(await answer({ address: () => html('', { status: 403 }) })).toMatchObject({ kind: 'challenge' });
    expect(await answer({ address: () => html('', { status: 503 }) })).toMatchObject({ kind: 'maintenance' });
    expect(await answer({ address: () => text('', { status: 429, headers: { 'Retry-After': '30' } }) })).toMatchObject({ kind: 'rate_limited' });
    expect(await answer({ address: () => new Response(null, { status: 302, headers: { Location: '/' } }) })).toMatchObject({ kind: 'transport' });
    expect(await answer({ address: () => html('<html>moved</html>', { status: 404 }) })).toMatchObject({ kind: 'transport' });
    expect(await answer({ address: refusal('No TraceInfo supplied') })).toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(await answer({ address: refusal('Invalid TraceInfo: something else') })).toMatchObject({ kind: 'indeterminate' });
    expect(await answer({ address: () => text('Bad request', { status: 400 }) })).toMatchObject({ kind: 'indeterminate' });
    // A refusal after the order opened is no answer about the order.
    expect(await answer({ milestones: () => text(NOT_FOUND, { status: 400 }) })).toMatchObject({ kind: 'indeterminate' });
    expect(await answer({ traces: refusal('Re-authentication is required', 401) })).toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(await answer({ address: () => html('<html><body>Track and trace</body></html>') })).toMatchObject({ kind: 'schema' });
    expect(await answer({ milestones: () => json('{"Milestones":') })).toMatchObject({ kind: 'schema' });
    expect(await answer({ address: () => json('{"type":"TEoTrackAndTrace_Address_Response"}') })).toMatchObject({ kind: 'schema' });
  });

  it('reads the order only in a session the API opened for the link’s code and order number', async () => {
    const answer = (cookie: string | null) => track(api({ address: () => cookie === null ? json(ADDRESS) : opened(cookie) }))
      .catch((error: unknown) => error);
    expect(await answer(null)).toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(await answer(session({ ClientId: 0 }))).toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    expect(await answer(session({ Tracecode: OTHER }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(session({ OrderId: 1 }))).toMatchObject({ kind: 'indeterminate' });
  });

  it('sends a read that failed to reach the API once more', async () => {
    const working = api();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementation(working);
    await expect(track(fetcher)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe('MAX Pakket replies', () => {
  it('reads the sample’s delivery from its milestones, on the moments the API writes with their offset', () => {
    const result = parseMaxPakket(JSON.parse(MILESTONES), JSON.parse(NO_TRACES), SAMPLE);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Succesvol afgeleverd',
      last_update: '2025-10-09T16:08:21+02:00', expected_delivery: null, delivered_at: '2025-10-09T16:08:21+02:00',
      events: [
        { time: '2025-10-09T16:08:21+02:00', description: 'Succesvol afgeleverd', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2025-10-03T08:21:12+02:00', description: 'Aangemeld', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('never reads the signee, the signature or the sender', () => {
    const output = JSON.stringify(parseMaxPakket(JSON.parse(MILESTONES), JSON.parse(NO_TRACES), SAMPLE));
    for (const hidden of ['Placeholder Signee', 'iVBORw0KGgo', 'Online sender']) expect(output).not.toContain(hidden);
  });

  it('reads the scans when the order has them, newest first, keeping a wall clock without an offset', () => {
    const result = parseMaxPakket(milestones([['REGISTERED', 'COMPLETED', 'SUCCES'], ['INTRANSIT', 'ACTIVE'], ['DELIVERED', 'INACTIVE']]), traces([
      { Description: 'Aangemeld', Moment: '2026-11-20T09:15:00+01:00', Succes: true },
      { Description: 'Verplaatst op/overslag', Moment: '2026-11-24T06:40:00', Succes: true },
      { Description: 'Opgehaald', Moment: '2026-11-21T14:02:00+01:00', Succes: true },
    ]), SAMPLE);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Onderweg', last_update: null, last_update_local: '2026-11-24T06:40:00',
      expected_delivery_from: '2026-11-25T08:00:00+01:00', expected_delivery: '2026-11-25T18:00:00+01:00',
    });
    expect(result.events).toEqual([
      { local_time: '2026-11-24T06:40:00', description: 'Verplaatst op/overslag', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-11-21T14:02:00+01:00', description: 'Opgehaald', stage: 'accepted', stage_source: 'carrier_map' },
      { time: '2026-11-20T09:15:00+01:00', description: 'Aangemeld', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(result.delivered_at).toBeUndefined();
  });

  it('gives a planned stop’s window as the estimate, and no delivery for a stop completed without one', () => {
    const planned = parseMaxPakket(milestones([['REGISTERED', 'COMPLETED', 'SUCCES'], ['INTRANSIT', 'COMPLETED', 'SUCCES'], ['DELIVERED', 'ACTIVE']], {
      MomentPta: '2026-11-25T10:05:00+01:00', MomentPtd: '2026-11-25T10:10:00+01:00',
    }), traces([]), SAMPLE);
    expect(planned).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Onderweg', expected_delivery_from: '2026-11-25T10:05:00+01:00',
      expected_delivery: '2026-11-25T10:10:00+01:00' });
    expect(planned.events).toEqual([{ time: '2026-11-20T09:15:00+01:00', description: 'Aangemeld', stage: 'registered', stage_source: 'carrier_map' }]);
    const failed = parseMaxPakket(milestones([['REGISTERED', 'COMPLETED', 'SUCCES'], ['INTRANSIT', 'COMPLETED', 'SUCCES'], ['DELIVERED', 'COMPLETED', 'UNSUCCESSFUL']], {
      MomentAta: '2026-11-25T10:06:00+01:00', MomentAtd: '2026-11-25T10:09:00+01:00',
    }), traces([]), SAMPLE);
    expect(failed).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Niet succesvol afgeleverd', last_update: '2026-11-25T10:09:00+01:00',
      expected_delivery: null });
    expect(failed.delivered_at).toBeUndefined();
    const registered = parseMaxPakket(milestones([['REGISTERED', 'ACTIVE'], ['INTRANSIT', 'INACTIVE'], ['DELIVERED', 'INACTIVE']]), traces([]), SAMPLE);
    expect(registered).toMatchObject({ current_stage: 'registered', last_status_text: 'Aangemeld', expected_delivery: '2026-11-25T18:00:00+01:00' });
  });

  it('reads an order without a reached milestone or scan as listed without history', () => {
    expect(() => parseMaxPakket(milestones([['REGISTERED', 'INACTIVE']]), traces([]), SAMPLE))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('refuses a changed reply', () => {
    const delivered = JSON.parse(MILESTONES);
    for (const [list, scans] of [
      [{}, traces([])], [{ type: 'TEoTrackAndTrace_MilestoneList_Response', Milestones: {} }, traces([])],
      [{ type: 'TEoTrackAndTrace_MilestoneList_Response', Milestones: [{ Name: 1 }] }, traces([])],
      [delivered, {}], [delivered, traces([{ Moment: '2026-11-24T06:40:00+01:00' }])],
      [delivered, traces([{ Description: 'Onderweg', Moment: '24-11-2026 06:40' }])], [delivered, traces([{ Description: 'Onderweg' }])],
      [delivered, traces([{ Description: 'Onderweg', Moment: '2026-02-30T06:40:00' }])],
    ] as const) {
      expect(() => parseMaxPakket(list, scans, SAMPLE), JSON.stringify(scans)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('MAX Pakket statuses', () => {
  it('maps every wording of the tracking app by its whole wording', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'max-pakket', description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'Afgeleverd bij de buren')).toBeUndefined();
  });
});
