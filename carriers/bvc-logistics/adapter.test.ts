import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError, UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BVC_ACTION_URL, BvcTracker } from './adapter.js';
import { normalizeBvcNumber, parseBvc } from './parser.js';
import { bvcStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SHIPMENT = numbers.records[0]!.number;
const UNKNOWN = 'DS9907413';

type Row = Record<string, unknown> & { Hub: { Name: string } };
type Reply = Record<string, unknown> & { data: { Trackings: { List: Row[] }; ShippingNoteNumbers: { List: string[] } } };
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const delivered = () => fixture('delivered');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const ORIGIN = 'https://track2.bvclogistics.com';
const MODULE_VERSION = 'SyntheticModule0001';
const API_VERSION = 'SyntheticApi00001';
const BLOCK = `${'/* the block\'s other actions */\n'}ValshipController.default.getTrackData$ServerAction = function (shippingNoteNumberIn, callContext) {
return controller.callServerAction("GetTrackData", "screenservices/Tracking/MainFlow/Valship/ActionGetTrackData", "${API_VERSION}", inputs, controller.callContext(callContext), OutSystemsDebugger.getRequestHeaders(callContext.id), function (json, headers) {`;

/** The app: its version, its manifest, the ValSHIP block's script and the action answering `answer`. */
function app(answer: (body: Record<string, unknown>) => Response | Promise<Response>, versions: string[] = [MODULE_VERSION]) {
  let deploys = 0;
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === `${ORIGIN}/moduleservices/moduleversioninfo`) return json({ versionToken: versions[Math.min(deploys++, versions.length - 1)] });
    if (url.startsWith(`${ORIGIN}/moduleservices/moduleinfo?`)) {
      return json({ manifest: { versionToken: decodeURIComponent(url.split('?')[1]!), urlVersions: {
        '/Tracking/scripts/Tracking.MainFlow.Valship.mvc.js': '?SyntheticScript01', '/Tracking/scripts/Tracking.controller.js': '?SyntheticScript02',
      } } });
    }
    if (url === `${ORIGIN}/scripts/Tracking.MainFlow.Valship.mvc.js?SyntheticScript01`) {
      return new Response(BLOCK, { headers: { 'Content-Type': 'application/javascript' } });
    }
    if (url === BVC_ACTION_URL) return answer(JSON.parse(String(init!.body)) as Record<string, unknown>);
    return new Response('missing', { status: 404 });
  });
}
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (time: string, description: string, stage: string, location?: string) => ({
  time, ...(location ? { location } : {}), description, stage, stage_source: 'carrier_map',
});

