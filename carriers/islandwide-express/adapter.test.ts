import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError, UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ISLANDWIDE_ACTION_URL, IslandwideTracker } from './adapter.js';
import { normalizeIslandwideNumber, parseIslandwide } from './parser.js';
import { islandwideCodeStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SHIPMENT = numbers.records[0]!.number;
const UNKNOWN = '999000999QZQZQZ9990009';

type Reply = Record<string, unknown> & { data: { Out_GetTrackingDetail2: { List: Record<string, unknown>[] } } };
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const delivered = () => fixture(`delivered-${SHIPMENT}`);
const shipmentOf = (reply: Reply) => reply.data.Out_GetTrackingDetail2.List[0]! as Record<string, unknown> & {
  TrackingHistory: { List: Record<string, unknown>[] };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const MODULE_VERSION = 'SyntheticModule0001';
const API_VERSION = 'SyntheticApi00001';
const CONTROLLER = `${'/* the app\'s other actions */\n'}TrackingController.default.getInformationbyTracking$ServerAction = function (inTrackingIn, trackListIn, inTenantIdIn, callContext) {
return controller.callServerAction("GetInformationbyTracking", "screenservices/Tracking/ActionGetInformationbyTracking", "${API_VERSION}", inputs, controller.callContext(callContext), undefined, undefined, true);`;

/** The app: its version, its manifest, its controller and the action answering `answer`. */
function app(answer: (body: Record<string, unknown>) => Response | Promise<Response>, versions: string[] = [MODULE_VERSION]) {
  let deploys = 0;
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === 'https://preidi.outsystemsenterprise.com/tracking/moduleservices/moduleversioninfo') {
      return json({ versionToken: versions[Math.min(deploys++, versions.length - 1)] });
    }
    if (url.startsWith('https://preidi.outsystemsenterprise.com/tracking/moduleservices/moduleinfo?')) {
      return json({ manifest: { versionToken: decodeURIComponent(url.split('?')[1]!), urlVersions: {
        '/Tracking/scripts/Tracking.controller.js': '?SyntheticScript01', '/Tracking/scripts/Tracking.model.js': '?SyntheticScript02',
      } } });
    }
    if (url === 'https://preidi.outsystemsenterprise.com/Tracking/scripts/Tracking.controller.js?SyntheticScript01') {
      return new Response(CONTROLLER, { headers: { 'Content-Type': 'application/javascript' } });
    }
    if (url === ISLANDWIDE_ACTION_URL) return answer(JSON.parse(String(init!.body)) as Record<string, unknown>);
    return new Response('missing', { status: 404 });
  });
}
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const puertoRico = (local: string) => ({ local_time: local, time: `${local}-04:00`, time_zone: 'America/Puerto_Rico', time_zone_basis: 'carrier' });

