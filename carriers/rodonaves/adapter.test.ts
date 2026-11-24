import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BRUDAM_LOOKUP, normalizeRodonavesNumber, parseBrudam, parseRodo, RODO_LOOKUP } from './adapter.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The two public samples in numbers.json, the synthetic road protocol and an invented number.
const BILLED_SAMPLE = '159853';
const DELIVERED_SAMPLE = '110455';
const ROAD = '900000000001';
const OTHER = '999999999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('brudam-delivered');
const BILLED = fixture('brudam-billed');
const NOT_FOUND = fixture('brudam-not-found');
const ROAD_REPLY = fixture('rodo-synthetic');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json;charset=utf-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const noContent = () => new Response(null, { status: 204 });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A fetcher answering the road lookup and the Brudam lookup each with their own reply. */
const lookups = (road: () => Response | Promise<Response>, air: () => Response | Promise<Response>) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url).startsWith(RODO_LOOKUP) ? road() : air()));
const brudam = (record: Record<string, unknown>) => ({ message: 'OK', status: 1, data: [{ status: 1, message: 'OK', documento: DELIVERED_SAMPLE,
  prev_entrega: '2031-03-06 18:00:00', dias_entrega: '3', dados: [], ...record }] });
const occurrence = (fields: Record<string, unknown> = {}) => ({ data: '2031-03-04 10:00:00', status: 140, descricao: 'EMBARQUE NO VOO (GRU)',
  servico: 'ECONOMICO', ...fields });
const road = (fields: Record<string, unknown> = {}) => ({ ...JSON.parse(ROAD_REPLY) as Record<string, unknown>, ...fields });

