import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, RincosTracker, RINCOS_TRACKING_PAGE } from './adapter.js';
import { normalizeRincosNumber, parseRincos, RINCOS_MAX_BYTES } from './parser.js';
import { rincosStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '82100000000017', OTHER = '82100000000024';
const fixture = () => readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const edit = (change: (page: ReturnType<typeof load>) => void) => { const page = load(fixture()); change(page); return page.html(); };
const setDetail = (page: ReturnType<typeof load>, name: string, value: string) => {
  page('table.type_detail th').filter((_, node) => page(node).text() === name).next('td').text(value);
};
const emptyHistory = (page: ReturnType<typeof load>) => { page('table.type_list tbody, table.type_list1 tbody').empty(); };
const absent = () => edit(page => {
  emptyHistory(page); setDetail(page, 'Rincos Tracking No.', ''); setDetail(page, 'STATUS', '');
  page('.Tracking_tit2').text(`해당 번호의 정보가 없습니다. [ ${NUMBER} ]`);
});

describe('Rincos rendered history', () => {
  it('reads both legs, including collapsed rows, with safe partner metadata and native clock precision', () => {
    const result = normalizeCarrierResult(parseRincos(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-01-04T11:10:00',
      expected_delivery: null, destination_country: 'JP', delivery_carrier: 'sagawa', delivery_tracking_number: '100000000004' });
    expect(result.events).toHaveLength(8);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-01-04T11:10:00', location: 'EXAMPLE DEPOT JAPAN', stage: 'delivered' });
    expect(result.events?.[2]).toMatchObject({ stage: 'in_transit', description: 'Customs clearance completed' });
    expect(result.events?.[3]).toMatchObject({ stage: 'customs' });
    expect(result.events?.at(-2)).toMatchObject({ local_time: '2026-01-02T10:20', stage: 'accepted' });
    expect(result.events?.at(-1)).toMatchObject({ stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events?.at(-1)).not.toHaveProperty('location');
    expect(result.events?.[4]).not.toHaveProperty('location');
    expect(result.events?.every(event => !event.time && !event.time_zone)).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example.invalid|Invoice Print|Remark|printParam/);
  });

  it('preserves the two leg sequences instead of comparing unrelated local clocks', () => {
    const html = fixture().replaceAll('2026-01-03', '2026-01-02').replaceAll('2026-01-04', '2026-01-02');
    const events = parseRincos(html, NUMBER).events!;
    expect(events[0]).toMatchObject({ local_time: '2026-01-02T11:10:00', stage: 'delivered' });
    expect(events[5]).toMatchObject({ local_time: '2026-01-02T16:30', description: 'Processing at GMP Airport' });
  });

  it('preserves an explicitly stated offset and never copies it onto other clocks', () => {
    const result = parseRincos(fixture().replace('2026-01-04 11:10:00', '2026-01-04 11:10:00+05:45'), NUMBER);
    expect(result.events?.[0]).toMatchObject({ time: '2026-01-04T11:10:00+05:45', local_time: '2026-01-04T11:10:00' });
    expect(result.last_update).toBe('2026-01-04T11:10:00+05:45');
    expect(result.events?.slice(1).every(event => !event.time)).toBe(true);
  });

  it.each(['2026-02-30 11:10:00', '2026-01-04 24:10:00', '2026-01-04 11:10:60',
    '2026-01-04 11:10:00+99:00', '2026-01-04 11:10:00+01:99', ''])('rejects malformed newest clock %s', clock => {
    expect(() => parseRincos(fixture().replace('2026-01-04 11:10:00', clock), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires the whole printed Rincos identity as well as the query echo', () => {
    for (const value of [OTHER, NUMBER + '9', NUMBER + ' '.repeat(700) + '9', NUMBER.slice(0, 10) + '****', '']) {
      const html = edit(page => setDetail(page, 'Rincos Tracking No.', value));
      expect(() => parseRincos(html, NUMBER)).toThrow();
    }
    expect(() => parseRincos(edit(page => { page('input[name="P_VAL"]').attr('value', OTHER); }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRincos(edit(page => { page('table.type_detail').clone().appendTo('#frm'); }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRincos(edit(page => {
      page('#btn_print2').parent().append(`<span>${OTHER}</span>`);
    }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRincos(edit(page => {
      page('#btn_print2').parent().after(`<span>${OTHER}</span>`);
    }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('leaves an explicit no-information notice and empty or expired history inconclusive', () => {
    expect(() => parseRincos(absent(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    for (const html of [absent().replace(NUMBER + ' ]', OTHER + ' ]'), absent().replace('해당 번호의 정보가 없습니다.', 'History expired.'),
      edit(page => { page('.Tracking_tit2').text(`해당 번호의 정보가 없습니다. [ ${NUMBER} ]`); }),
      edit(page => { emptyHistory(page); setDetail(page, 'STATUS', ''); })]) {
      expect(() => parseRincos(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('marks a bound summary without its milestone as partial, without inventing a scan time', () => {
    const summary = parseRincos(edit(emptyHistory), NUMBER);
    expect(summary).toMatchObject({ current_stage: 'delivered', summary_only: true, events: [], last_update: null, last_update_local: null });
    const partial = parseRincos(edit(page => { page('.type_list1 tr').last().remove(); }), NUMBER);
    expect(partial).toMatchObject({ current_stage: 'delivered', history_truncated: true, last_status_text: 'Delivered', last_update_local: '2026-01-04T08:10:00' });
    expect(partial).not.toHaveProperty('summary_only');
    expect(partial.events?.[0]).toMatchObject({ stage: 'in_transit' });
  });

  it('retains new wording without staging it as a previous scan', () => {
    const html = edit(page => { setDetail(page, 'STATUS', 'New carrier milestone'); page('.type_list1 tr').last().children('td').eq(1).text('New carrier milestone'); });
    const result = parseRincos(html, NUMBER);
    expect(result.status).toBe('unknown');
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events?.[0]).not.toHaveProperty('stage');
  });

  it('recognizes only the named partner and its intact number, and drops field tokens as places', () => {
    const html = edit(page => {
      setDetail(page, 'Local Courier', 'FedEx MallTail(Nation Code : US)');
      page('.type_list1 tr').last().children('td').eq(2).text('DELIVERY_LOCATION(DL)');
    });
    const result = parseRincos(html, NUMBER);
    expect(result).toMatchObject({ delivery_carrier: 'fedex', delivery_tracking_number: '100000000004', destination_country: 'US' });
    expect(result.events?.[0]).not.toHaveProperty('location');
    for (const [name, value] of [['Local Courier', 'Other Local Service(Nation Code : JP)'], ['Local Tracking No.', '100000000004 EXTRA']]) {
      expect(parseRincos(edit(page => setDetail(page, name!, value!)), NUMBER)).not.toHaveProperty('delivery_carrier');
    }
  });

  it('rejects a changed layout, malformed row, extra panel or excessive response', () => {
    for (const html of ['', '<html><body>Unavailable</body></html>', fixture().replace('<th>Remark</th>', '<th>Details</th>'),
      edit(page => { page('.type_list1 tr').last().children('td').last().remove(); }),
      edit(page => { page('.type_list1').clone().appendTo('.css_test'); }), fixture() + ' '.repeat(RINCOS_MAX_BYTES)]) {
      expect(() => parseRincos(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('bounds history rows and marks a retained history cap', () => {
    const many = (count: number) => edit(page => { page('.type_list1').html('<tbody>' + Array.from({ length: count }, (_, index) =>
      `<tr><td>2026-01-04 11:10:00</td><td>Scan ${index}</td><td>Example depot</td></tr>`).join('') + '</tbody>'); });
    expect(parseRincos(many(105), NUMBER)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseRincos(many(105), NUMBER).events).toHaveLength(100);
    expect(() => parseRincos(many(501), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an HTML challenge separate from history failures', () => {
    expect(() => parseRincos('<html><title>Just a moment</title><script src="/cf-chl-check"></script></html>', NUMBER))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseRincos(fixture() + '<div>Please verify you are human</div>', NUMBER))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('maps the observed origin and partner vocabulary while retaining wording provenance', () => {
    for (const entry of statuses.entries) {
      expect(rincosStage(entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, entry.wording)).toBe(entry.stage);
      expect(statusMap.stage('UNKNOWN', entry.wording)).toBeUndefined();
    }
    expect(rincosStage('On Its Way to Rincos Sorting Center')?.stage).toBe('registered');
    expect(rincosStage('Uncatalogued milestone')).toBeNull();
  });
});

describe('Rincos HTTP adapter', () => {
  it('makes one bounded whole-number request with the supplied client and user agent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture()));
    const tracker = adapter({ fetcher, userAgent: 'Parcel-Test/1', recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    expect(tracker.steps).toEqual(['direct', 'retry']);
    expect(tracker.recognize).toBeUndefined();
    expect(await tracker.track({ number: NUMBER }, { budgetMs: 500 })).toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [address, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(address));
    expect(url.origin + url.pathname).toBe(RINCOS_TRACKING_PAGE);
    expect(Object.fromEntries(url.searchParams)).toEqual({ SCGBN: '20', P_VAL: NUMBER });
    expect(init).toMatchObject({ cache: 'no-store', redirect: 'manual', headers: { 'User-Agent': 'Parcel-Test/1' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries only a failure to reach Rincos and records its recovery provenance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Network unavailable')).mockResolvedValueOnce(new Response(fixture()));
    const step = vi.fn(), lookup = vi.fn();
    await new RincosTracker({ fetcher, recorder: { ...NOOP_RECORDER, step, lookup } }).fetch(NUMBER, { budgetMs: 500 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(step.mock.calls.map(call => call[0])).toMatchObject([
      { step: 'direct', outcome: 'transport' },
      { step: 'retry', outcome: 'ok', fallbackFrom: 'direct', fallbackReason: 'transport' },
    ]);
  });

  it.each([
    [403, 'Blocked', 'challenge'], [429, 'Slow down', 'rate_limited'], [500, 'Unavailable', 'indeterminate'],
    [301, '', 'transport'], [404, '', 'transport'], [410, '', 'transport'], [204, null, 'indeterminate'],
    [200, '<html>captcha</html>', 'challenge'], [200, '{"unexpected":true}', 'schema'], [200, absent(), 'indeterminate'],
  ])('preserves HTTP %s failure %s without retrying', async (status, body, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status, headers: { 'Retry-After': '60' } }));
    await expect(new RincosTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('enforces the byte cap while streaming the response', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(RINCOS_MAX_BYTES)); controller.enqueue(new Uint8Array(1));
    }, cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(new RincosTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('refuses invalid numbers, spent budgets and cancelled calls before requesting', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = new RincosTracker({ fetcher });
    for (const number of ['10000000000017', '8210000000001', NUMBER + '9', 'EXAMPLE']) {
      expect(() => normalizeRincosNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
      await expect(tracker.fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(tracker.fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController(), reason = new Error('Caller cancelled'); controller.abort(reason);
    await expect(tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes cancellation and the total deadline to a hanging request', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!; signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = performance.now();
    await expect(new RincosTracker({ fetcher }).fetch(NUMBER, { budgetMs: 60 })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(500);
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
});