describe('Islandwide Express HTTP adapter', () => {
  it('reads the versions the app names, then asks its lookup action for the whole number as the page does', async () => {
    const fetcher = app(() => json(delivered()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new IslandwideTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(` ${SHIPMENT.toLowerCase()} `, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://preidi.outsystemsenterprise.com/tracking/moduleservices/moduleversioninfo',
      `https://preidi.outsystemsenterprise.com/tracking/moduleservices/moduleinfo?${MODULE_VERSION}`,
      'https://preidi.outsystemsenterprise.com/Tracking/scripts/Tracking.controller.js?SyntheticScript01',
      ISLANDWIDE_ACTION_URL,
    ]);
    const [, init] = fetcher.mock.calls[3]!;
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', 'X-CSRFToken': 'T6C+9iB49TLra4jEsMeSckDMNhQ=',
      'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(JSON.parse(String(init!.body))).toEqual({
      versionInfo: { moduleVersion: MODULE_VERSION, apiVersion: API_VERSION }, viewName: 'MainFlow.Tracking',
      inputParameters: { InTracking: SHIPMENT, TrackList: { List: [{ Tracking: SHIPMENT }] }, InTenantId: 0 },
    });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'islandwide-express', step: 'direct', outcome: 'ok' }));
    // The next lookup reuses the versions.
    await tracker.fetch(SHIPMENT, { budgetMs: 4000 });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(String(fetcher.mock.calls[4]![0])).toBe(ISLANDWIDE_ACTION_URL);
  });

  it('reads the history on Puerto Rico’s clock, newest first, at the terminals, and nothing about the people', () => {
    const result = parseIslandwide(delivered(), SHIPMENT);
    const ponce = 'Sabaneta Industrial Park 205 Hucar Street Ponce, 00716 PR';
    const caguas = 'Angora Industrial Park Urb. Angora Street No. 1 Caguas, 00725 PR';
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2026-04-29T11:20:23-04:00', last_update_local: '2026-04-29T11:20:23', expected_delivery: null,
      delivered_at: '2026-04-29T11:20:23-04:00',
      events: [
        // The page places a delivery and a pickup at the customer's address, which is not read.
        { ...puertoRico('2026-04-29T11:20:23'), description: 'Delivered', provider_code: '10', stage: 'delivered', stage_source: 'carrier_map' },
        { ...puertoRico('2026-04-29T06:05:54'), description: 'Out For Delivery', provider_code: '11', location: caguas,
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { ...puertoRico('2026-04-29T03:11:32'), description: 'In Terminal', provider_code: '4', location: caguas, stage: 'in_transit', stage_source: 'carrier_map' },
        { ...puertoRico('2026-04-28T22:47:32'), description: 'Left Terminal', provider_code: '5',
          location: 'Rexco Industrial Park 150 Calle B Guaynabo, 00968 PR', stage: 'in_transit', stage_source: 'carrier_map' },
        { ...puertoRico('2026-04-28T15:16:58'), description: 'Left Terminal', provider_code: '5', location: ponce, stage: 'in_transit', stage_source: 'carrier_map' },
        { ...puertoRico('2026-04-28T15:10:56'), description: 'In Terminal', provider_code: '4', location: ponce, stage: 'in_transit', stage_source: 'carrier_map' },
        { ...puertoRico('2026-04-28T13:53:35'), description: 'Pickup At', provider_code: '3', stage: 'accepted', stage_source: 'carrier_map' },
        // The label's row names no terminal.
        { ...puertoRico('2026-04-28T12:40:39'), description: 'Label has been generated for shipping', provider_code: '8',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('keeps the people, their addresses and the scans’ coordinates out of the result', () => {
    const reply = delivered();
    const shipment = shipmentOf(reply);
    Object.assign(shipment, { DeliveryAddress: '1 Synthetic Street Exampleville, 00999 PR', SignatureName: 'Synthetic Signer', Signature: 'U2lnbmF0dXJl' });
    for (const row of shipment.TrackingHistory.List) {
      Object.assign(row, { Latitude: '18.0001', Longitude: '-66.0001', AssociateId: '990001', UpdatedBy: 990002, SignerName: 'Synthetic Signer',
        LocationFrom: '2 Synthetic Road Exampletown, 00998 PR', LocationTo: '1 Synthetic Street Exampleville, 00999 PR', SignBinaryData: 'U2lnbmF0dXJl' });
    }
    expect(JSON.stringify(parseIslandwide(reply, SHIPMENT))).not.toMatch(/Synthetic|Example|18\.0001|66\.0001|99000|U2ln/);
  });

  it('reads the window of a shipment on its way, a state the map does not know by its wording, and another carrier’s row', () => {
    const reply = delivered();
    const shipment = shipmentOf(reply);
    shipment.TrackingStateId = 11;
    shipment.DeliveryDateTime = '';
    shipment.TrackingHistory.List = shipment.TrackingHistory.List.slice(0, 7);
    expect(parseIslandwide(reply, SHIPMENT)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out For Delivery',
      expected_delivery: '2026-04-29 06:00–20:00',
    });
    expect(parseIslandwide(reply, SHIPMENT)).not.toHaveProperty('delivered_at');
    // An empty window is no estimate.
    Object.assign(shipment, { WindowFrom: '01/01/1900 00:00:00', WindowTo: '01/01/1900 00:00:00' });
    expect(parseIslandwide(reply, SHIPMENT)).toMatchObject({ expected_delivery: null });

    shipment.TrackingStateId = 99;
    shipment.TrackingHistory.List.push({ ...shipment.TrackingHistory.List[6], StatusDateTime: '04/29/2026 09:00:00', Status: '99',
      LabelState: 'Synthetic note', TerminalDirection: 'Synthetic Industrial Park Caguas, 00725 PR' });
    shipment.TrackingHistory.List.push({ ...shipment.TrackingHistory.List[6], StatusDateTime: '04/29/2026 10:00:00', Status: '23',
      LabelState: 'Delivered to external carrier', CarrierStatusDescription: 'Arrived at Facility', DirectionUPS: 'Synthetic place' });
    const result = parseIslandwide(reply, SHIPMENT);
    // The current state is one the map does not know: the newest staged scan stands.
    expect(result).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Arrived at Facility' });
    expect(result.events!.slice(0, 2)).toEqual([
      { ...puertoRico('2026-04-29T10:00:00'), description: 'Arrived at Facility', provider_code: '23', stage: 'in_transit', stage_source: 'carrier_map' },
      { ...puertoRico('2026-04-29T09:00:00'), description: 'Synthetic note', provider_code: '99',
        location: 'Synthetic Industrial Park Caguas, 00725 PR' },
    ]);
  });

  it('reads the empty list for the number asked as not found, through the whole lookup', async () => {
    expect(() => parseIslandwide(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = app(() => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN }, { budgetMs: 4000 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a shipment under another number, several shipments, and a reply that changed', () => {
    const other = delivered();
    shipmentOf(other).TrackingNumber = UNKNOWN;
    expect(() => parseIslandwide(other, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = delivered();
    twice.data.Out_GetTrackingDetail2.List.push(shipmentOf(delivered()));
    expect(() => parseIslandwide(twice, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const reply of [null, [], {}, { data: {} }, { data: { Out_GetTrackingDetail2: {} } }, fixture('version-changed')]) {
      expect(() => parseIslandwide(reply, SHIPMENT), JSON.stringify(reply)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const error = { data: {}, exception: { name: 'ServerException', message: 'Synthetic failure' } };
    expect(() => parseIslandwide(error, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const clock = delivered();
    shipmentOf(clock).TrackingHistory.List[0]!.StatusDateTime = '2026-04-28 12:40';
    expect(() => parseIslandwide(clock, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const wordless = delivered();
    Object.assign(shipmentOf(wordless).TrackingHistory.List[0]!, { Status: '', LabelState: '' });
    expect(() => parseIslandwide(wordless, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a shipment without scans by its state, and one without either as no history', () => {
    const reply = delivered();
    const shipment = shipmentOf(reply);
    shipment.TrackingHistory.List = [];
    shipment.TrackingStateId = 8;
    expect(parseIslandwide(reply, SHIPMENT)).toMatchObject({
      status: 'pending', current_stage: 'registered', last_status_text: 'Label has been generated for shipping', provider_code: '8',
      summary_only: true, last_update: null, events: [],
    });
    shipment.TrackingStateId = 0;
    expect(() => parseIslandwide(reply, SHIPMENT)).toThrow(NoHistoryError);
  });

  it('reads the versions again after a deploy, and never reads a version it cannot match as a missing shipment', async () => {
    const answers = [json(delivered()), json(fixture('version-changed')), json(delivered())];
    const fetcher = app(() => answers.shift()!, [MODULE_VERSION, 'SyntheticModule0002']);
    const tracker = new IslandwideTracker({ fetcher });
    await tracker.fetch(SHIPMENT, { budgetMs: 4000 });
    await expect(tracker.fetch(SHIPMENT, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const posts = fetcher.mock.calls.filter(([url]) => String(url) === ISLANDWIDE_ACTION_URL);
    expect(posts.map(([, init]) => (JSON.parse(String(init!.body)) as { versionInfo: unknown }).versionInfo)).toEqual([
      { moduleVersion: MODULE_VERSION, apiVersion: API_VERSION },
      { moduleVersion: MODULE_VERSION, apiVersion: API_VERSION },
      { moduleVersion: 'SyntheticModule0002', apiVersion: API_VERSION },
    ]);
    const stale = app(() => json(fixture('version-changed')));
    await expect(carrier(stale).track({ number: UNKNOWN }, { budgetMs: 4000 })).rejects.toMatchObject({ kind: 'schema' });
    const unnamed = app(() => json(delivered()));
    unnamed.mockImplementationOnce(async () => json({ versionToken: '' }));
    await expect(carrier(unnamed).track({ number: SHIPMENT }, { budgetMs: 4000 })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps refusals, blocks, server errors, moved routes and pages in place of JSON apart from missing shipments', async () => {
    const refusal = { data: {}, exception: { name: 'ServerException', specificType: 'OutSystems.RESTService.ErrorHandling.ExposeRestException', message: 'Invalid Login' } };
    const cases: [() => Response, string][] = [
      [() => json(refusal, 403), 'schema'],
      [() => new Response('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [() => new Response(null, { status: 302, headers: { Location: '/tracking/_error.html' } }), 'transport'],
      [() => new Response('missing', { status: 404 }), 'transport'],
      [() => new Response('<html>Server Error</html>', { status: 500 }), 'indeterminate'],
      [() => new Response('<html>Synthetic page</html>', { headers: { 'Content-Type': 'text/html' } }), 'schema'],
      [() => new Response('', { status: 429 }), 'rate_limited'],
    ];
    for (const [answer, kind] of cases) {
      await expect(carrier(app(answer)).track({ number: UNKNOWN }, { budgetMs: 4000 }), kind).rejects.toMatchObject({ kind });
    }
    const gone = app(() => json(delivered()));
    gone.mockImplementationOnce(async () => new Response('missing', { status: 404 }));
    await expect(carrier(gone).track({ number: SHIPMENT }, { budgetMs: 4000 })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = app(() => json(delivered()));
    flaky.mockRejectedValueOnce(new TypeError('fetch failed'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new IslandwideTracker({ fetcher: flaky, recorder }).fetch(SHIPMENT, { budgetMs: 4000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: SHIPMENT }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
    const immediate = app(() => json(delivered()));
    await expect(carrier(immediate).track({ number: SHIPMENT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: SHIPMENT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
  });

  it('takes 6 to 40 letters and digits, with at least one digit, without a request for anything else', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '12345', 'ABCDEFGH', '002836100/CABXND', `9${'0'.repeat(40)}`, `${SHIPMENT}!`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(normalizeIslandwideNumber('002836100 cabxnd 0000000')).toBe(SHIPMENT);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Islandwide Express numbers and links', () => {
  it('offers Islandwide for its own shape, and routes a named carrier or its link to the adapter', async () => {
    expect(detectCarrierMatch(SHIPMENT).candidates).toEqual(['islandwide-express']);
    expect(recognitionAskedCarriers(SHIPMENT)).toContain('islandwide-express');
    for (const link of [`https://www.islandwide.com/tracking?TrackingNumber=${SHIPMENT}`, `https://islandwide.com/tracking/?TrackingNumber=${SHIPMENT}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: SHIPMENT, carrier: 'islandwide-express', source: 'link' });
    }
    const fetcher = app(() => json(delivered()));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: SHIPMENT, carrier: 'islandwide-express' }, { budgetMs: 4000 }))
      .resolves.toMatchObject({ carrier: 'islandwide-express', source: 'islandwide-express', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://preidi.outsystemsenterprise.com/'))).toBe(true);
  });

  it('recognizes a number the tracker holds, and not one it answers with an empty list or one it cannot take', async () => {
    await expect(carrier(app(() => json(delivered()))).recognize!(SHIPMENT, { budgetMs: 4000 })).resolves.toMatchObject({ known: true });
    await expect(carrier(app(() => json(fixture('not-found')))).recognize!(UNKNOWN, { budgetMs: 4000 })).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('ABCDEFGH')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(carrier(app(() => json(fixture('version-changed')))).recognize!(UNKNOWN, { budgetMs: 4000 })).rejects.toMatchObject({ kind: 'schema' });
  });
});

describe('Islandwide Express status vocabulary', () => {
  it('records every state id the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(islandwideCodeStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'islandwide-express', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'islandwide-express', providerCode: '99', description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
