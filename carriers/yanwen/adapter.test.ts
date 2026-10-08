import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, parse, YanwenTracker, yanwenTrackingUrl } from './adapter.js';
import { InvalidInputError } from '../../core/errors/index.js';
import statuses from './statuses.json' with { type: 'json' };
import { yanwenCategory, yanwenStatus } from './status.js';

const NUMBER = 'UK000000005YP';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const NONE_ICON = '/static/img/timeline_none.png';

/** The fixture with its delivery scan reworded and, unless kept, without its LM40 icon. */
function reworded(wording: string, keepIcon = false) {
  const $ = load(fixture());
  $('.cz_r h6').filter((_, element) => $(element).text().endsWith('Delivered.')).text(wording);
  if (!keepIcon) $('.cz_c img[src$="LM40.png"]').attr('src', NONE_ICON);
  return $;
}

/** The fixture with a last-mile reference and the notes naming its distributor. */
function distributed(reference: string, name: string, site: string) {
  const $ = load(fixture());
  $('.cx_top_nr').each((_, element) => { $(element).children('.colFlex').eq(1).html(`${reference}<a></a>`); });
  $('.cx_lb').append(`<div class="addNotes"><span>Additional Notes</span><p>Distributor: ${name}</p><p>Distributor
    Website: ${site}</p><p>Contact Number: PRIVATE_CONTACT</p></div>`);
  return parse($.html(), NUMBER);
}

