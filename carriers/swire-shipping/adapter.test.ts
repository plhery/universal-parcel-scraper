import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { blazorApp, callJs, HUB_TOKEN, htmlFrames, invocation, join, render, started, writeBatch, type AppOptions } from '../../core/testing/blazor.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, parseSwire, SWIRE_APP, SWIRE_HUB, SwireShippingTracker, swirePageState, swirePageUrl, swireQuery } from './adapter.js';
import { swireStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const UNKNOWN = 'ZZ99999999';
const POLL = `${SWIRE_HUB}?id=${HUB_TOKEN}`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

/** The page's root, holding the page in one element; a later batch can replace it. */
const pageFrames = (html: string) => htmlFrames(`<div>${html}</div>`);
const pageBatch = (html: string) => writeBatch({ frames: pageFrames(html), diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }] }] });
const attach = () => invocation('JS.AttachComponent', [0, '0']);
const shipment = (html: string) => join(attach(), render(2, pageBatch(html)), started());

/** Swire's portal: the page's shell, the hub's negotiation, a queue of long-poll answers and the messages the adapter sends. */
const hub = ({ shell = () => new Response(fixture('shell.html'), { headers: { 'Content-Type': 'text/html' } }), ...options }: AppOptions) =>
  blazorApp({ app: SWIRE_APP, page: `${SWIRE_APP}tracking?`, shell, ...options });

/** A page with its loader over it, as the page shows while it looks the number up. */
const loading = (html: string) => html.replace('<h3', '<div class="k-loader-container initial-data-loader"></div><h3');
/** A move as the page lists it under an open container. */
const row = (day: string, clock: string, wording: string, port = 'LONG BEACH, CA (USLGB)', badge = 'ACTUAL') =>
  `<div class="tracking-timeline-grid"><div class="align-timeline"></div><div class="container-tracking-grid container-tracking-body">`
  + `<div><div>${day} <span class="container-tracking-event-badge"><span class="custom-badge">${badge}</span></span></div> ${clock}</div>`
  + `<div><b>${wording}</b><br></div><div><span class="container-tracking-location"><i></i> ${port}</span><br>`
  + '<span class="container-tracking-sub-text">UNITED STATES OF AMERICA</span></div><div>SAMPLE TERMINAL</div></div></div>';
/** The page with moves added after the open container's last one. */
const after = (html: string, ...rows: string[]) => {
  const $ = load(html, null, false);
  $('.tracking-timeline-grid').last().after(rows.join(''));
  return $.html();
};

