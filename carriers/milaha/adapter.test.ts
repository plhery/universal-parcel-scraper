import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, MILAHA_DETAILS, MILAHA_FORM, MILAHA_HOME, MILAHA_MOVES, MilahaTracker } from './adapter.js';
import { milahaQuery, milahaResult, parseMilahaDetails, parseMilahaMoves } from './parser.js';
import { milahaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json and the container its reply lists.
const SAMPLE = 'MILCN1HMD011302';
const CONTAINER = 'QNLU8004000';
// A synthetic second container, whose check digit does not match.
const OTHER = 'QNLU8004001';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const details = fixture(`details-${SAMPLE}.html`);
const moves = fixture(`moves-${CONTAINER}.html`);
const SESSION = 'JSESSIONID=synthetic-session.node1';
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const home = () => page('<html><title>e-Commerce</title></html>', { headers: { 'Set-Cookie': `${SESSION}; path=/ecomonline; secure; HttpOnly` } });
/** A fetcher for the tracker: the home page and form, then the lookups in turn. */
const tracker = (...lookups: Response[]) => {
  const queue = [...lookups];
  return vi.fn<typeof fetch>(async (url) => {
    if (String(url) === MILAHA_HOME) return home();
    if (String(url) === MILAHA_FORM) return page('<html>tracking</html>');
    return queue.shift()!;
  });
};
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The sample's booking with the synthetic second container listed beside the first.
const twoContainers = details.replace(/(<tr>\s*<td >QNLU8004000[\s\S]*?<\/tr>)/, (row: string) => `${row}\n${row.replaceAll(CONTAINER, OTHER)
  .replace('RECEIVED FROM CONSIGNEE', 'SENT TO CONSIGNEE').replace('11-Aug-2026 16:30', '09-Aug-2026 15:00')}`);

describe('Milaha HTTP adapter', () => {
  it('opens a session, posts the form without its picture code and reads the booking and its container’s moves', async () => {
    const fetcher = tracker(page(details), page(moves));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new MilahaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' milcn1-hmd011302 ');
    const calls = fetcher.mock.calls.map(([url, init]) => [String(url).split('?')[0], init?.method]);
    expect(calls).toEqual([[MILAHA_HOME, 'GET'], [MILAHA_FORM, 'POST'], [MILAHA_DETAILS, 'POST'], [MILAHA_MOVES, 'POST']]);
    const [, form] = fetcher.mock.calls[1]!;
    expect(Object.fromEntries(new URLSearchParams(String(form!.body)))).toEqual({ tracktype: 'logintracking', logintracno: SAMPLE, captcha: '' });
    for (const [, init] of fetcher.mock.calls.slice(1)) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Cookie: SESSION, 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(Object.fromEntries(new URL(String(fetcher.mock.calls[2]![0])).searchParams)).toMatchObject({ Mdl: 'containernos', MdlNo: SAMPLE, trackingviahome: 'Y' });
    expect(Object.fromEntries(new URL(String(fetcher.mock.calls[3]![0])).searchParams))
      .toMatchObject({ type: 'containermovement', containerNo: CONTAINER, bookNo: SAMPLE });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'RECEIVED FROM CONSIGNEE', last_update: null, last_update_local: '2026-08-11T16:30', expected_delivery: null });
    expect(result.events!.map(event => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-08-11T16:30', 'RECEIVED FROM CONSIGNEE', 'HAMAD PORT', 'delivered'],
      ['2026-08-09T14:10', 'SENT TO CONSIGNEE', 'HAMAD PORT', 'out_for_delivery'],
      ['2026-08-06T11:29', 'DISCHARGE FULL', 'HAMAD PORT', 'in_transit'],
      ['2026-08-02T19:24', 'LOAD TRANSHIPMENT FULL', 'JEBEL ALI', 'in_transit'],
      ['2026-07-21T08:59', 'RECEIVED FULL', 'JEBEL ALI', 'in_transit'],
      ['2026-07-20T22:00', 'TRANSFER FULL', 'KHOR AL FAKKAN', 'in_transit'],
      ['2026-07-20T11:30', 'DISCHARGE TRANSHIPMENT FULL', 'KHOR AL FAKKAN', 'in_transit'],
      ['2026-07-01T03:00', 'LOAD FULL', 'NINGBO PORT', 'in_transit'],
      ['2026-06-24T15:50', 'RECEIVED FROM SHIPPER', 'NINGBO PORT', 'accepted'],
      ['2026-06-24T00:01', 'SENT TO SHIPPER', 'NINGBO PORT', 'registered'],
    ]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'milaha', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the booking asked for, or the container asked for under its latest booking', () => {
    expect(parseMilahaDetails(details, milahaQuery(SAMPLE))).toEqual([{ number: CONTAINER, booking: SAMPLE,
      latest: { local_time: '2026-08-11T16:30', description: 'RECEIVED FROM CONSIGNEE', location: 'HAMAD PORT', stage: 'delivered', stage_source: 'carrier_map' } }]);
    expect(parseMilahaDetails(twoContainers, milahaQuery(CONTAINER)).map(item => item.number)).toEqual([CONTAINER]);
    expect(parseMilahaDetails(twoContainers, milahaQuery(SAMPLE)).map(item => item.number)).toEqual([CONTAINER, OTHER]);
    expect(() => parseMilahaDetails(details, milahaQuery('MILCN1HMD011303'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMilahaDetails(details, milahaQuery('QNLU8003955'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('lets a booking’s open container lead until every container is back', () => {
    const delivered = parseMilahaMoves(moves);
    const collected = delivered.slice(1);
    expect(milahaResult([delivered, collected])).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'RECEIVED FROM CONSIGNEE' });
    // Moves the containers share are kept once.
    expect(milahaResult([delivered, collected]).events).toHaveLength(delivered.length);
    expect(milahaResult([delivered, delivered])).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads moves the panel does not list from the booking’s list, and marks the rest unread', async () => {
    const empty = moves.replace(/<div class="media">[\s\S]*$/, '</div>');
    expect(parseMilahaMoves(empty)).toEqual([]);
    const result = await carrier(tracker(page(twoContainers), page(empty), page(empty))).track({ number: SAMPLE });
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'RECEIVED FROM CONSIGNEE' });
    expect(result.events!.map(event => event.description)).toEqual(['RECEIVED FROM CONSIGNEE', 'SENT TO CONSIGNEE']);
    expect(milahaResult([[{ local_time: '2026-08-11T16:30', description: 'GATE IN' }]], true))
      .toMatchObject({ status: 'unknown', history_truncated: true });
    expect(() => milahaResult([[]])).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('reads the tracker’s invalid-number answer as not found, and a changed page as a schema change', async () => {
    await expect(carrier(tracker(page(fixture('not-found.html')))).track({ number: 'MILZZ9000000' })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(tracker(page('<html>maintenance</html>'))).track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'schema' });
    expect(() => parseMilahaMoves('<div>nothing</div>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMilahaMoves(moves.replace('11-Aug-2026 16:30', '2026-08-11 16:30'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMilahaDetails(details.replace(`'${CONTAINER}'`, "'QNLU8003955'"), milahaQuery(SAMPLE))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an expired session, a firewall, a rate limit and a moved route apart from a missing booking', async () => {
    const answer = (response: Response) => carrier(tracker(response)).track({ number: SAMPLE });
    await expect(answer(page('', { status: 302, headers: { Location: 'https://erp-qnl.solverminds.net/ecomonline/SessionExpired.jsp' } })))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    await expect(answer(page('', { status: 302, headers: { Location: '/maintenance' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(answer(page('<html><title>Just a moment...</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    const sessionless = vi.fn<typeof fetch>(async () => page('<html></html>'));
    await expect(carrier(sessionless).track({ number: SAMPLE })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
  });

  it('retries once in a new session when the first request does not reach Milaha', async () => {
    const fetcher = tracker(page(details), page(moves));
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: SAMPLE }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('sends a container with its check digit, or a MIL or QNL booking', () => {
    expect(milahaQuery(' qnlu 800400-0 ')).toEqual({ kind: 'container', number: CONTAINER });
    expect(milahaQuery('MILIN1025122')).toEqual({ kind: 'booking', number: 'MILIN1025122' });
    for (const bad of [OTHER, 'ABC123', 'MSCU1234567X', 'TRKU10186118', '1'.repeat(70), '']) {
      expect(() => milahaQuery(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the wordings statuses.json records', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'milaha', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
      expect(milahaStage(wording)).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'milaha', providerCode: null, description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