describe('BVC Logistics HTTP adapter', () => {
  it('reads the versions the app names, then asks the ValSHIP lookup for the whole number as the page does', async () => {
    const fetcher = app(() => json(delivered()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const tracker = new BvcTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(` ${SHIPMENT.toLowerCase()} `, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${ORIGIN}/moduleservices/moduleversioninfo`,
      `${ORIGIN}/moduleservices/moduleinfo?${MODULE_VERSION}`,
      `${ORIGIN}/scripts/Tracking.MainFlow.Valship.mvc.js?SyntheticScript01`,
      BVC_ACTION_URL,
    ]);
    const [, init] = fetcher.mock.calls[3]!;
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json; charset=UTF-8', 'X-CSRFToken': 'T6C+9iB49TLra4jEsMeSckDMNhQ=',
      'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(JSON.parse(String(init!.body))).toEqual({
      versionInfo: { moduleVersion: MODULE_VERSION, apiVersion: API_VERSION }, viewName: 'MainFlow.ShipmentTracking',
      inputParameters: { ShippingNoteNumber: SHIPMENT },
    });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bvc-logistics', step: 'direct', outcome: 'ok' }));
    // The next lookup reuses the versions.
    await tracker.fetch(SHIPMENT, { budgetMs: 4000 });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(String(fetcher.mock.calls[4]![0])).toBe(BVC_ACTION_URL);
  });

  it('reads the UTC instants on India’s clock, newest first, in each row’s town', () => {
    expect(parseBvc(delivered(), SHIPMENT)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: '2025-06-11T17:25:06+05:30', expected_delivery: null, delivered_at: '2025-06-11T17:25:06+05:30',
      events: [
        scan('2025-06-11T17:25:06+05:30', 'Delivered', 'delivered', 'Mapusa'),
        scan('2025-06-11T11:05:07+05:30', 'Out for Delivery', 'out_for_delivery', 'Mapusa'),
        scan('2025-06-11T10:32:52+05:30', 'Destination Hub', 'in_transit', 'Margao'),
        // A row on the road names no town or hub.
        scan('2025-06-11T03:53:48+05:30', 'In Transit', 'in_transit'),
        scan('2025-06-10T11:19:15+05:30', 'Transit Hub', 'in_transit', 'Mumbai'),
        scan('2025-06-10T02:29:29+05:30', 'In Transit', 'in_transit'),
        scan('2025-06-09T21:11:24+05:30', 'Origin Hub', 'in_transit', 'Jaipur'),
        // The reply lists the two pickups oldest first.
        scan('2025-06-09T19:29:01+05:30', 'Picked Up', 'accepted', 'Jaipur'),
        scan('2025-06-09T19:25:17+05:30', 'Picked Up', 'accepted', 'Jaipur'),
      ],
    });
  });

  it('places a row without a town at its hub, reads a step the map does not know by its wording, and drops repeats', () => {
    const reply = delivered();
    const rows = reply.data.Trackings.List;
    rows.splice(0, 2);
    Object.assign(rows[0]!, { City: '' });
    rows.unshift({ ...rows[0]!, Time: '2025-06-11T06:00:00.5Z', Location: 'Synthetic step', City: '', Hub: { Name: '' } });
    rows.push({ ...rows.at(-1)! }, { ...rows[0]!, Time: '1900-01-01T00:00:00' });
    const result = parseBvc(reply, SHIPMENT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Synthetic step',
      last_update: '2025-06-11T11:30:00.500+05:30' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.slice(0, 2)).toEqual([
      { time: '2025-06-11T11:30:00.500+05:30', description: 'Synthetic step' },
      scan('2025-06-11T10:32:52+05:30', 'Destination Hub', 'in_transit', 'GOA'),
    ]);
    expect(result.events).toHaveLength(8);
    expect(bvcStage('Shipment delivered')).toMatchObject({ stage: 'delivered' });
  });

  it('reads the empty list for the number asked as not found, through the whole lookup', async () => {
    expect(() => parseBvc(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = app(() => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN }, { budgetMs: 4000 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses an answer about another number, and a reply that changed', () => {
    const echoed = fixture('not-found');
    echoed.data.ShippingNoteNumbers.List = [SHIPMENT];
    expect(() => parseBvc(echoed, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    echoed.data.ShippingNoteNumbers.List = [];
    expect(() => parseBvc(echoed, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = delivered();
    other.data.Trackings.List[3]!.ShipmentNoteNumber = UNKNOWN;
    expect(() => parseBvc(other, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const reply of [null, [], {}, { data: {} }, { data: { Trackings: {}, ShippingNoteNumbers: { List: [SHIPMENT] } } }, fixture('version-changed')]) {
      expect(() => parseBvc(reply, SHIPMENT), JSON.stringify(reply)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const error = { data: {}, exception: { name: 'ServerException', message: 'Synthetic failure' } };
    expect(() => parseBvc(error, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A time without its zone, or a wall clock in another format, is not guessed.
    for (const time of ['2025-06-11T11:55:06', '11/06/2025 11:55', 7]) {
      const clock = delivered();
      clock.data.Trackings.List[0]!.Time = time;
      expect(() => parseBvc(clock, SHIPMENT), String(time)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const wordless = delivered();
    wordless.data.Trackings.List[0]!.Location = '';
    expect(() => parseBvc(wordless, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads rows without a time alone as no history', () => {
    const reply = delivered();
    reply.data.Trackings.List = [{ ...reply.data.Trackings.List[0]!, Time: '1900-01-01T00:00:00' }];
    expect(() => parseBvc(reply, SHIPMENT)).toThrow(NoHistoryError);
  });

  it('reads the versions again after a deploy, and never reads a version it cannot match as a missing shipment', async () => {
    const answers = [json(delivered()), json(fixture('version-changed')), json(delivered())];
    const fetcher = app(() => answers.shift()!, [MODULE_VERSION, 'SyntheticModule0002']);
    const tracker = new BvcTracker({ fetcher });
    await tracker.fetch(SHIPMENT, { budgetMs: 4000 });
    await expect(tracker.fetch(SHIPMENT, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const posts = fetcher.mock.calls.filter(([url]) => String(url) === BVC_ACTION_URL);
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
    const unlisted = app(() => json(delivered()));
    unlisted.mockImplementationOnce(async () => json({ versionToken: MODULE_VERSION }))
      .mockImplementationOnce(async () => json({ manifest: { urlVersions: {} } }));
    await expect(carrier(unlisted).track({ number: SHIPMENT }, { budgetMs: 4000 })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps refusals, blocks, server errors, moved routes and pages in place of JSON apart from missing shipments', async () => {
    const refusal = { data: {}, exception: { name: 'ServerException', specificType: 'OutSystems.RESTService.ErrorHandling.ExposeRestException', message: 'Invalid Login' } };
    const cases: [() => Response, string][] = [
      [() => json(refusal, 403), 'schema'],
      [() => new Response('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [() => new Response('<html><title>Just a moment...</title></html>'), 'challenge'],
      [() => new Response(null, { status: 302, headers: { Location: '/_error.html' } }), 'transport'],
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
    await expect(new BvcTracker({ fetcher: flaky, recorder }).fetch(SHIPMENT, { budgetMs: 4000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: SHIPMENT }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
    const immediate = app(() => json(delivered()));
    await expect(carrier(immediate).track({ number: SHIPMENT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: SHIPMENT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
  });

  it('takes 7 to 30 letters and digits, with at least one digit, without a request for anything else', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'DS1234', 'ABCDEFGH', `${SHIPMENT},${UNKNOWN}`, `DS${'1'.repeat(29)}`, `${SHIPMENT}!`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(normalizeBvcNumber(`ds 180-8568`)).toBe(SHIPMENT);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('BVC Logistics numbers', () => {
  it('offers no carrier for the sample, and tracks it when BVC is named', async () => {
    expect(detectCarrierMatch(SHIPMENT).candidates).not.toContain('bvc-logistics');
    const fetcher = app(() => json(delivered()));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: SHIPMENT, carrier: 'bvc-logistics' }, { budgetMs: 4000 }))
      .resolves.toMatchObject({ carrier: 'bvc-logistics', source: 'bvc-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${ORIGIN}/`))).toBe(true);
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

describe('BVC Logistics status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries) {
      expect(bvcStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'bvc-logistics', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage(null, 'Synthetic step')).toBeUndefined();
  });
});