describe('Swire Shipping HTTP adapter', () => {
  it('opens the tracking page’s circuit over long polling, through the supplied transport, and closes it', async () => {
    const { fetcher, requests, sent, texts } = hub({ polls: [shipment(fixture('bl-TO00059000.html'))] });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SwireShippingTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' pllu to0005 9000 '))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    const page = `${SWIRE_APP}tracking?type=bl&query=TO00059000`;
    expect(requests).toEqual([`GET ${page}`, `POST ${SWIRE_HUB}/negotiate?negotiateVersion=1`, `GET ${POLL}`, `POST ${POLL}`,
      `GET ${POLL}`, `POST ${POLL}`, `GET ${POLL}`, `POST ${POLL}`, `DELETE ${POLL}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(texts).toEqual(['{"protocol":"blazorpack","version":1}\u001e']);
    // ASP.NET Core 8's start takes both components and the shell's component state.
    expect(sent).toEqual([
      [1, {}, '0', 'StartCircuit', [SWIRE_APP, page, '[{"type":"server","sequence":0,"descriptor":"U3ludGhldGljRGVzY3JpcHRvcg+AA=="},'
        + '{"type":"server","sequence":1,"descriptor":"U3ludGhldGljSGVhZA/BB=="}]', 'U3ludGhldGljU3RhdGU=']],
      [1, {}, null, 'OnRenderCompleted', [2, null]],
    ]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'swire-shipping', step: 'direct', outcome: 'ok' }));
    expect(swirePageUrl(swireQuery('BEAU 273191-1'))).toBe(`${SWIRE_APP}tracking?type=container&query=BEAU2731911`);
  });

  it('answers the page’s questions with booleans and waits for its loader to go', async () => {
    const page = fixture('bl-WS00104400.html');
    const loaded = writeBatch({ frames: pageFrames(page), diffs: [{ componentId: 0, edits: [{ type: 2, sibling: 0 }, { type: 1, sibling: 0, reference: 0 }] }] });
    const { fetcher, sent } = hub({ polls: [
      join(attach(), callJs(3, 'layoutHelpers.isMobileView', []), callJs(7, 'TelerikBlazor.initMediaQuery', ['synthetic', {}]),
        callJs(8, 'TelerikBlazor.getLocationHost', []), render(2, pageBatch(loading(page))), started()),
      render(3, loaded),
    ] });
    await expect(carrier(fetcher).track({ number: 'WS00104400' })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(sent.slice(1)).toEqual([
      [1, {}, null, 'EndInvokeJSFromDotNet', [3, true, '[3,true,false]']],
      [1, {}, null, 'EndInvokeJSFromDotNet', [7, true, '[7,true,false]']],
      [1, {}, null, 'EndInvokeJSFromDotNet', [8, true, '[8,true,null]']],
      [1, {}, null, 'OnRenderCompleted', [2, null]],
      [1, {}, null, 'OnRenderCompleted', [3, null]],
    ]);
  });

  it('reads the page’s sentence for an unknown number as not found, once the page has opened', async () => {
    const unknown = fixture('not-found.html').replace('SSBFLC613BSS0124', UNKNOWN);
    const { fetcher, requests } = hub({ polls: [join(attach(), render(2, pageBatch(unknown))), started()] });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(requests.filter((request) => request === `GET ${POLL}`)).toHaveLength(4);
    expect(requests.at(-1)).toBe(`DELETE ${POLL}`);
    // The sentence for another number is not this lookup's answer.
    const other = hub({ polls: [shipment(fixture('not-found.html'))] });
    await expect(carrier(other.fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('binds the page to the requested bill or container', async () => {
    await expect(carrier(hub({ polls: [shipment(fixture('bl-TO00059000.html'))] }).fetcher).track({ number: 'ZZ00000001' }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(hub({ polls: [shipment(fixture('container-BEAU2731911.html'))] }).fetcher).track({ number: 'ZZZU0000000' }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    // A bill's page for a container, or a container's for a bill, is not the page Swire answers with.
    await expect(carrier(hub({ polls: [shipment(fixture('container-BEAU2731911.html'))] }).fetcher).track({ number: 'AS00249400' }))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('reads a changed page or a refused one as a failure, not a missing parcel', async () => {
    const lookup = (options: Partial<AppOptions>) => carrier(hub({ polls: [], ...options }).fetcher).track({ number: 'TO00059000' });
    await expect(lookup({ shell: () => new Response('<html><title>Track Shipment</title></html>') })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup({ shell: () => new Response('Forbidden', { status: 403 }) })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup({ polls: [join(attach(), invocation('JS.Error', ['There was an unhandled exception on the current circuit']))] }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    const changed = fixture('bl-TO00059000.html').replace('15 Oct 2026', '31 Feb 2026');
    await expect(lookup({ polls: [shipment(changed)] })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks nothing for a number Swire does not track, and offers no recognition', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['AS0024940', 'AS002494000', 'SSBFLC613BSS0124', 'KORPAS00249400', 'BEAU273191', '0000000000', `ZZ${'0'.repeat(80)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: 'TO00059000' }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(carrier(fetcher).recognize).toBeUndefined();
    expect(swireQuery(' pllu-as0024 9400 ')).toEqual({ kind: 'bl', number: 'AS00249400' });
  });

  it('routes a number filed under Swire Shipping to the adapter, and claims none by shape', async () => {
    const { fetcher } = hub({ polls: [shipment(fixture('bl-TO00059000.html'))] });
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: 'PLLUTO00059000', carrier: 'swire-shipping' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'swire-shipping', source: 'swire-shipping', result: { current_stage: 'in_transit' } });
    for (const { number } of numbers.records) expect(detectCarrierMatch(number).carrier, number).not.toBe('swire-shipping');
  });
});

