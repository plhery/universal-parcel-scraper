import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { adapter, EtsExpressTracker } from './adapter.js';
import { ETS_ORIGIN, normalizeEtsNumber, parseEtsAbsencePage, parseEtsTrack } from './parser.js';
import { etsStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'RETS004827610539UES';
const READ_AT = Date.parse('2026-02-20T12:00:00Z');
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/track.json', import.meta.url), 'utf8')) as [{ ack: string; data: Record<string, unknown>[] }];
const unknownPage = () => readFileSync(new URL('./fixtures/page-unknown.html', import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const noTrack = () => [{ ack: 'false', message: '未查询到轨迹' }];
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ETS Express native tracking', () => {
  it('routes recent bound histories automatically and leaves aged recognition unsettled', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(READ_AT);
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        expect(new URL(String(url)).origin).toBe(ETS_ORIGIN);
        return json(fixture());
      });
      const tracker = createTracker({ fetcher, providers: [], env: {}, trawlUrl: '', chromiumPath: '' });
      const answer = await tracker.track({ number: NUMBER });
      expect(answer).toMatchObject({ carrier: 'ets-express', source: 'ets-express', result: { current_stage: 'delivered' } });
      expect(answer.result.events).toHaveLength(8);
      expect(answer.result.events[0]).toMatchObject({ local_time: '2026-02-18T18:34:29' });
      expect(fetcher).toHaveBeenCalledTimes(2);
      vi.setSystemTime(new Date('2027-02-20T12:00:00Z'));
      await expect(tracker.track({ number: NUMBER })).rejects.toMatchObject({ hint: { kind: 'indeterminate' } });
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('does not retain malformed reply text in error causes or telemetry', async () => {
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html('SYNTHETIC PRIVATE REPLY'));
    let failure: unknown;
    try { await new EtsExpressTracker({ fetcher, recorder }).fetch(NUMBER); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: 'schema' });
    expect(failure).not.toHaveProperty('cause');
    for (const [record] of [...recorder.step.mock.calls, ...recorder.lookup.mock.calls]) {
      expect(record.error).toMatchObject({ kind: 'schema' });
      expect(record.error).not.toHaveProperty('cause');
      expect(String(record.error)).not.toContain('SYNTHETIC PRIVATE');
    }
  });

  it('does not state an older delivery through a newer unmapped scan', () => {
    const payload = fixture(), rows = payload[0].data[0]!.trackDetails as Record<string, unknown>[];
    rows.unshift({ track_date: '2026-02-19 12:00:00', track_createdate: '2026-02-19 12:01:00',
      track_content: 'Synthetic carrier amendment', track_location: '', track_kind: 'SYNTHETIC_AMENDMENT' });
    const result = parseEtsTrack(payload, NUMBER, READ_AT)!;
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic carrier amendment', last_update_local: '2026-02-19T12:00:00' });
    expect(result).not.toHaveProperty('current_stage');
    expect(resolveResult(result).current_stage).not.toBe('delivered');
    expect(result.events?.[1]).toMatchObject({ stage: 'delivered' });
  });

  it('keeps contradictory or truncated-identity empty pages inconclusive', () => {
    for (const page of [unknownPage().replace('<li>/</li>', '<li>Shipment is handed over to the customer</li>'),
      unknownPage().replace(`<li>${NUMBER}</li>`, `<li>${NUMBER}${'-'.repeat(600)}RETS004827610538UES</li>`),
      unknownPage().replace('<li>/</li><li></li>', '<li>/</li><li>Synthetic recipient</li>'),
      unknownPage().replace('<li></li></ul></div>', '<li>1.2</li></ul></div>')]) {
      expect(() => parseEtsAbsencePage(page, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('uses one whole-number HTTP request, the supplied user agent and its recorded direct step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const instance = new EtsExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' });
    await expect(instance.fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${ETS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', Accept: expect.stringContaining('application/json') } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ets-express', step: 'direct', outcome: 'ok' }));
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'ets-express', recordsSteps: true, steps: ['direct'] });
    expect(carrier.tracking).toMatchObject({ adapter: 'ets-express', steps: ['direct'], localClocks: true });
  });

  it('keeps local scan clocks, milestones and customs-script provenance without claiming Ozon references', () => {
    const result = parseEtsTrack(fixture(), NUMBER, READ_AT)!;
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Shipment is handed over to the customer', last_update: null,
      last_update_local: '2026-02-18T18:34:29', destination_country: 'RU', service_name: 'RETS EXtra small Standard',
      written_ahead: ['2026-02-08T13:25:16', '2026-02-08T05:25:16'] });
    expect(result.events).toHaveLength(8);
    expect(result.events!.map((event) => event.stage)).toEqual([
      'delivered', 'ready_for_pickup', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered', 'registered',
    ]);
    expect(result.events!.every((event) => event.local_time && !event.time && !event.written_at)).toBe(true);
    expect(result.events![4]).toMatchObject({ location: '示例市', provider_code: 'SHIPMENT' });
    for (const field of ['canonical_tracking_number', 'delivery_tracking_number', 'delivery_carrier', 'receiver_name']) {
      expect(result).not.toHaveProperty(field);
    }
    expect(JSON.stringify(result)).not.toContain('Synthetic private address');
  });

  it('requires the whole returned invoice or tracking number, without truncated-prefix matches', () => {
    for (const returned of ['RETS004827610538UES', `${NUMBER}${'0'.repeat(80)}`]) {
      const payload = fixture();
      payload[0].data[0]!.business_seqinvoicecode = returned;
      payload[0].data[0]!.referenceNumber = NUMBER;
      expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const payload = fixture();
    payload[0].data[0]!.trackingNumber = NUMBER;
    payload[0].data[0]!.business_seqinvoicecode = '';
    expect(parseEtsTrack(payload, NUMBER, READ_AT)?.events).toHaveLength(8);
  });

  it('requires a RETS product and one unambiguous matching record', () => {
    for (const product of ['', 'Other network', 'RETSOTHER']) {
      const payload = fixture();
      payload[0].data[0]!.productKindName = product;
      expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    const payload = fixture();
    payload[0].data.push(structuredClone(payload[0].data[0]!));
    expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects malformed identity and record/history schema', () => {
    for (const [key, value] of [['business_seqinvoicecode', {}], ['trackingNumber', []], ['productKindName', {}], ['trackDetails', {}]] as const) {
      const payload = fixture();
      payload[0].data[0]![key] = value;
      expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const payload of [[], [{ ack: 'true', data: [] }], [{ ack: 'true', data: [null] }], [{ data: fixture()[0].data }]]) {
      expect(() => parseEtsTrack(payload, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('settles only the explicit empty-waybill signature as absence and sends the exact form body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(noTrack())).mockResolvedValueOnce(html(unknownPage()));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${ETS_ORIGIN}/trackIndex.htm`);
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe(`documentCode=${NUMBER}`);
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });
    expect(parseEtsTrack(noTrack(), NUMBER, READ_AT)).toBeNull();
    expect(() => parseEtsAbsencePage(unknownPage().replaceAll(NUMBER, 'RETS004827610538UES'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEtsAbsencePage('<html>No data</html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEtsTrack([{ ack: 'false', message: 'temporary failure' }], NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEtsTrack([{ ack: 'false', message: '未查询到轨迹', data: [] }], NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not accept a positive page whose matching query is only echoed', () => {
    const page = unknownPage().replace('件数:【】', '件数:【1】')
      .replace('<li>RETS004827610539UES</li>', '<li>73492816-0265-2</li>')
      .replace('</div></div>', '<div class="difmeam"><table><tr><td>2026-02-04 07:12:15</td><td></td><td>Shipment registered</td></tr></table></div></div></div>');
    expect(() => parseEtsAbsencePage(page, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('recognizes only existing RETS candidates, with local activity and explicit absence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture())).mockResolvedValueOnce(json(noTrack())).mockResolvedValueOnce(html(unknownPage()));
    const instance = adapter(environment(fetcher));
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-02-18T18:34:29' });
    await expect(instance.recognize!(NUMBER)).resolves.toEqual({ known: false });
    for (const foreign of ['73492816-0265-2', '7349281602652', 'OTHER004827610539UES']) {
      await expect(instance.recognize!(foreign)).resolves.toEqual({ known: false });
      await expect(instance.track({ number: foreign })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(normalizeEtsNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
  });

  it.each([
    { status: 403, body: 'Forbidden', kind: 'challenge' },
    { status: 429, body: 'Throttle', kind: 'rate_limited' },
    { status: 200, body: '<html><title>安全验证</title></html>', kind: 'challenge' },
    { status: 200, body: '<html><title>CAPTCHA</title></html>', kind: 'challenge' },
    { status: 200, body: '<html>Unexpected reply</html>', kind: 'schema' },
    { status: 404, body: 'No route', kind: 'transport' },
    { status: 302, body: '', kind: 'transport' },
  ])('ends a $kind response without further requests ($status)', async ({ status, body, kind }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status, headers: { 'Retry-After': '30' } }));
    await expect(adapter(environment(fetcher)).track({ number: NUMBER })).rejects.toMatchObject({ kind,
      ...(status === 429 ? { retryAfterMs: 30_000 } : {}) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps provider-declared throttles and verification errors separate from absence', () => {
    expect(() => parseEtsTrack([{ ack: 'false', message: '查询过于频繁' }], NUMBER)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseEtsTrack([{ ack: 'false', message: '请完成验证码' }], NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('stops on a challenge in the absence page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(noTrack())).mockResolvedValueOnce(html('<html><title>CAPTCHA</title></html>'));
    await expect(adapter(environment(fetcher)).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('passes caller cancellation and starts nothing when already cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = new EtsExpressTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal, budgetMs: 1000 });
    controller.abort(new Error('Synthetic cancellation'));
    await expect(pending).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await expect(new EtsExpressTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Synthetic cancellation');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares the remaining budget across the JSON and absence page', async () => {
    let pageSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return json(noTrack());
    }).mockImplementationOnce((_url, init) => {
      pageSignal = init!.signal;
      return new Promise((_resolve, reject) => {
        pageSignal!.addEventListener('abort', () => reject(pageSignal!.reason), { once: true });
      });
    });
    await expect(new EtsExpressTracker({ fetcher }).fetch(NUMBER, { budgetMs: 60 })).rejects.toMatchObject({ kind: 'transport' });
    expect(pageSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains a capped history flag instead of silently claiming completeness', () => {
    const payload = fixture();
    payload[0].data[0]!.trackDetails = Array.from({ length: 101 }, (_, index) => ({
      track_date: `2026-01-01 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`,
      track_content: `Synthetic scan ${index}`, track_location: '', track_kind: '',
    }));
    expect(parseEtsTrack(payload, NUMBER, READ_AT)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseEtsTrack(payload, NUMBER, READ_AT)?.events).toHaveLength(100);
  });

  it('maps the observed whole wordings and preserves unknown kind meanings', () => {
    for (const entry of statuses.entries) {
      expect(etsStage(entry.code ?? null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(etsStage('ARRIVAL', normalizeStatusWording('Synthetic unrelated arrival'))).toBeUndefined();
    expect(statusMap.gaps).toContainEqual(expect.objectContaining({ code: 'CO_C_CR' }));
  });
});
