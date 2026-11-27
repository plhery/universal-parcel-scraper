import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, iflowOrderUrl, iflowSearchUrl, IflowTracker, normalizeIflowNumber, parseIflowOrder, parseIflowSearch, withoutPeople } from './adapter.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// Synthetic: no public number answers on iFLOW's tracker.
const NUMBER = 'ABC0000001234567';
const OTHER = 'ABC0000007654321';
const ID = '123456';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const SERVER_ERROR = readFileSync(new URL('./fixtures/server-error.json', import.meta.url), 'utf8');
type Order = ReturnType<typeof fixture>;
const changed = (edit: (order: Order) => void): Order => { const order = fixture('synthetic-order'); edit(order); return order; };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The search's reply, then the order's. */
const api = (search: () => Response, order: () => Response = () => json(fixture('synthetic-order'))) =>
  vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).includes('/search/') ? search() : order()));
const found = () => api(() => json({ tracking_id: ID }));
const state = (ifowState: string, dateSort: unknown, date: unknown, details: string, reason: unknown = null) =>
  ({ state: 'Synthetic', ifowState, dateSort, date, details, reason, showDate: true });

describe('iFLOW tracking adapter', () => {
  it('searches the whole code, then reads its order, with the supplied transport and budget', async () => {
    const fetcher = found();
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new IflowTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(5);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([iflowSearchUrl(NUMBER), iflowOrderUrl(ID)]);
    expect(iflowSearchUrl(NUMBER)).toBe(`https://api-btp.iflow21.com/tracking/order/search/${NUMBER}`);
    expect(iflowOrderUrl(ID)).toBe(`https://api-btp.iflow21.com/tracking/order/${ID}`);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1' }) });
      expect(new Headers(init!.headers).has('cookie')).toBe(false);
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'iflow', step: 'direct', outcome: 'ok' }));
    expect(carrier(fetcher)).toMatchObject({ id: 'iflow', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a code the tracker does not take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'ABC' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of ['', 'AB12', 'ABCDEFGHIJ', 'ABC0000001234567/', 'ABC000000123456?', `${'A'.repeat(40)}1`, 'X'.repeat(70)]) {
      expect(() => normalizeIflowNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    for (const number of [NUMBER, 'abc0000001234567', 'OR00001234', 'ABC-000000-1234567']) expect(normalizeIflowNumber(` ${number} `)).toMatch(/^[A-Z0-9]+$/);
  });

  it('reads the search’s server error as no record shown, which recognition reads as unknown', async () => {
    const fetcher = api(() => json(SERVER_ERROR, 500));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found', status: 500 });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toMatchObject({ known: false });
  });

  it('reads a reply without an id as not found, as the tracker words it', async () => {
    for (const body of ['', 'null', '{}', '{"tracking_id":null}', '{"tracking_id":""}']) {
      const fetcher = api(() => json(body));
      await expect(carrier(fetcher).track({ number: NUMBER }), body).rejects.toMatchObject({ kind: 'not_found' });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    expect(parseIflowSearch('{"tracking_id":123456}', NUMBER)).toBe(ID);
    for (const body of ['[]', '"123456"', '{"statusCode":404,"message":"Not Found"}', '{"tracking_id":"12a"}', '{"tracking_id":-1}',
      '{"tracking_id":{"id":1}}', '{"tracking_id":1.5}']) {
      expect(() => parseIflowSearch(body, NUMBER), body).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it.each([[500, 'transport'], [404, 'transport'], [410, 'transport'], [302, 'transport'], [403, 'challenge'], [429, 'rate_limited'],
    [503, 'maintenance'], [502, 'indeterminate']] as const)('keeps the search’s HTTP %i apart from a missing parcel, without another request', async (status, kind) => {
    const fetcher = api(() => (status === 302 ? new Response(null, { status, headers: { Location: '/' } })
      : new Response('<html><body>Synthetic error</body></html>', { status, headers: { 'Content-Type': 'text/html', 'retry-after': '60' } })));
    const error = await carrier(fetcher).track({ number: NUMBER }, { budgetMs: 2000 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind });
    expect(error).not.toMatchObject({ reason: 'portal_not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reads a verification page as a challenge and another page as a changed service', async () => {
    const answer = async (body: string) => carrier(api(() => new Response(body, { headers: { 'Content-Type': 'text/html' } })))
      .track({ number: NUMBER }).catch((error: unknown) => error);
    expect(await answer('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>')).toMatchObject({ kind: 'challenge' });
    expect(await answer('<!doctype html><html><head><title>iFLOW Tracking</title></head><body><div id="root"></div></body></html>'))
      .toMatchObject({ kind: 'schema' });
  });

  it('keeps a failed order read apart from the code, which the search found', async () => {
    const answer = (order: () => Response) => carrier(api(() => json({ tracking_id: ID }), order)).track({ number: NUMBER }).catch((error: unknown) => error);
    const failed = await answer(() => json(SERVER_ERROR, 500));
    expect(failed).toMatchObject({ kind: 'indeterminate', status: 500 });
    expect(failed).not.toMatchObject({ reason: 'portal_not_found' });
    expect(await answer(() => json({}))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json(changed((order) => { order.tracking_id = '654321'; })))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('<html></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 404 }))).toMatchObject({ kind: 'transport' });
  });

  it('sends the lookup once more when it fails to reach the API', async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      calls += 1;
      if (calls === 2) throw new TypeError('synthetic socket reset');
      return String(url).includes('/search/') ? json({ tracking_id: ID }) : json(fixture('synthetic-order'));
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new IflowTracker({ fetcher, recorder }).fetch(NUMBER, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    await expect(new IflowTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new IflowTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection, and recognition confirms a found shipment', async () => {
    const answer = await createTracker({ fetcher: found(), env: {}, providers: [] }).track({ carrier: 'iflow', number: NUMBER });
    expect(answer).toMatchObject({ carrier: 'iflow', source: 'iflow' });
    expect(answer.result.events).toHaveLength(5);
    await expect(carrier(found()).recognize!(NUMBER)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-11-12T15:13:00.000Z' });
    // The rule offers the public sample's TRI code.
    const sample = numbers.records[0]!.number;
    expect(detectCarrierMatch(sample)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['iflow']) });
    expect(recognitionCandidates(sample).map((candidate) => candidate.carrier)).toContain('iflow');
  });
});

describe('iFLOW replies', () => {
  it('reads the asked shipment’s states newest first, at their instants on Argentina’s clock', () => {
    const result = parseIflowOrder(fixture('synthetic-order'), NUMBER, ID);
    expect(result).toMatchObject({ status: languageStageStatus('in_transit'), current_stage: 'in_transit', current_stage_source: 'carrier_map',
      provider_code: 'Despachado a Nodo Interno', last_status_text: 'Tu pedido se encuentra en camino a la sucursal más cercana a tu domicilio',
      last_update: '2026-11-12T12:13:00.000-03:00', expected_delivery: '2026-11-20', expected_delivery_from: '2026-11-18' });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-11-12T12:13:00.000-03:00', 'Despachado a Nodo Interno', 'in_transit'],
      ['2026-11-12T10:21:00.000-03:00', 'Recibido en CD', 'in_transit'],
      ['2026-11-10T20:41:00.000-03:00', 'Descargado', 'in_transit'],
      ['2026-11-10T18:36:00.000-03:00', 'Retirado', 'accepted'],
      ['2026-11-07T20:29:00.000-03:00', 'Registrado', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && !('local_time' in event))).toBe(true);
    expect(Date.parse(result.events![0]!.time!)).toBe(Date.parse('2026-11-12T15:13:00.000Z'));
    expect(JSON.stringify(result)).not.toMatch(/Persona|Inventada|Tienda|654321|synthetic-label|Paso sint/);
  });

  it('reads only the shipment asked of an order that holds several', () => {
    const result = parseIflowOrder(fixture('synthetic-order'), OTHER, ID);
    expect(result).toMatchObject({ current_stage: 'registered', provider_code: 'Registrado', last_update: '2026-11-08T09:00:00.000-03:00',
      expected_delivery: '2026-11-19' });
    expect(result.expected_delivery_from).toBeUndefined();
    expect(result.events).toHaveLength(1);
    expect(() => parseIflowOrder(fixture('synthetic-order'), 'ABC0000009999999', ID)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('names the shipment when the seller’s order number found an order of one shipment', () => {
    const single = changed((order) => { order.shippings.pop(); });
    expect(parseIflowOrder(single, '654321', ID)).toMatchObject({ canonical_tracking_number: NUMBER, current_stage: 'in_transit' });
    expect(() => parseIflowOrder(fixture('synthetic-order'), '654321', ID)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps the shown wall clock when it is not the instant’s, and fails without a clock', () => {
    const shifted = changed((order) => { order.shippings[0].steps[1].states[2].dateSort = '2026-11-12T12:13:00.000Z'; });
    expect(parseIflowOrder(shifted, NUMBER, ID).events![0]).toMatchObject({ local_time: '2026-11-12T12:13:00', provider_code: 'Despachado a Nodo Interno' });
    expect(parseIflowOrder(shifted, NUMBER, ID)).toMatchObject({ last_update: null, last_update_local: '2026-11-12T12:13:00' });
    const shownOnly = changed((order) => { order.shippings[0].steps[1].states[2].dateSort = null; });
    expect(parseIflowOrder(shownOnly, NUMBER, ID).events![0]).toMatchObject({ local_time: '2026-11-12T12:13:00' });
    const sortOnly = changed((order) => { order.shippings[0].steps[1].states[2].date = ''; });
    expect(parseIflowOrder(sortOnly, NUMBER, ID).events![0]).toMatchObject({ time: '2026-11-12T12:13:00.000-03:00' });
    const neither = changed((order) => { Object.assign(order.shippings[0].steps[1].states[2], { dateSort: '2026-11-12 15:13', date: '12/13/2026 12:13' }); });
    expect(() => parseIflowOrder(neither, NUMBER, ID)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a state the map does not know by its wording, with the reason the tracker shows', () => {
    const delivered = changed((order) => {
      order.shippings[0].steps[2].states.push(state('Entregado', '2026-11-19T17:05:00.000Z', '19/11/2026 14:05', 'Tu pedido fue entregado'));
    });
    const result = parseIflowOrder(delivered, NUMBER, ID);
    expect(result).toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language', provider_code: 'Entregado',
      expected_delivery: null });
    expect(result.expected_delivery_from).toBeUndefined();
    const failed = changed((order) => {
      order.shippings[0].steps[2].states.push(state('Visita', '2026-11-19T17:05:00.000Z', '19/11/2026 14:05', 'No pudimos entregar tu pedido', 'Destinatario ausente'));
    });
    expect(parseIflowOrder(failed, NUMBER, ID)).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'No pudimos entregar tu pedido - Destinatario ausente' });
    const unread = changed((order) => {
      order.shippings[0].steps[2].states.push(state('Sintético', '2026-11-19T17:05:00.000Z', '19/11/2026 14:05', 'Novedad sintética'));
    });
    expect(parseIflowOrder(unread, NUMBER, ID)).toMatchObject({ current_stage: 'in_transit', provider_code: 'Sintético' });
    expect(parseIflowOrder(unread, NUMBER, ID).events![0]!.stage).toBeUndefined();
  });

  it('takes names, phone and identity numbers out of the wording', () => {
    const names = ['Persona Inventada Prueba', 'Tienda Sintética'];
    expect(withoutPeople('Entregado a persona  inventada prueba', names)).toBe('Entregado a');
    expect(withoutPeople('Recibió: Persona Inventada Prueba DNI 12.345.678', names)).toBe('Recibió');
    expect(withoutPeople('Llamamos al +54 9 11 5555-0000 sin respuesta, reprogramado', names)).toBe('Llamamos al sin respuesta, reprogramado');
    expect(withoutPeople('Devuelto a Tienda Sintética el 19/11/2026', names)).toBe('Devuelto a el 19/11/2026');
    expect(withoutPeople('Tu pedido llegó a nuestro centro de distribución', names)).toBe('Tu pedido llegó a nuestro centro de distribución');
    const named = changed((order) => {
      order.shippings[0].steps[2].states.push(state('Visita', '2026-11-19T17:05:00.000Z', '19/11/2026 14:05', 'No pudimos entregar tu pedido',
        'Persona Inventada Prueba no respondió al 1155550000'));
    });
    expect(JSON.stringify(parseIflowOrder(named, NUMBER, ID))).not.toMatch(/Persona|Inventada|1155550000/);
  });

  it('places the window’s days in the year nearest the newest state, and leaves an unplaceable one unread', () => {
    const atYearEnd = changed((order) => {
      order.shippings[0].steps[1].states[2] = state('Despachado a Nodo Interno', '2026-12-29T15:00:00.000Z', '29/12/2026 12:00', 'Synthetic');
      order.shippings[0].estimatedDeliveryDate = { min: '30/12', max: '02/01' };
    });
    expect(parseIflowOrder(atYearEnd, NUMBER, ID)).toMatchObject({ expected_delivery: '2027-01-02', expected_delivery_from: '2026-12-30' });
    for (const window of [{ min: '18/05', max: '20/05' }, { min: '31/11', max: '02/12' }, { min: 'pronto', max: '20/11' }, { min: '18/11', max: '10/03' }, 'pronto']) {
      const result = parseIflowOrder(changed((order) => { order.shippings[0].estimatedDeliveryDate = window; }), NUMBER, ID);
      expect(result, JSON.stringify(window)).toMatchObject({ expected_delivery: null, unread_estimates: ['estimatedDeliveryDate'] });
    }
    for (const window of [null, {}, { min: '18/11', max: '' }]) {
      const result = parseIflowOrder(changed((order) => { order.shippings[0].estimatedDeliveryDate = window; }), NUMBER, ID);
      expect(result.expected_delivery).toBeNull();
      expect(result.unread_estimates).toBeUndefined();
    }
  });

  it('reads a listed shipment without a state as no history, and a changed order as a schema failure', () => {
    const empty = changed((order) => { for (const step of order.shippings[0].steps) step.states = []; });
    expect(() => parseIflowOrder(empty, NUMBER, ID)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    for (const edit of [
      (order: Order) => { order.shippings = {}; },
      (order: Order) => { order.shippings[0].steps = 'none'; },
      (order: Order) => { order.shippings[0].steps[0].states = [1]; },
      (order: Order) => { Object.assign(order.shippings[0].steps[0].states[0], { details: { text: 'x' }, state: null, ifowState: '' }); },
      (order: Order) => { order.shippings.push(order.shippings[0]); },
    ]) expect(() => parseIflowOrder(changed(edit), NUMBER, ID)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseIflowOrder([], NUMBER, ID)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('stages every recorded state by its code, as the status map answers', () => {
    for (const entry of statuses.entries) {
      expect(STAGES).toContain(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code.toUpperCase(), ''), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'iflow', providerCode: entry.code, description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('Sintético', 'novedad sintética')).toBeUndefined();
  });
});