describe('Rodonaves numbers', () => {
  it('takes protocol and minuta numbers of 5 to 12 digits, without the dots and dashes they are written with', () => {
    expect(normalizeRodonavesNumber(` ${DELIVERED_SAMPLE} `)).toBe(DELIVERED_SAMPLE);
    expect(normalizeRodonavesNumber('900.000.000-001')).toBe(ROAD);
    for (const other of ['', '1234', '1234567890123', 'AB110455', `${DELIVERED_SAMPLE};${BILLED_SAMPLE}`, '1'.repeat(41)]) {
      expect(() => normalizeRodonavesNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Rodonaves tracking adapter', () => {
  it('asks the road system first and Brudam next, as the tracking page does', async () => {
    const fetcher = lookups(noContent, () => json(DELIVERED));
    await expect(carrier(fetcher).track({ number: DELIVERED_SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered', service_name: 'Rodo Aéreo ECO' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${RODO_LOOKUP}?ProtocolNumber=${DELIVERED_SAMPLE}`, `${BRUDAM_LOOKUP}?codigo=${DELIVERED_SAMPLE}&prefixo=minuta`,
    ]);
    for (const [, init] of fetcher.mock.calls as [string, RequestInit][]) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(new Headers(init.headers).get('referer')).toBe('https://rodonaves.com.br/rastreio-de-mercadoria');
    }
    expect(carrier(fetcher)).toMatchObject({ id: 'rodonaves', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads a road protocol from the road system alone', async () => {
    const fetcher = lookups(() => json(ROAD_REPLY), () => json(NOT_FOUND));
    await expect(carrier(fetcher).track({ number: ROAD })).resolves.toMatchObject({ current_stage: 'out_for_delivery', service_name: 'Rodoviário' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads both systems’ answers that they hold nothing as not found, and a listed protocol without events as no history', async () => {
    await expect(carrier(lookups(noContent, () => json(NOT_FOUND))).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(lookups(() => json(''), () => json(NOT_FOUND))).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(lookups(() => json(JSON.stringify(road({ ProtocolNumber: OTHER, Events: [] }))), () => json(NOT_FOUND)))
      .track({ number: OTHER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
  });

  it('keeps a road failure, challenges and changed replies apart from a missing shipment', async () => {
    const answer = async (roadReply: () => Response, air: () => Response = () => json(NOT_FOUND)) => carrier(lookups(roadReply, air))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(noContent, () => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(noContent, () => json('{}', { status: 401 }))).toMatchObject({ kind: 'challenge' });
    // A road lookup that failed leaves the answer open even when Brudam holds nothing.
    for (const failed of [() => json('{"message":"error"}', { status: 500 }), () => html('<h1>Not Found</h1>', { status: 404 }),
      () => json('{"success":false}'), () => json('not json'), () => json('{"Events":"x"}')]) {
      expect(await answer(failed)).not.toMatchObject({ kind: 'not_found' });
    }
    expect(await answer(() => json('{"success":false}'))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    // Brudam's own refusals and an empty answer say nothing about the number either.
    expect(await answer(noContent, noContent)).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(noContent, () => json('{"success":false}'))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(noContent, () => json(NOT_FOUND.replace('Erro na consulta do documento.', 'Timeout')))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(noContent, () => json('{"message":"OK","status":1,"data":[]}'))).toMatchObject({ kind: 'schema' });
    expect(await answer(noContent, () => json('', { status: 502 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(noContent, () => html('', { status: 302, headers: { Location: 'https://rodonaves.com.br/' } }))).toMatchObject({ kind: 'transport' });
  });
});

describe('Rodonaves Brudam replies', () => {
  it('reads the delivered sample newest first, without billing records, tickets or repeats', () => {
    const result = parseBrudam(JSON.parse(DELIVERED), DELIVERED_SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'COMPROVANTE DE ENTREGA ANEXADO',
      last_update: null, last_update_local: '2023-08-04T15:05:03', expected_delivery: null, service_name: 'Rodo Aéreo ECO',
    });
    expect(result.events).toHaveLength(28);
    expect((result.events ?? []).some((event) => ['164', '166', '434'].includes(event.provider_code ?? ''))).toBe(false);
    expect(result.events).toContainEqual({ local_time: '2023-07-26T17:07:00', description: 'ENTREGA REALIZADA NORMALMENTE', provider_code: '1',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events).toContainEqual({ local_time: '2023-07-19T19:27:00', description: 'EMBARQUE NO VOO (GRU)', location: 'GRU',
      provider_code: '140', stage: 'in_transit', stage_source: 'carrier_map' });
    expect((result.events ?? []).filter((event) => event.description === 'EMBARQUE NO VOO (GRU)')).toHaveLength(2);
    expect(result.events?.at(-1)).toEqual({ local_time: '2023-07-18T17:53:40', description: 'EMISSAO REALIZADA', provider_code: '100',
      stage: 'accepted', stage_source: 'carrier_map' });
  });

  it('reads the billed sample, whose record is mostly billing entries and tickets', () => {
    const result = parseBrudam(JSON.parse(BILLED), BILLED_SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', expected_delivery: null, service_name: 'Rodo Aéreo ECO' });
    expect(result.events).toHaveLength(26);
    expect(result.events).toContainEqual(expect.objectContaining({ description: 'ENTREGA REALIZADA NORMALMENTE', local_time: '2024-07-25T16:00:00' }));
    expect(result.events).toContainEqual(expect.objectContaining({ description: 'DESEMBARQUE (SSA)', location: 'SSA', provider_code: '160', stage: 'in_transit' }));
  });

  it('gives the estimate until delivery, names the other services Rodo Aéreo and never reads the names', () => {
    const moving = parseBrudam(brudam({ dados: [occurrence({ razao_remetente: 'SECRET SENDER', razao_destinatario: 'SECRET RECIPIENT' })] }), DELIVERED_SAMPLE);
    expect(moving).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'EMBARQUE NO VOO (GRU)',
      last_update: null, last_update_local: '2031-03-04T10:00:00', expected_delivery: '2031-03-06', service_name: 'Rodo Aéreo ECO',
      events: [{ local_time: '2031-03-04T10:00:00', description: 'EMBARQUE NO VOO (GRU)', location: 'GRU', provider_code: '140', stage: 'in_transit',
        stage_source: 'carrier_map' }],
    });
    expect(JSON.stringify(moving)).not.toContain('SECRET');
    expect(parseBrudam(brudam({ dados: [occurrence({ servico: 'EXPRESSO' })] }), DELIVERED_SAMPLE).service_name).toBe('Rodo Aéreo');
    // An occurrence the map does not know stays visible, and the newest staged one leads under it.
    const unknown = parseBrudam(brudam({ dados: [occurrence({ status: 999, descricao: 'NOVA OCORRENCIA', data: '2031-03-05 08:00:00' }), occurrence()] }), DELIVERED_SAMPLE);
    expect(unknown.events?.[0]).toEqual({ local_time: '2031-03-05T08:00:00', description: 'NOVA OCORRENCIA', provider_code: '999' });
    expect(() => parseBrudam(brudam({ dados: [occurrence({ status: 164, descricao: 'EMISSAO DE CONTRA-FATURA' })] }), DELIVERED_SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('reads Brudam’s not-found answer, and refuses an answer for another minuta', () => {
    expect(() => parseBrudam(JSON.parse(NOT_FOUND), OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBrudam(JSON.parse(DELIVERED), BILLED_SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, [], 'x', {}, { status: 1, data: {} }, { status: 1, data: [brudam({}).data[0], brudam({}).data[0]] },
      brudam({ status: 2 }), brudam({ dados: null }), brudam({ dados: [null] }), brudam({ dados: [occurrence({ descricao: '' })] }),
      brudam({ dados: [occurrence({ status: 'x' })] }), brudam({ dados: [occurrence({ data: '04/03/2031 10:00' })] }),
      brudam({ dados: [occurrence({ data: '2031-02-30 10:00:00' })] }), brudam({ dados: [occurrence({ servico: 7 })] }),
      brudam({ dados: Array.from({ length: 501 }, () => occurrence()) })]) {
      expect(() => parseBrudam(changed, DELIVERED_SAMPLE), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Rodonaves road replies', () => {
  it('reads the road events newest first, staged as the tracking page groups them, with its estimate', () => {
    expect(parseRodo(JSON.parse(ROAD_REPLY), ROAD)).toEqual({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map', last_status_text: 'MERCADORIA EM ROTA DE ENTREGA',
      last_update: null, last_update_local: '2031-03-05T07:45:00', expected_delivery: '2031-03-06', service_name: 'Rodoviário',
      events: [
        { local_time: '2031-03-05T07:45:00', description: 'MERCADORIA EM ROTA DE ENTREGA', provider_code: 'H6', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2031-03-04T02:30:00', description: 'MERCADORIA EM VIAGEM PARA A UNIDADE DE DESTINO', provider_code: 'H1', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { local_time: '2031-03-03T10:10:00', description: 'MERCADORIA COLETADA', provider_code: 'E503', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2031-03-03T09:00:00', description: 'COLETA AGENDADA', provider_code: 'E501', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(JSON.stringify(parseRodo(JSON.parse(ROAD_REPLY), ROAD))).not.toContain('SYNTHETIC');
  });

  it('reads the collection codes the page reads from Proceda codes, a later rescheduled date and a delivery', () => {
    const events = [{ Date: '2031-03-03T09:00:00', Description: 'AGENDADA', EventCode: '0', ProcedaCode: '00', HistoricId: 0 },
      { Date: '2031-03-03T10:00:00', Description: 'COLETADA', EventCode: 0, ProcedaCode: '1', HistoricId: 0 },
      { Date: '2031-03-03T11:00:00', Description: 'EM ROTA', EventCode: '0', ProcedaCode: '0', HistoricId: 2 }];
    expect(parseRodo(road({ Events: events, NewDateSchedule: '2031-03-10T00:00:00' }), ROAD)).toMatchObject({
      current_stage: 'accepted', last_status_text: 'EM ROTA', expected_delivery: '2031-03-10',
      events: [{ provider_code: 'E0' }, { provider_code: 'E503' }, { provider_code: 'E501', stage: 'registered' }],
    });
    const delivered = parseRodo(road({ Events: [...events, { Date: '2031-03-05T15:00:00', Description: 'ENTREGUE', EventCode: '1', ProcedaCode: '1', HistoricId: 13 }] }), ROAD);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'ENTREGUE', expected_delivery: null });
  });

  it('refuses an answer for another protocol, and reads one without events as no history', () => {
    expect(() => parseRodo(JSON.parse(ROAD_REPLY), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseRodo(road({ ProtocolNumber: `000${ROAD}` }), ROAD)).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(() => parseRodo(road({ Events: [] }), ROAD)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, [], road({ Events: {} }), road({ Events: [null] }), road({ Events: [{ Date: '2031-03-03T09:00:00', HistoricId: 1 }] }),
      road({ Events: [{ Date: '03/03/2031', Description: 'X', HistoricId: 1 }] }), road({ Events: [{ Date: '2031-03-03T09:00:00', Description: 'X', HistoricId: 'a' }] }),
      road({ Events: [{ Date: '2031-03-03T09:00:00', Description: 7, HistoricId: 1 }] })]) {
      expect(() => parseRodo(changed, ROAD), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Rodonaves statuses', () => {
  it('maps every code of both systems, and leaves the records that move nothing open with their reason', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()) ?? null, `${entry.code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'rodonaves', providerCode: entry.code, description: entry.wording }))
        .toMatchObject(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap' });
    }
    expect(statusMap.stage('998', 'delivered')).toBeUndefined();
    expect(statusMap.stage(null, 'ENTREGA REALIZADA NORMALMENTE')).toBeUndefined();
  });
});
