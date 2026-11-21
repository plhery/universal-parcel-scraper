import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DAYTONA_TRACKER, DaytonaTracker } from './adapter.js';
import { normalizeDaytonaNumber, parseDaytona } from './parser.js';
import { daytonaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples in numbers.json, and the invented protocol whose reply is not-found.html.
const PICKUP = '572764710';
const ABSENT = '571954006';
const TWICE = '572517660';
const UNKNOWN = '579999999';
const FIXTURES: Record<string, string> = { [PICKUP]: 'pickup-to-delivery', [ABSENT]: 'absent-recipient', [TWICE]: 'booked-delivery' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${FIXTURES[name] ?? name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
/** A fetcher for the tracker: each sample's page by its protocol, and the not-found page for any other. */
const tracker = (pages: Record<string, string> = {}) => vi.fn<typeof fetch>(async (url) => {
  const protocol = new URL(String(url)).searchParams.get('txtcto')!;
  return page(pages[protocol] ?? fixture(FIXTURES[protocol] ? protocol : 'not-found'));
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Daytona Express HTTP adapter', () => {
  it('reads a protocol from its pickup request to its delivery at the base clocks', async () => {
    const fetcher = tracker();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new DaytonaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${PICKUP} `);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${DAYTONA_TRACKER}?txtcto=${PICKUP}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGA EFETUADA - FINALIZADA', last_update: null, last_update_local: '2024-10-29T10:30:00', expected_delivery: null });
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2024-10-29T10:30:00', 'JOINVILLE, SC', 'ENTREGA EFETUADA - FINALIZADA', 'delivered'],
      ['2024-10-29T09:36:00', 'JOINVILLE, SC', 'ROTA DE ENTREGA', 'out_for_delivery'],
      ['2024-10-29T09:12:00', 'JOINVILLE, SC', 'RECEBIDO NA BASE', 'in_transit'],
      ['2024-10-28T19:08:00', 'SAO PAULO, SP', 'TRANSFERENCIA EFETUADA', 'in_transit'],
      ['2024-10-28T16:52:00', 'SAO PAULO, SP', 'RECEBIDO NA BASE', 'in_transit'],
      ['2024-10-28T13:26:00', 'SAO PAULO, SP', 'AGUARDANDO CHEGADA DA CARGA PARA TRANSFERÊNCIA', 'in_transit'],
      ['2024-10-24T13:39:00', 'SAO PAULO, SP', 'AGUARDANDO CHEGADA DA CARGA PARA TRANSFERÊNCIA', 'in_transit'],
      ['2024-10-23T08:28:00', 'SAO PAULO, SP', 'AGUARDANDO CHEGADA DA CARGA PARA TRANSFERÊNCIA', 'in_transit'],
      ['2024-10-22T08:00:00', 'SAO PAULO, SP', 'AGUARDANDO CHEGADA DA CARGA PARA TRANSFERÊNCIA', 'in_transit'],
      ['2024-10-21T19:30:00', 'SALVADOR, BA', 'TRANSFERENCIA EFETUADA', 'in_transit'],
      ['2024-10-21T19:00:00', 'SALVADOR, BA', 'COLETA EFETUADA - EM TRANSITO', 'accepted'],
      ['2024-10-21T08:00:00', 'SALVADOR, BA', 'COLETA AGENDADA', 'registered'],
      ['2024-10-18T16:08:00', 'SALVADOR, BA', 'AGUARDANDO AGENDAMENTO DO CLIENTE', 'registered'],
      ['2024-10-15T17:07:00', 'SALVADOR, BA', 'COLETA SOLICITADA', 'registered'],
    ]);
    expect(result.events!.every(event => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // Whoever signed for the parcel stays behind.
    expect(JSON.stringify(result)).not.toContain('MARCO');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'daytona-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads absent recipients and a parcel held at the base before the delivery', async () => {
    const result = await carrier(tracker()).track({ number: ABSENT });
    expect(result.current_stage).toBe('delivered');
    expect(result.events!.slice(0, 5).map(event => [event.local_time, event.description, event.stage])).toEqual([
      ['2022-10-10T11:45:00', 'ENTREGA EFETUADA - FINALIZADA', 'delivered'],
      ['2022-10-10T08:00:00', 'ROTA DE ENTREGA', 'out_for_delivery'],
      ['2022-10-06T18:00:00', 'ENCOMENDA RETIDA NA BASE, AGUARDANDO INFORMAÇÕES.', 'exception'],
      ['2022-10-06T11:45:00', 'AUSENTE', 'failed_attempt'],
      ['2022-10-06T08:00:00', 'ROTA DE ENTREGA', 'out_for_delivery'],
    ]);
    // The pickup is scanned after the transfer that carries it on; each scan keeps its own base's clock.
    expect(result.events!.slice(-4).map(event => [event.local_time, event.location, event.description])).toEqual([
      ['2022-09-23T18:52:00', 'RIO DO SUL, SC', 'COLETA EFETUADA - EM TRANSITO'],
      ['2022-09-23T18:35:00', 'BLUMENAU, SC', 'TRANSFERENCIA EFETUADA'],
      ['2022-09-23T16:17:00', 'RIO DO SUL, SC', 'COLETA AGENDADA'],
      ['2022-09-23T16:16:00', 'RIO DO SUL, SC', 'COLETA SOLICITADA'],
    ]);
  });

  it('takes the protocol as customers quote it', async () => {
    const result = await carrier(tracker()).track({ number: `HAWB - ${TWICE}` });
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2024-03-12T10:30:00' });
    expect(result.events!.filter(event => event.stage === 'delivered')).toHaveLength(2);
    expect(result.events!.find(event => event.description === 'ENTREGA AGENDADA PARA PRÓXIMO DIA ÚTIL')).toMatchObject({ stage: 'in_transit' });
  });

  it('reads the tracker’s not-found answer only when it names the protocol asked', async () => {
    await expect(carrier(tracker()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseDaytona(fixture('not-found'), '579999998')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not take another protocol’s page, as the tracker also finds shipments by invoice number', () => {
    expect(() => parseDaytona(fixture(PICKUP), TWICE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twoShipments = fixture(PICKUP).replace('</h3>', `</h3><h3 class="rastreamento_detalhes">Detalhes - HAWB - ${TWICE}</h3>`);
    expect(() => parseDaytona(twoShipments, PICKUP)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a protocol listed without scans as no history', () => {
    const empty = fixture(PICKUP).replace(/<tr class="textoinformativo">\s*<td valign[\s\S]*?<\/tr>/g, '');
    expect(() => parseDaytona(empty, PICKUP)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('keeps a bot check, a rate limit and a moved tracker apart from a missing shipment', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: PICKUP });
    await expect(answer(page('<html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page('<html><title>403 Forbidden</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(page('', { status: 302, headers: { Location: '/Account/Login' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('reads a changed page as a schema change, not as a missing shipment', async () => {
    const answer = (body: string) => carrier(tracker({ [PICKUP]: body })).track({ number: PICKUP });
    await expect(answer('<html><body>Manutenção programada</body></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer(fixture('not-found').replace(/Desculpe! Nosso sistema não localizou/, 'Sistema indisponível'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer(fixture(PICKUP).replace('29/10/2024</td>', '31/02/2024</td>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer(fixture(PICKUP).replace('>10:30</td>', '>25:30</td>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('retries once when the first request does not reach the tracker', async () => {
    const fetcher = tracker();
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: PICKUP }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends a nine-digit protocol only', async () => {
    expect(normalizeDaytonaNumber('hawb 572764710')).toBe(PICKUP);
    expect(normalizeDaytonaNumber('572.764.710')).toBe(PICKUP);
    const fetcher = tracker();
    for (const bad of ['57276471', '5727647100', 'ABC572764710', 'HAWB', '1'.repeat(70), '']) {
      await expect(carrier(fetcher).track({ number: bad }), bad).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers the wordings statuses.json records', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'daytona-express', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
      expect(daytonaStage(wording)).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'daytona-express', providerCode: null, description: 'ENCOMENDA EXTRAVIADA' })).toEqual({ kind: 'unknown' });
  });
});
