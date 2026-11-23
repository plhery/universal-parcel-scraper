import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierDefinition } from '../../core/catalog/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import {
  containerCheckDigit, MARFRET_TRACKER, marfretPage, marfretPageForm, marfretQuery, marfretResult, marfretSearch, marfretSearchForm, marfretViewState,
  type MarfretRow,
} from './parser.js';
import { marfretStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples. The unknown container is invented, with a matching check digit.
const PAPEETE = 'MFTU9261613';
const RETURNED = 'MFTU8260736';
const ANTILLES = 'MFTU2220438';
const PLANNED = 'MFTU9228493';
const UNKNOWN = 'MFTU1234566';
// The fixtures' synthetic view.
const VIEW = '1234567890123456789:-1234567890123456789';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const found = (number: string) => fixture(`found-${number}.xml`);
/** A search's moves, staged into a result. */
const read = (body: string, number: string, truncated = false) => {
  const search = marfretSearch(body, number)!;
  return marfretResult(search.rows, { listed: search.listed, truncated });
};
const rows = (result: ReturnType<typeof marfretResult>) =>
  (result.events ?? []).map(event => [event.time ?? null, event.local_time, event.description, event.location ?? null, event.stage ?? null]);
// The first five moves of the sample's nine, as the tracker gives them when it lists five a page.
const firstFive = found(ANTILLES).replace(/<tr data-ri="[5-8]"[\s\S]*?<\/tr>/g, '').replace('rows:20,rowCount:9', 'rows:5,rowCount:9');

const MEL_DEPOT = 'MEDLOG MEL [AU MEL]';
const SWANSON = 'DP World West Swanson Dock WSD [AU MEL]';
const MOTU_UTA = 'MOTU UTA PFPPT [PF PPT]';

describe('Marfret replies', () => {
  it('reads a container\'s moves newest first, at the zone of the port or country its LOCODE names', () => {
    const result = read(found(PAPEETE), PAPEETE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Depot Gate In', last_update: '2026-11-11T18:12:00+11:00', expected_delivery: null });
    expect(result).not.toHaveProperty('history_truncated');
    expect(rows(result)).toEqual([
      ['2026-11-11T18:12:00+11:00', '2026-11-11T18:12:00', 'Depot Gate In', MEL_DEPOT, 'delivered'],
      ['2026-11-11T17:55:00+11:00', '2026-11-11T17:55:00', 'Terminal Gate Out', SWANSON, 'out_for_delivery'],
      ['2026-11-09T01:33:00+11:00', '2026-11-09T01:33:00', 'Discharged', SWANSON, 'in_transit'],
      ['2026-10-22T14:00:00-10:00', '2026-10-22T14:00:00', 'Loaded OnBoard', MOTU_UTA, 'in_transit'],
      ['2026-10-22T13:59:00-10:00', '2026-10-22T13:59:00', 'Allocated', MOTU_UTA, 'registered'],
    ]);
    expect(result.events![0]).toEqual({ time: '2026-11-11T18:12:00+11:00', local_time: '2026-11-11T18:12:00', time_zone: 'Australia/Melbourne',
      time_zone_basis: 'place', location: MEL_DEPOT, description: 'Depot Gate In', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('stages a transshipment as transit, and a terminal gate in after the consignee\'s collection as the empty return', () => {
    const result = read(found(ANTILLES), ANTILLES);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-11-09T11:00:00-04:00' });
    expect(rows(result).map(([time, , description, , stage]) => [time, description, stage])).toEqual([
      ['2026-11-09T11:00:00-04:00', 'Terminal Gate In', 'delivered'],
      ['2026-11-05T15:44:00-04:00', 'Terminal Gate Out', 'out_for_delivery'],
      ['2026-11-04T09:00:00-04:00', 'Discharged', 'in_transit'],
      ['2026-11-03T10:11:00-04:00', 'Loaded OnBoard', 'in_transit'],
      ['2026-10-22T06:00:00-04:00', 'Discharged', 'in_transit'],
      ['2026-10-10T12:28:00+02:00', 'Loaded OnBoard', 'in_transit'],
      ['2026-10-05T17:39:00+02:00', 'Terminal Gate In', 'accepted'],
      ['2026-10-02T11:33:00+02:00', 'Allocated', 'registered'],
      ['2026-10-02T11:32:00+02:00', 'Depot Gate Out', 'registered'],
    ]);
  });

  it('stages each move by where it falls in the cycle', () => {
    const papeete = found(PAPEETE);
    const without = (...indexes: number[]) => indexes.reduce((body, index) => body.replace(new RegExp(`<tr data-ri="${index}"[\\s\\S]*?</tr>`), ''), papeete);
    const renumbered = (body: string) => { let index = 0; return body.replace(/data-ri="\d+"/g, () => `data-ri="${index++}"`).replace(/rowCount:\d+/, `rowCount:${index}`); };
    // Discharged and not yet collected; a depot gate in straight after the discharge is transit.
    expect(read(renumbered(without(0, 1)), PAPEETE)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Discharged' });
    expect(read(renumbered(without(1)), PAPEETE).events![0]).toMatchObject({ description: 'Depot Gate In', stage: 'in_transit' });
    // On board, with a provisional discharge the tracker lists apart.
    const planned = read(found(PLANNED), PLANNED);
    expect(planned).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-11-14T20:20:00-04:00' });
    expect(rows(planned).map(row => row[2])).toEqual(['Loaded OnBoard', 'Allocated']);
    // An empty container gated into a depot before it moved was not used.
    const returned = read(found(RETURNED), RETURNED);
    expect(returned).toMatchObject({ status: 'unknown', last_status_text: 'Depot Gate In', last_update: '2026-11-12T07:35:00+10:00' });
    expect(returned).not.toHaveProperty('current_stage');
    expect(returned.events![0]).not.toHaveProperty('stage');
    // A wording the tracker has not shown gets no stage and leaves the others theirs.
    const unknown = read(papeete.replace(/(\s*)Depot Gate In(\s*)/, '$1Stuffed$2'), PAPEETE);
    expect(unknown).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Stuffed' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
  });

  it('reads a Spanish mainland port in Madrid\'s zone, and keeps the wall clock of other Spanish ports', () => {
    const at = (location: string) => read(found(PAPEETE).replace(MEL_DEPOT, location), PAPEETE).events![0];
    expect(at('APMT Barcelona ESBCN [ES BCN]')).toMatchObject({ time: '2026-11-11T18:12:00+01:00', time_zone: 'Europe/Madrid' });
    const island = at('OPCSA LPA [ES LPA]');
    expect(island).toMatchObject({ local_time: '2026-11-11T18:12:00' });
    expect(island).not.toHaveProperty('time');
    const unnamed = at('');
    expect(unnamed).not.toHaveProperty('location');
    expect(unnamed).not.toHaveProperty('time');
  });

  it('reads later pages of the table from their first row, and marks a table read in part as truncated', () => {
    const search = marfretSearch(firstFive, ANTILLES)!;
    expect(search).toMatchObject({ viewState: VIEW, rowCount: 9, pageRows: 5, listed: true });
    expect(search.rows).toHaveLength(5);
    const page = marfretPage(fixture(`page-${ANTILLES}-5.xml`), ANTILLES, 5)!;
    expect(page.viewState).toBe(VIEW);
    expect(page.rows.map(row => row.description)).toEqual(['Loaded OnBoard', 'Terminal Gate In', 'Allocated', 'Depot Gate Out']);
    expect(marfretResult([...search.rows, ...page.rows], { listed: true, truncated: false })).toEqual(read(found(ANTILLES), ANTILLES));
    expect(() => marfretPage(fixture(`page-${ANTILLES}-5.xml`), ANTILLES, 6)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const part = marfretResult(search.rows, { listed: true, truncated: true });
    expect(part).toMatchObject({ history_truncated: true, current_stage: 'delivered' });
    // A row repeated across pages is kept once.
    expect(marfretResult([...search.rows, ...search.rows.slice(-1), ...page.rows], { listed: true, truncated: false }).events).toHaveLength(9);
  });

  it('reads the table\'s message as a container Marfret does not hold, and a named container without moves as listed', () => {
    const empty = marfretSearch(fixture(`notfound-${UNKNOWN}.xml`), UNKNOWN)!;
    expect(empty).toMatchObject({ rows: [], rowCount: 0, listed: false, viewState: VIEW });
    expect(() => marfretResult(empty.rows, { listed: empty.listed, truncated: false })).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const noMoves = found(PLANNED).replace(/<tbody id="contTableForm:TBtrackView_data"[^>]*>[\s\S]*?<\/tbody>/,
      '<tbody id="contTableForm:TBtrackView_data" class="ui-datatable-data ui-widget-content"><tr class="ui-widget-content ui-datatable-empty-message"><td colspan="5">No records found.</td></tr></tbody>')
      .replace('rows:20,rowCount:2', 'rows:20,rowCount:0');
    expect(() => read(noMoves, PLANNED)).toThrowError(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('reads another container, a changed table or an invalid move as a changed reply, never as missing', () => {
    const papeete = found(PAPEETE);
    const fails = (body: string, number = PAPEETE) => expect(() => read(body, number), body.slice(0, 200)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    fails(papeete, ANTILLES);
    fails(papeete.replace(`<td role="gridcell" style="font-size: 13px;">${PAPEETE}</td><td role="gridcell" style="font-size: 13px;">11/9/26`,
      `<td role="gridcell" style="font-size: 13px;">${ANTILLES}</td><td role="gridcell" style="font-size: 13px;">11/9/26`));
    fails(papeete.replace(`<li class="seItem" style="width: 20%;">${PAPEETE}`, `<li class="seItem" style="width: 20%;">${ANTILLES}`));
    fails(found(PLANNED).replace(/(<tbody id="provTableForm:TBtrackView_data"[\s\S]*?<td[^>]*>)MFTU9228493/, `$1${ANTILLES}`), PLANNED);
    fails(papeete.replace('11/9/26 1:33 AM', '11/31/26 1:33 AM'));
    fails(papeete.replace('11/9/26 1:33 AM', '2026-11-09 01:33'));
    fails(papeete.replace('11/9/26 1:33 AM', '11/9/26 13:33 PM'));
    fails(papeete.replace(/(\s*)Discharged(\s*)/, '$1 $2'));
    fails(papeete.replace('data-ri="2"', 'data-ri="7"'));
    fails(papeete.replace('<span class="ui-column-title">Event Type</span>', '<span class="ui-column-title">Status</span>'));
    fails(papeete.replace('rowCount:5', 'rowCount:4'));
    fails(papeete.replace('rowCount:5', 'rowCount:0'));
    fails(papeete.replace('rows:20,', ''));
    fails(papeete.replace(/<update id="provTableForm">[\s\S]*?<\/update>/, ''));
    fails(fixture(`notfound-${UNKNOWN}.xml`).replace('No records found.', 'An error occurred.'), UNKNOWN);
    fails(fixture(`notfound-${UNKNOWN}.xml`).replace('rowCount:0', 'rowCount:3'), UNKNOWN);
    fails(fixture(`notfound-${UNKNOWN}.xml`).replace(/<tr class="ui-widget-content ui-datatable-empty-message">[\s\S]*?<\/tr>/, ''), UNKNOWN);
    fails('<html><body><h1>Error 500</h1></body></html>');
    fails('');
    expect(() => marfretPage(papeete, PAPEETE, 20)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads Cloudflare\'s pages as a challenge, and a view the tracker no longer holds as expired', () => {
    for (const body of ['<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>',
      '<html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>']) {
      expect(() => marfretSearch(body, PAPEETE)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
      expect(() => marfretViewState(body)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    }
    expect(marfretSearch(fixture('expired.xml'), PAPEETE)).toBeNull();
    expect(marfretPage(fixture('expired.xml'), PAPEETE, 20)).toBeNull();
    const failure = (name: string) => `<?xml version="1.0" encoding="UTF-8"?><partial-response><error><error-name>${name}</error-name><error-message><![CDATA[viewId:/public/marfret/ContainerTrackSearch.seam]]></error-message></error></partial-response>`;
    expect(marfretSearch(failure('class javax.faces.application.ViewExpiredException'), PAPEETE)).toBeNull();
    expect(() => marfretSearch(failure('class java.lang.NullPointerException'), PAPEETE)).toThrowError(expect.objectContaining({ kind: 'transport' }));
  });

  it('reads the view of the tracker\'s page, and a page without its search as changed', () => {
    expect(marfretViewState(fixture('search.html'))).toBe(VIEW);
    for (const body of ['<html><body>Maintenance</body></html>', fixture('search.html').replace('value="CONTNUM"', 'value="CONTAINER"'),
      fixture('search.html').replace(VIEW, 'a view with spaces')]) {
      expect(() => marfretViewState(body)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

type Reply = { status?: number; body: string; cookie?: string; type?: string };
type Call = { method: string; url: string; body: string | null; headers: Headers };
/** A tracker that answers each request with the next reply, recording what it was sent. */
function tracker(replies: (Reply | Error)[]) {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : null, headers: new Headers(init?.headers) });
    const reply = replies.shift();
    if (!reply) throw new Error('The test tracker has no reply left');
    if (reply instanceof Error) throw reply;
    const headers: Record<string, string> = { 'content-type': reply.type ?? (reply.body.startsWith('<?xml') ? 'text/xml;charset=UTF-8' : 'text/html;charset=UTF-8') };
    if (reply.cookie) headers['set-cookie'] = `JSESSIONID=${reply.cookie}; Path=/Odyssey; Secure; HttpOnly; SameSite=None`;
    return Object.defineProperty(new Response(reply.body, { status: reply.status ?? 200, headers }), 'url', { value: url });
  });
  return { fetcher, calls };
}
const page = (cookie = 'fixture'): Reply => ({ body: fixture('search.html'), cookie });
const carrier = (fetcher: typeof fetch, recorder?: StepRecorder) =>
  adapter({ fetcher, ...(recorder ? { recorder } : {}), env: {}, trawl: null, browserExecutablePath: null } as Parameters<typeof adapter>[0]);

describe('Marfret adapter', () => {
  it('takes a container with its check digit, and nothing else', async () => {
    expect([containerCheckDigit('MFTU926161'), containerCheckDigit('MFTU123456')]).toEqual([3, 6]);
    expect(marfretQuery(' mftu 926161-3 ')).toBe(PAPEETE);
    const { fetcher } = tracker([]);
    for (const number of ['MFTU9261614', 'MFTU926161', 'MFTA9261613', '9261613', 'MARFRET', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: PAPEETE }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('opens the tracker\'s page, then posts its search with the page\'s view and cookie', async () => {
    const { fetcher, calls } = tracker([page(), { body: found(PAPEETE) }]);
    const recorded: unknown[] = [];
    const recorder: StepRecorder = { step: entry => { recorded.push(entry); }, lookup() {} };
    await expect(carrier(fetcher, recorder).track({ number: PAPEETE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered', events: expect.any(Array) });
    expect(calls.map(call => [call.method, call.url])).toEqual([['GET', MARFRET_TRACKER], ['POST', MARFRET_TRACKER]]);
    expect(calls[0]!.headers.get('cookie')).toBeNull();
    expect([...new URLSearchParams(calls[1]!.body!)]).toEqual([
      ['javax.faces.partial.ajax', 'true'],
      ['javax.faces.source', 'cTFormView:ctSearchButton'],
      ['javax.faces.partial.execute', 'cTFormView'],
      ['javax.faces.partial.render', 'contTableForm provTableForm'],
      ['cTFormView:ctSearchButton', 'cTFormView:ctSearchButton'],
      ['cTFormView', 'cTFormView'],
      ['cTFormView:ctSelect', 'CONTNUM'],
      ['cTFormView:searchText', PAPEETE],
      ['javax.faces.ViewState', VIEW],
    ]);
    expect(calls[1]!.body).toBe(marfretSearchForm(PAPEETE, VIEW).toString());
    const headers = calls[1]!.headers;
    expect(Object.fromEntries(['faces-request', 'x-requested-with', 'content-type', 'origin', 'referer', 'cookie'].map(name => [name, headers.get(name)]))).toEqual({
      'faces-request': 'partial/ajax', 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: 'https://marfret-api.locussoftware.com', referer: MARFRET_TRACKER, cookie: 'JSESSIONID=fixture',
    });
    expect(recorded).toMatchObject([{ step: 'direct', outcome: 'ok' }]);
  });

  it('asks for the table\'s later pages with the search, and keeps the first page when a later one fails', async () => {
    const whole = tracker([page(), { body: firstFive }, { body: fixture(`page-${ANTILLES}-5.xml`) }]);
    const result = await carrier(whole.fetcher).track({ number: ANTILLES });
    expect(result).toEqual(read(found(ANTILLES), ANTILLES));
    expect(whole.calls[2]!.body).toBe(marfretPageForm(ANTILLES, VIEW, 5, 5).toString());
    expect(whole.calls[2]!.headers.get('cookie')).toBe('JSESSIONID=fixture');
    const failed = tracker([page(), { body: firstFive }, { status: 500, body: '' }]);
    await expect(carrier(failed.fetcher).track({ number: ANTILLES })).resolves.toMatchObject({ history_truncated: true, current_stage: 'delivered' });
    const expired = tracker([page(), { body: firstFive }, { body: fixture('expired.xml') }]);
    const part = await carrier(expired.fetcher).track({ number: ANTILLES });
    expect(part).toMatchObject({ history_truncated: true });
    expect(part.events).toHaveLength(5);
    // The pages stop at five, so a longer table is truncated.
    const later = (first: number) => fixture(`page-${ANTILLES}-5.xml`).replace(/data-ri="([5-8])"/g, (_, index: string) => `data-ri="${Number(index) - 5 + first}"`);
    const capped = tracker([page(), { body: firstFive.replace('rowCount:9', 'rowCount:40') }, ...[5, 9, 13, 17].map(first => ({ body: later(first) }))]);
    await expect(carrier(capped.fetcher).track({ number: ANTILLES })).resolves.toMatchObject({ history_truncated: true });
    expect(capped.calls.slice(2).map(call => new URLSearchParams(call.body!).get('contTableForm:TBtrackView_first'))).toEqual(['5', '9', '13', '17']);
  });

  it('opens one fresh session for a view the tracker no longer holds', async () => {
    const { fetcher, calls } = tracker([page('first'), { body: fixture('expired.xml') }, page('second'), { body: found(PAPEETE) }]);
    await expect(carrier(fetcher).track({ number: PAPEETE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(calls.map(call => [call.method, call.headers.get('cookie')])).toEqual([
      ['GET', null], ['POST', 'JSESSIONID=first'], ['GET', null], ['POST', 'JSESSIONID=second'],
    ]);
    const twice = tracker([page(), { body: fixture('expired.xml') }, page(), { body: fixture('expired.xml') }]);
    await expect(carrier(twice.fetcher).track({ number: PAPEETE })).rejects.toMatchObject({ kind: 'transport' });
    expect(twice.calls).toHaveLength(4);
  });

  it('reads an unknown container as not found, and refusals and failures by their kind', async () => {
    await expect(carrier(tracker([page(), { body: fixture(`notfound-${UNKNOWN}.xml`) }]).fetcher).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    await expect(carrier(tracker([{ body: challenge }]).fetcher).track({ number: PAPEETE })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(tracker([page(), { body: challenge }]).fetcher).track({ number: PAPEETE })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(tracker([page(), { body: '<html><body>Error</body></html>' }]).fetcher).track({ number: PAPEETE })).rejects.toMatchObject({ kind: 'schema' });
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance'], [500, 'indeterminate'], [404, 'transport'], [302, 'transport']] as const) {
      await expect(carrier(tracker([{ status, body: '' }]).fetcher).track({ number: PAPEETE }), String(status)).rejects.toMatchObject({ kind });
      await expect(carrier(tracker([page(), { status, body: '' }]).fetcher).track({ number: PAPEETE }), String(status)).rejects.toMatchObject({ kind });
    }
  });

  it('keeps the session\'s view out of a failed request\'s diagnostics', async () => {
    const error = await carrier(tracker([page(), { status: 403, body: 'blocked' }]).fetcher).track({ number: PAPEETE }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: 'challenge', status: 403 });
    expect(JSON.stringify(error)).not.toContain(VIEW);
    expect((error as { request?: unknown }).request).toBeUndefined();
  });

  it('opens one more session when a request does not reach the tracker', async () => {
    const { fetcher } = tracker([new TypeError('fetch failed'), page(), { body: found(PAPEETE) }]);
    await expect(carrier(fetcher).track({ number: PAPEETE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('is asked when the number is filed under Marfret', async () => {
    const { fetcher } = tracker([page(), { body: found(PAPEETE) }]);
    await expect(createTracker({ providers: [], env: {}, fetcher }).track({ number: PAPEETE, carrier: 'marfret' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'marfret', source: 'marfret', result: { current_stage: 'delivered' } });
    expect(carrierDefinition('marfret').tracking).toMatchObject({ adapter: 'marfret', localClocks: true });
  });
});

describe('Marfret status vocabulary', () => {
  it('stages each wording the tracker gives by its usual place in the cycle', () => {
    for (const entry of statuses.entries) {
      expect(marfretStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'marfret', providerCode: null, description: entry.wording }).kind, entry.wording).toBe('mapped');
    }
    expect(marfretStage('  loaded   onboard ')).toBe('in_transit');
    expect(statusMap.stage(null, 'stuffed')).toBeUndefined();
  });

  it('gives each fixture move a known wording', () => {
    const moves: MarfretRow[] = [PAPEETE, RETURNED, ANTILLES, PLANNED].flatMap(number => marfretSearch(found(number), number)!.rows);
    expect(moves.filter(move => !marfretStage(move.description))).toEqual([]);
  });
});
