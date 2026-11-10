import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { CARRIERS } from '../../core/catalog/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { isNetworkFailure } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ROZETKA_API, RozetkaDeliveryTracker, rozetkaResultUrl } from './adapter.js';
import { parseRozetkaHistory, parseRozetkaSummary, rozetkaRequestNumber } from './parser.js';
import { rozetkaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'RMP-000000017';
const WAYBILL = '101000000017';
const OTHER = 'RMP-000000018';
const overview = (number = NUMBER, code = 60030, date = '2026-02-12 14:10:00') => ({ statusCode: 0, data: {
  id: number, last_status: code, last_status_name: 'Видано', last_status_date: date,
  delivery_date: '2026-02-12 10:00:00',
  final_department: { id: 'synthetic-department', public_name: 'м. Тестове, Відділення 17' },
  recipient_name: 'SYNTHETIC RECIPIENT', phone: 'SYNTHETIC PHONE',
} });
const scan = (id: number, name: string, date: string) => ({ id, name, date, location: { department_id: 'synthetic-site', name: 'м. Тестове, Склад' } });
const history = (number = NUMBER) => ({ statusCode: 0, data: [{ track_id: number, is_main_flow: true,
  status_groups: [
    { id: 100, name: 'Заплановано до відправки', statuses: [scan(10010, 'Заплановано', '2026-02-10 08:01:00')] },
    { id: 300, name: 'В дорозі', statuses: [scan(20020, 'Посилка отримана на РЦ', '2026-02-11 09:02:00')] },
    { id: 500, name: 'У відділенні доставки', statuses: [scan(40040, 'Готово до видачі', '2026-02-12 09:04:00')] },
    { id: 1200, name: 'Видано', statuses: [scan(60030, 'Видано', '2026-02-12 14:12:00')] },
  ],
  planning_route: [{ name: 'SYNTHETIC FUTURE ROUTE', date: '2026-02-13 10:00:00' }],
  last_status: { id: 60030, name: 'Видано', date: '2026-02-12 14:10:00' },
}] });
const parse = (data = history(), summary = overview()) => parseRozetkaHistory(data, parseRozetkaSummary(summary, summary.data.id));
const reply = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });
const pair = () => vi.fn<typeof fetch>().mockResolvedValueOnce(reply(overview())).mockResolvedValueOnce(reply(history()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ROZETKA Delivery parser', () => {
  it('restores the API dash without changing the whole identifier or accepting unrelated prefixes', () => {
    expect(rozetkaRequestNumber(' rmp 000 000 017 ')).toBe(NUMBER);
    expect(rozetkaRequestNumber(NUMBER)).toBe(NUMBER);
    expect(rozetkaRequestNumber(WAYBILL)).toBe(WAYBILL);
    expect(rozetkaResultUrl('RMP000000017')).toBe(`https://rozetka.delivery/tracking/parcel?parcel_id=${NUMBER}`);
    for (const input of ['RMP00000001', 'RMP0000000170', 'ABC000000017', `${NUMBER}${OTHER}`, '1'.repeat(100)]) {
      expect(() => rozetkaRequestNumber(input)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps actual scans newest first and preserves their offset-less wall clocks', () => {
    const result = parse();
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      provider_code: '60030', last_update: null, last_update_local: '2026-02-12T14:12:00', expected_delivery: null,
      pickup_point: 'м. Тестове, Відділення 17', timezone: 'Europe/Kyiv' });
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-02-12T14:12:00', '60030', 'delivered'], ['2026-02-12T09:04:00', '40040', 'ready_for_pickup'],
      ['2026-02-11T09:02:00', '20020', 'in_transit'], ['2026-02-10T08:01:00', '10010', 'registered'],
    ]);
    expect(result.events!.every(event => !event.time)).toBe(true);
    expect(result.summary_only).toBeUndefined();
    expect(result.history_truncated).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|synthetic-site|synthetic-department|recipient_name|phone|planning_route/);
  });

  it('binds both replies to the complete identifier, without accepting a partial or hidden second number', () => {
    for (const id of [OTHER, 'RMP-00000001', `${NUMBER}${' '.repeat(500)}${OTHER}`]) {
      const changed = overview(); changed.data.id = id;
      expect(() => parseRozetkaSummary(changed, NUMBER)).toThrow(expect.objectContaining({ kind: expect.stringMatching(/schema|indeterminate/) }));
      const wrong = history(); wrong.data[0]!.track_id = id;
      expect(() => parse(wrong)).toThrow(expect.objectContaining({ kind: expect.stringMatching(/schema|indeterminate/) }));
    }
    expect(parse(history(WAYBILL), overview(WAYBILL))).toMatchObject({ current_stage: 'delivered' });
    const mixed = history(); mixed.data.push(history(OTHER).data[0]!);
    expect(() => parse(mixed)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('ignores planned routes and unreached rail groups, including dated future entries', () => {
    const changed = history();
    changed.data[0]!.status_groups.push({ id: 1300, name: 'Повернуто', future: true,
      statuses: [scan(60040, 'Повернено', '2026-02-14 15:00:00')] } as typeof changed.data[0]['status_groups'][number]);
    expect(parse(changed).events).toHaveLength(4);
    expect(parse(changed).current_stage).toBe('delivered');
  });

  it('uses a later reached current state and does not turn cancellation or returns into delivery', () => {
    const cancelled = overview(NUMBER, 60010, '2026-02-13 12:00:00');
    cancelled.data.last_status_name = 'Видалено';
    expect(parse(history(), cancelled)).toMatchObject({ status: 'exception', current_stage: 'exception', provider_code: '60010',
      last_update_local: '2026-02-13T12:00:00', expected_delivery: null });
    expect(parse(history(), cancelled).pickup_point).toBeUndefined();
    for (const [code, stage] of [[40060, 'exception'], [50010, 'exception'], [50015, 'exception'], [50021, 'exception'],
      [50030, 'returned'], [50020, 'returned'], [60040, 'returned']] as const) {
      const returned = overview(NUMBER, code, '2026-02-13 12:00:00'); returned.data.last_status_name = 'Повернення';
      const result = parse(history(), returned);
      expect(result).toMatchObject({ status: 'exception', current_stage: stage, provider_code: String(code), expected_delivery: null });
      expect(result.pickup_point).toBeUndefined();
    }
  });

  it('keeps partial receipt and unfamiliar codes visible without declaring final delivery', () => {
    for (const code of [60025, 99999]) {
      const partial = overview(NUMBER, code, '2026-02-13 12:00:00'); partial.data.last_status_name = 'Частково отримано';
      const result = parse(history(), partial);
      expect(result).toMatchObject({ status: 'unknown', provider_code: String(code), last_status_text: 'Частково отримано' });
      expect(result.current_stage).toBeUndefined();
      expect(result.delivered_at).toBeUndefined();
    }
    for (const entry of statuses.entries) {
      if ('stage' in entry) expect(rozetkaStage(entry.code)).toBe(entry.stage);
    }
    expect(statusMap.gaps).toContainEqual(expect.objectContaining({ code: '60025' }));
    expect(statusMap.stage('60025', 'Частково отримано')).toBeUndefined();
    const tied = overview(NUMBER, 60025, '2026-02-12 14:12:00'); tied.data.last_status_name = 'Частково отримано';
    expect(parse(history(), tied)).toMatchObject({ status: 'unknown', provider_code: '60025', expected_delivery: null, history_truncated: true });
  });

  it('keeps an explicit upstream offset and rejects impossible local and explicit clocks', () => {
    const changed = history(); changed.data[0]!.status_groups[3]!.statuses[0]!.date = '2026-02-12T14:12:00+02:00';
    expect(parse(changed)).toMatchObject({ last_update: '2026-02-12T14:12:00+02:00', delivered_at: '2026-02-12T14:12:00+02:00',
      events: [expect.objectContaining({ time: '2026-02-12T14:12:00+02:00' }), expect.anything(), expect.anything(), expect.anything()] });
    for (const date of ['2026-02-30 12:00:00', '2026-02-12 24:00:00', '2026-02-12T24:00:00+02:00', '2026-02-12T12:00:00+99:00', '']) {
      const invalid = history(); invalid.data[0]!.status_groups[0]!.statuses[0]!.date = date;
      expect(() => parse(invalid)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('marks a dated summary without scans and marks a bounded history as truncated', () => {
    const summary = history(); summary.data[0]!.status_groups = [];
    expect(parse(summary)).toMatchObject({ summary_only: true, events: [], current_stage: 'delivered', last_update_local: '2026-02-12T14:10:00' });
    const bounded = history(); bounded.data[0]!.status_groups = [{ id: 300, name: 'В дорозі', statuses: Array.from({ length: 101 }, (_, index) =>
      scan(20010, `Синтетичний рух ${index}`, `2026-02-11 09:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`)) }];
    expect(parse(bounded)).toMatchObject({ history_truncated: true });
    expect(parse(bounded).events).toHaveLength(100);
    expect(() => parseRozetkaHistory({ statusCode: 0, data: [] }, parseRozetkaSummary(overview(), NUMBER)))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseRozetkaSummary({ statusCode: 0, data: null }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('marks a history missing its current state as truncated without inventing a current scan', () => {
    const missing = history();
    missing.data[0]!.status_groups = [missing.data[0]!.status_groups[2]!];
    const result = parse(missing);
    expect(result).toMatchObject({ current_stage: 'delivered', provider_code: '60030', last_update_local: '2026-02-12T14:10:00',
      history_truncated: true, events: [expect.objectContaining({ provider_code: '40040', stage: 'ready_for_pickup' })] });
    expect(result.summary_only).toBeUndefined();
    expect(result.events).toHaveLength(1);
    expect(result.events!.some(event => event.stage === 'delivered')).toBe(false);

    const stale = history();
    stale.data[0]!.status_groups[3]!.statuses[0]!.date = '2026-02-12 14:08:00';
    expect(parse(stale)).toMatchObject({ history_truncated: true, last_update_local: '2026-02-12T14:10:00' });
  });

  it('accepts slight same-code clock skew between the overview and its actual scan', () => {
    const cancelled = overview(NUMBER, 60010); cancelled.data.last_status_name = 'Видалено';
    const rows = history();
    rows.data[0]!.last_status = { id: 60010, name: 'Скасовано', date: '2026-02-12 14:10:00' };
    rows.data[0]!.status_groups = [{ id: 400, name: 'Видалено', statuses: [scan(60010, 'Скасовано', '2026-02-12 14:09:57')] }];
    const result = parse(rows, cancelled);
    expect(result).toMatchObject({ current_stage: 'exception', provider_code: '60010', last_update_local: '2026-02-12T14:10:00' });
    expect(result.history_truncated).toBeUndefined();
    expect(result.events).toHaveLength(1);
    expect(result.events![0]!.local_time).toBe('2026-02-12T14:09:57');
  });
});

describe('ROZETKA Delivery HTTP retrieval', () => {
  it('offers HTTP recognition only for its existing RMP candidates', () => {
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).toContain('rozetka-delivery');
    expect(recognitionCandidates(WAYBILL).map(candidate => candidate.carrier)).not.toContain('rozetka-delivery');
    expect(CARRIERS['rozetka-delivery'].trackingUrl?.(NUMBER)).toBe(rozetkaResultUrl(NUMBER));
  });

  it('confirms a recent synthetic shipment in preflight and routes automatic tracking to the generated native adapter', async () => {
    const day = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
    const current = overview(); current.data.last_status_date = `${day} 14:10:00`;
    const rows = history();
    rows.data[0]!.last_status.date = `${day} 14:10:00`;
    for (const group of rows.data[0]!.status_groups) for (const event of group.statuses) event.date = `${day}${event.date.slice(10)}`;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      const address = String(url);
      if (!address.startsWith(ROZETKA_API)) throw new Error('Synthetic unconfigured carrier');
      return reply(address.includes('/public/') ? current : rows);
    });
    const tracker = createTracker({ fetcher, providers: [] });
    const recognized = await tracker.recognize(NUMBER, { budgetMs: 1_000 });
    expect(recognized).toMatchObject({ carrier: 'rozetka-delivery', choices: [] });
    expect(recognized.asked).toContain('rozetka-delivery');
    const result = await tracker.track({ number: 'rmp 000 000 017' }, { budgetMs: 1_000 });
    expect(result).toMatchObject({ carrier: 'rozetka-delivery', source: 'rozetka-delivery',
      attempts: [{ source: 'rozetka-delivery', kind: 'ok' }], result: { current_stage: 'delivered' } });
    expect(result.result.events).toHaveLength(4);
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(ROZETKA_API))).toHaveLength(6);
  });

  it('routes an explicitly selected carrier through its native adapter with providers disabled', async () => {
    const fetcher = pair();
    const registry = new AdapterRegistry({ factories: { 'rozetka-delivery': adapter }, carriers: { 'rozetka-delivery': 'rozetka-delivery' } },
      { fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    const result = await createTracker({ registry, providers: [] }).track({ number: 'rmp 000 000 017', carrier: 'rozetka-delivery' });
    expect(result).toMatchObject({ carrier: 'rozetka-delivery', source: 'rozetka-delivery',
      attempts: [{ source: 'rozetka-delivery', kind: 'ok' }], result: { current_stage: 'delivered' } });
    expect(result.result.events).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(detectCarrierMatch(NUMBER).candidates).toContain('rozetka-delivery');
    expect(detectCarrierMatch(WAYBILL).candidates).not.toContain('rozetka-delivery');
  });

  it('enriches a history missing its verified current scan from an enabled fuller provider', async () => {
    const missing = history(); missing.data[0]!.status_groups = [missing.data[0]!.status_groups[2]!];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      const address = String(url);
      if (address.startsWith(ROZETKA_API)) return reply(address.includes('/public/') ? overview() : missing);
      if (address.includes('ship24')) return reply({ data: { tracking_number: NUMBER.replace('-', ''), events: [
        { timestamp: '2026-02-12T14:12:00+02:00', status: 'Delivered' },
        { timestamp: '2026-02-12T09:04:00+02:00', status: 'Ready for pickup' },
        { timestamp: '2026-02-11T09:02:00+02:00', status: 'In transit' },
      ] } }, 201);
      throw new Error('Synthetic unconfigured provider');
    });
    const answer = await createTracker({ fetcher, providers: ['Ship24'] }).track({ number: NUMBER, carrier: 'rozetka-delivery' });
    expect(answer).toMatchObject({ carrier: 'rozetka-delivery', source: 'Ship24',
      attempts: [{ source: 'rozetka-delivery', kind: 'ok' }, { source: 'Ship24', kind: 'ok' }],
      direct: { history_truncated: true, current_stage: 'delivered', provider_code: '60030' },
      result: { current_stage: 'delivered', pickup_point: 'м. Тестове, Відділення 17' } });
    expect(answer.direct!.events).toHaveLength(1);
    expect(answer.direct!.events[0]!.stage).toBe('ready_for_pickup');
    expect(answer.result.events).toHaveLength(3);
    expect(answer.result.history_truncated).toBeUndefined();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('ship24'))).toBe(true);
  });

  it('uses the supplied transport, user agent, signal and two-read budget and records success', async () => {
    const fetcher = pair();
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    await expect(new RozetkaDeliveryTracker({ fetcher, userAgent: 'SyntheticHost/1.0', recorder }).fetch('RMP000000017', { budgetMs: 1_000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${ROZETKA_API}track/public/${NUMBER}`, `${ROZETKA_API}track/status-group?id=${NUMBER}&sort=asc`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
      expect(new Headers(init!.headers).has('cookie')).toBe(false);
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('retries only a network failure and removes unsafe causes before recording recovery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('SYNTHETIC PRIVATE TOKEN https://private.invalid/secret'))
      .mockResolvedValueOnce(reply(overview())).mockResolvedValueOnce(reply(history()));
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    await expect(new RozetkaDeliveryTracker({ fetcher, recorder }).fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const first = recorder.step.mock.calls[0]![0];
    const next = recorder.step.mock.calls[1]![0];
    expect(isNetworkFailure(first.error)).toBe(true);
    expect(first.error.cause).toBeUndefined();
    expect(first.error.request).toBeUndefined();
    expect(next).toMatchObject({ step: 'retry', fallbackFrom: 'direct', fallbackReason: 'transport', outcome: 'ok' });
    expect(next.fallbackError).toBe(first.error);
    expect(JSON.stringify(recorder.step.mock.calls)).not.toMatch(/PRIVATE|private\.invalid|secret|headers|request|body_excerpt/);
  });

  it('reserves shared budget for the second request and a retry after a hanging request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    })).mockResolvedValueOnce(reply(overview())).mockResolvedValueOnce(reply(history()));
    await expect(new RozetkaDeliveryTracker({ fetcher }).fetch(NUMBER, { budgetMs: 120 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('recognizes positive whole identities and accepts only the explicit overview negative', async () => {
    await expect(carrier(pair()).recognize!(NUMBER)).resolves.toMatchObject({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-12T14:12:00' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ statusCode: 404, error: 'Not Found', message: 'Експрес-накладна не знайдена' }, 404));
    await expect(carrier(fetcher).recognize!(NUMBER)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(carrier(fetcher).recognize!('ABC000000017')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not turn empty, expired, generic missing, blocked or malformed replies into not found', async () => {
    const cases: [Response, string][] = [
      [reply('', 200), 'indeterminate'], [new Response(null, { status: 204 }), 'indeterminate'],
      [reply({ statusCode: 404, message: 'Cannot GET /synthetic' }, 404), 'indeterminate'],
      [reply('expired', 410), 'indeterminate'], [reply('<html><title>Just a moment</title>captcha</html>'), 'challenge'],
      [reply('{"SYNTHETIC PRIVATE":"broken'), 'schema'], [reply({ statusCode: 500, message: 'SYNTHETIC PRIVATE' }), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(new RozetkaDeliveryTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const goneHistory = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(overview())).mockResolvedValueOnce(reply({
      statusCode: 404, error: 'Not Found', message: `Експрес-накладні не знайдені: ${NUMBER}`,
    }, 404));
    await expect(carrier(goneHistory).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps HTTP failure kind, status and retry window while removing all unsafe diagnostic fields', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('<html>SYNTHETIC PRIVATE RESPONSE</html>', status, {
        'Set-Cookie': 'SYNTHETIC PRIVATE COOKIE', 'Retry-After': '7', 'X-Private': 'SYNTHETIC PRIVATE HEADER',
      }));
      const recorder = { step: vi.fn(), lookup: vi.fn() };
      await expect(new RozetkaDeliveryTracker({ fetcher, recorder }).fetch(NUMBER))
        .rejects.toMatchObject({ kind, status, retryAfterMs: 7_000 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      for (const call of [...recorder.step.mock.calls, ...recorder.lookup.mock.calls]) {
        const error = call[0].error;
        expect(error.message).not.toContain('PRIVATE');
        for (const field of ['cause', 'request', 'diagnostics', 'headers', 'url', 'body', 'response_body']) expect(error[field]).toBeUndefined();
      }
      expect(JSON.stringify([recorder.step.mock.calls, recorder.lookup.mock.calls])).not.toMatch(/PRIVATE|Set-Cookie|X-Private|body_excerpt|response_url/);
    }
  });

  it('rejects invalid inputs and a pre-aborted lookup before sending or recording a request', async () => {
    const fetcher = pair(); const recorder = { step: vi.fn(), lookup: vi.fn() };
    const tracker = new RozetkaDeliveryTracker({ fetcher, recorder });
    await expect(tracker.fetch('invalid')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController(); const reason = new Error('SYNTHETIC PRIVATE CANCEL'); controller.abort(reason);
    await expect(tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
    expect(recorder.step).not.toHaveBeenCalled();
    expect(recorder.lookup).not.toHaveBeenCalled();
  });
});