describe('Swire Shipping page', () => {
  const bill = (number: string) => swireQuery(number);

  it('reads a bill whose one container was moved through a port of transshipment', () => {
    const html = fixture('bl-TO00059000.html');
    expect(swirePageState(html, bill('TO00059000'))).toBe('shipment');
    expect(swirePageState(loading(html), bill('TO00059000'))).toBe('pending');
    const result = parseSwire(html, bill('TO00059000'));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Import Discharged from Vessel', last_update: '2026-11-12T11:07:00-08:00', expected_delivery: null });
    expect(result).not.toHaveProperty('history_truncated');
    expect(result.events).toHaveLength(10);
    expect(result.events![0]).toEqual({ local_time: '2026-11-12T11:07:00', time: '2026-11-12T11:07:00-08:00', time_zone: 'America/Los_Angeles',
      time_zone_basis: 'place', location: 'SSA TERMINALS PIER A, LONG BEACH, CA (USLGB), UNITED STATES OF AMERICA',
      description: 'Import Discharged from Vessel', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-09-30T00:01:00', time: '2026-09-30T00:01:00+13:00', time_zone: 'Pacific/Tongatapu',
      location: 'MATALIKI SHIPPING DEPOT, NUKU ALOFA (TOTBU), TONGA', description: 'Gate Out Empty', stage: 'registered' });
    // The page's order keeps the moves of one minute apart; the transshipment port keeps Samoa's zone.
    expect(result.events!.slice(4, 6).map((event) => [event.description, event.time])).toEqual([
      ['Transhipment Discharged from Vessel', '2026-10-22T18:00:00+13:00'], ['Vessel Arrival', '2026-10-22T18:00:00+13:00']]);
  });

  it('reads the open container’s moves and each other container’s latest one', () => {
    const result = parseSwire(fixture('bl-AS00249400.html'), bill('AS00249400'));
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: '2026-11-12T15:28:00-08:00', history_truncated: true });
    // Six moves of the open container and nine latest moves, two of which fall on one minute.
    expect(result.events).toHaveLength(14);
    expect(result.events!.filter((event) => event.location === 'LONG BEACH, CA (USLGB)')).toHaveLength(8);
    expect(result.events!.find((event) => event.description === 'Gate In Full')).toMatchObject({
      time: '2026-10-23T00:01:00-11:00', time_zone: 'Pacific/Pago_Pago', stage: 'accepted' });
    const picked = parseSwire(fixture('bl-WS00104400.html'), bill('WS00104400'));
    expect(picked).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Gate Out Full', last_update: '2026-11-13T09:04:00-08:00' });
    expect(picked.events!.filter((event) => event.description === 'Gate Out Full').map((event) => event.stage)).toEqual(Array(3).fill('out_for_delivery'));
    expect(picked.events!.at(-1)).toMatchObject({ time: '2026-10-22T00:01:00+13:00', time_zone: 'Pacific/Apia' });
  });

  it('reads a container on its own', () => {
    const query = swireQuery('BEAU2731911');
    const result = parseSwire(fixture('container-BEAU2731911.html'), query);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: '2026-11-12T13:49:00-08:00' });
    expect(result).not.toHaveProperty('history_truncated');
    expect(result.events).toHaveLength(6);
  });

  it('stages the moves by what came before them', () => {
    const html = fixture('bl-TO00059000.html');
    const query = bill('TO00059000');
    // A container picked up full and returned empty is delivered, with the bill's only container.
    const returned = parseSwire(after(html, row('13 Nov 2026', '08:55 AM', 'Gate Out Full'), row('20 Nov 2026', '10:15 AM', 'Gate In Empty')), query);
    expect(returned).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-11-20T10:15:00-08:00' });
    expect(returned.events!.slice(0, 2).map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery']);
    // Before its discharge at its port, a full container leaving a terminal is transit and an empty one returned is no delivery.
    const early = html.replace('<b b-ry70cy3gjo="">Gate In Full</b>', '<b>Gate Out Full</b>').replace('<b b-ry70cy3gjo="">Gate Out Empty</b>', '<b>Gate In Empty</b>');
    const staged = parseSwire(early, query).events!.slice(-2);
    expect(staged.map((event) => [event.description, event.stage])).toEqual([['Gate Out Full', 'in_transit'], ['Gate In Empty', undefined]]);
    // After it sailed, a gate in is transit.
    const regated = parseSwire(after(html, row('13 Nov 2026', '08:55 AM', 'Gate In Full')), query);
    expect(regated.events![0]).toMatchObject({ description: 'Gate In Full', stage: 'in_transit' });
    // A move planned is not an event yet, and wording the map does not know has no stage.
    expect(parseSwire(after(html, row('30 Nov 2026', '08:00 AM', 'Gate Out Full', undefined, 'ESTIMATED')), query).events).toHaveLength(10);
    const unknown = parseSwire(after(html, row('13 Nov 2026', '08:55 AM', 'Synthetic Inspection')), query);
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic Inspection' });
  });

  it('stages a container shown by its latest move by where the move was', () => {
    const html = fixture('bl-WS00104400.html');
    // A full container leaving the port of loading is still on its way.
    const outbound = html.replace(/title="LONG BEACH, CA \(USLGB\)"><span>LONG BEACH, CA \(USLGB\)<\/span>(?![\s\S]*title="LONG BEACH)/,
      'title="APIA (WSAPW)"><span>APIA (WSAPW)</span>');
    const result = parseSwire(outbound, bill('WS00104400'));
    expect(result.events!.find((event) => event.location === 'APIA (WSAPW)')).toMatchObject({ description: 'Gate Out Full', stage: 'in_transit' });
    // A delivery decides only once each container has one.
    const emptied = html.replaceAll('title="Gate Out Full"><span>Gate Out Full</span>', 'title="Gate In Empty"><span>Gate In Empty</span>');
    expect(parseSwire(emptied, bill('WS00104400'))).toMatchObject({ current_stage: 'out_for_delivery' });
    const done = parseSwire(after(emptied, row('20 Nov 2026', '10:15 AM', 'Gate In Empty')), bill('WS00104400'));
    expect(done).toMatchObject({ current_stage: 'delivered', history_truncated: true });
  });

  it('marks a bill with containers the page leaves out as truncated', () => {
    const html = fixture('bl-TO00059000.html').replace('title="1"><span>1</span>', 'title="2"><span>2</span>');
    expect(parseSwire(html, bill('TO00059000'))).toMatchObject({ history_truncated: true });
  });

  it('rejects a page it cannot read for certain', () => {
    const html = fixture('bl-TO00059000.html');
    const query = bill('TO00059000');
    expect(() => parseSwire(html.replace('15 Oct 2026', '31 Feb 2026'), query)).toThrow(/invalid move time/);
    expect(() => parseSwire(html.replace('12:01 AM', '13:01 AM'), query)).toThrow(/invalid move time/);
    expect(() => parseSwire(html.replace(/<span class="custom-badge[^>]*>ACTUAL<\/span>/, ''), query)).toThrow(/changed its container history/);
    expect(() => parseSwire(html.replace('<div b-ry70cy3gjo="">NUKU ALOFA WHARF</div>', ''), query)).toThrow(/changed its container history/);
    expect(() => parseSwire(html.replace('<b b-ry70cy3gjo="">Gate In Full</b>', '<b></b>'), query)).toThrow(/without its name or port/);
    expect(() => parseSwire(html.replaceAll('JSSU1665854', 'JSSU166585'), query)).toThrow(/invalid container/);
    expect(() => parseSwire(html.replace('booking-card-grid', 'synthetic-grid'), query)).toThrow(/changed its tracking page/);
    const empty = load(html, null, false);
    empty('.tracking-timeline-grid').remove();
    empty('.container-card-grid').closest('.card-body').find('.container-tracking-body').remove();
    expect(() => parseSwire(empty.html().replace(/title="Import Discharged from Vessel"/, 'title="-"'), query)).toThrow(NoHistoryError);
    expect(() => parseSwire(fixture('not-found.html'), { kind: 'bl', number: 'SSBFLC613BSS0124' })).toThrow(/does not hold this number/);
  });
});

describe('Swire Shipping status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(swireStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'swire-shipping', providerCode: null, description: entry.wording }), entry.wording)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
    expect(swireStage('  gate in   EMPTY ')).toBe('delivered');
    expect(swireStage('Synthetic Inspection')).toBeUndefined();
  });
});