describe('Yanwen result projection', () => {
  it('binds both responsive result copies and reads per-scan GMT offsets', () => {
    const result = normalizeCarrierResult(parse(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-03-05T12:00:00+01:00',
      delivered_at: '2026-03-05T12:00:00+01:00', destination_country: 'IT', delivery_tracking_number: '6000000000001' });
    expect(result.events).toHaveLength(4);
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'accepted']);
    expect(result.events?.at(-1)?.time).toBe('2026-03-02T14:00:00+08:00');
    expect(result.events?.[0]!.location).toBe('Example facility');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('requires actual result identity and rejects disagreeing responsive copies', () => {
    expect(() => parse(`<input value="${NUMBER}">${fixture().replaceAll(NUMBER, 'UK000000014YP')}`, NUMBER)).toThrow('different or ambiguous');
    const $ = load(fixture());
    $('.cx_lb').last().find('.cz_r h6').last().text('Different history');
    expect(() => parse($.html(), NUMBER)).toThrow('inconsistent');
    const duplicates = load(fixture());
    duplicates('.ny_cxjg').append(duplicates('input[name=wcdhA]').clone());
    expect(() => parse(duplicates.html(), NUMBER)).toThrow('ambiguous');
  });

  it('recognizes only the explicit identity-bound missing-item result', () => {
    expect(() => parse(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(fixture('not-found').replaceAll('No information was found', 'Maintenance'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(fixture('not-found').replace('查询不到', '未知'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse('<input id="numbers_en"><h1>YW TRACKING</h1>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['date', 'offset', 'empty', 'missing-timeline'])('rejects invalid %s instead of promoting earlier scans', (mode) => {
    const $ = load(fixture());
    if (mode === 'date') $('.czhaodl dt').first().text('2026-02-30');
    if (mode === 'offset') $('.timePoint').first().text('12:00:00 [GMT+unknown]');
    if (mode === 'empty') $('.cz_r').first().find('h6').last().empty();
    if (mode === 'missing-timeline') $('.czhaodl').first().remove();
    expect(() => parse($.html(), NUMBER)).toThrow();
  });

  it('reports a delivery only from a delivered scan, never from the category or progress rail', () => {
    const result = parse(reworded('Expected delivery').html(), NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.current_stage).toBeUndefined();
    expect(result.events?.[0]!.stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads the LM40 delivery scan whatever wording the last-mile carrier used', () => {
    const $ = reworded('Synthetic delivery wording', true);
    expect(parse($.html(), NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-03-05T12:00:00+01:00' });
    // A later notice leaves the delivery and its time in place.
    $('.czhaodl dl').prepend(`<dt>2026-03-06</dt><dd><p class="timePoint">08:00:00 [GMT+01]</p><div class="cz_c"><img src="${NONE_ICON}"></div><div class="cz_r"><h6>Synthetic notice</h6></div></dd>`);
    expect(parse($.html(), NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Synthetic notice',
      delivered_at: '2026-03-05T12:00:00+01:00' });
  });

  it.each([
    ['正在派送', 'out_for_delivery', 'out_for_delivery'], ['到达待取', 'out_for_delivery', 'ready_for_pickup'], ['制单完成', 'pending', 'registered'],
    ['投递失败', 'exception', 'failed_attempt'], ['包裹异常', 'exception', 'exception'], ['包裹退回', 'exception', 'returned'],
    ['运输途中', 'in_transit', undefined], ['追踪结束', 'unknown', undefined],
  ])('takes the status from the %s category when the newest wording is new', (category, status, stage) => {
    const $ = reworded('Synthetic partner wording');
    $('input[name=wcdhA]').attr('status', category);
    const result = parse($.html(), NUMBER);
    expect(result.status).toBe(status);
    expect(result.current_stage).toBe(stage);
    expect(result.events?.[0]!.stage).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
  });

  it('names the distributor only when the catalog knows it and its detection offers the reference', () => {
    expect(distributed('UUS0000000000000001', 'UniUni', 'https://www.uniuni.com/')).toMatchObject({ delivery_carrier: 'uniuni', delivery_tracking_number: 'UUS0000000000000001' });
    const unoffered = distributed('UNI00Z0000000000001', 'UniUni', 'https://www.uniuni.com/');
    expect(unoffered.delivery_carrier).toBeUndefined();
    expect(unoffered.delivery_tracking_number).toBe('UNI00Z0000000000001');
    expect(distributed('YWEXA010000000001', 'YANWEN', 'https://www.yanwenexpress.com/').delivery_carrier).toBeUndefined();
    expect(distributed('UUS0000000000000001', 'Example Post', 'https://www.example.com/').delivery_carrier).toBeUndefined();
    expect(JSON.stringify(distributed('UUS0000000000000001', 'UniUni', 'https://www.uniuni.com/'))).not.toContain('PRIVATE');
  });

  it('keeps postcodes, PINs and door numbers out of scans', () => {
    const $ = load(fixture());
    $('.czhaodl').each((_, timeline) => {
      const rows = $(timeline).find('dd');
      rows.eq(0).find('h6').first().text('[Z9Z 9Z9, Example Town, ZZ]');
      rows.eq(0).find('h6').last().text('Delivered in the mailbox , PIN: 0000 , Door NO: 00. If you have any questions, please contact Example.');
      rows.eq(1).find('h6').first().text('[EXAMPLE TOWN, ZZ 00000]');
      rows.eq(2).find('h6').first().text('[Example Town,ZZ,00000-0000,US]');
    });
    const result = parse($.html(), NUMBER);
    expect(result.events?.slice(0, 3).map((event) => event.location)).toEqual(['Example Town, ZZ', 'EXAMPLE TOWN, ZZ', 'Example Town, ZZ, US']);
    expect(result.last_status_text).toBe('Delivered in the mailbox. If you have any questions, please contact Example.');
    expect(result.status).toBe('delivered');
    for (const value of ['Z9Z', '00000', 'PIN', 'Door']) expect(JSON.stringify([result.last_status_text, result.events])).not.toContain(value);
  });

  it('files every recorded wording, code and category under its recorded stage', () => {
    for (const entry of statuses.entries) {
      if (entry.code === 'LM40') expect(yanwenStatus(entry.wording ?? '', entry.code)?.stage, entry.code).toBe(entry.stage);
      else if (entry.code) expect(yanwenCategory(entry.code)?.stage, entry.code).toBe(entry.stage);
      else expect(yanwenStatus(entry.wording ?? '')?.stage, entry.wording).toBe(entry.stage);
    }
  });

  it('deduplicates identical scans and proves each declared capability', () => {
    const $ = load(fixture());
    $('.czhaodl dl').each((_, element) => { const dl = $(element); dl.append(dl.find('dd').last().clone()); });
    const result = parse($.html(), NUMBER);
    expect(result.events).toHaveLength(4);
    const partner = distributed('UUS0000000000000001', 'UniUni', 'https://www.uniuni.com/');
    const checks: Record<string, boolean> = { history: Boolean(result.events?.length), location: Boolean(result.events?.some((event) => event.location)),
      delivered_at: Boolean(result.delivered_at), delivery_partner: Boolean(partner.delivery_carrier && partner.delivery_tracking_number) };
    const metadata = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    for (const capability of metadata.capabilities) expect(checks[capability], capability).toBe(true);
  });
});

describe('Yanwen anonymous form retrieval', () => {
  it('uses the public browser signature with one fresh bounded form request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture()));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.track({ number: 'uk 000.000-005 yp' })).resolves.toMatchObject({ status: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://track.yw56.com.cn/en/querydel?nums=UK000000005YP&cyp=7cbe10bb0451c723ffac72e72cb79aa2');
    expect(yanwenTrackingUrl(NUMBER)).toBe(url);
    expect(init).toMatchObject({ method: 'POST', body: 'timeZone=1', cache: 'no-store', redirect: 'error' });
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([[404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited']])('classifies HTTP %s without treating it as shipment absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('failure', { status: Number(status) }));
    await expect(new YanwenTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported inputs before I/O, propagates cancellation and limits response size', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(new YanwenTracker({ fetcher: unused }).fetch('tracking&nums')).rejects.toThrow(InvalidInputError);
    await expect(new YanwenTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const huge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new YanwenTracker({ fetcher: huge }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});
