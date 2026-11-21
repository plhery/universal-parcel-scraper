import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PigeonshipTracker } from './adapter.js';
import { normalizePigeonshipNumber, parsePigeonshipPage, pigeonshipUrl } from './parser.js';
import { pigeonshipStage, statusMap } from './status.js';

const NUMBER = '9P8P765H432H10H9PP';
const DELIVERED = '8P7P654H321H09H8PP';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const assigned = (edit: (html: string) => string = html => html) => edit(page('assigned'));
const response = (body: string, status = 200, headers: HeadersInit = {}) => new Response(body, { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code?: string; wording: string; stage: string }[] };
const direct = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PigeonShip tracking page adapter', () => {
  it('asks for the whole number once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(assigned()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new PigeonshipTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://admin.pigeonship.com/shipping/tracking/package/${NUMBER}/`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'text/html', 'User-Agent': 'SyntheticHost/1' } });
    expect(init!.method).toBeUndefined();
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pigeonship', step: 'direct', outcome: 'ok' }));
    expect(pigeonshipUrl('AB/12')).toBe('https://admin.pigeonship.com/shipping/tracking/package/AB%2F12/');
  });

  it('reads the order\'s status and due time as a summary without scans', () => {
    expect(parsePigeonshipPage(200, assigned(), NUMBER)).toEqual({
      status: languageStageStatus('in_transit'), current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Assigned', provider_code: '16', last_update: null,
      expected_delivery: '2026-03-05T03:00:00Z', summary_only: true, events: [] });
    expect(parsePigeonshipPage(200, page('delivered'), DELIVERED)).toEqual({
      status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', provider_code: '64', last_update: null, expected_delivery: null, summary_only: true, events: [] });
  });

  it('reads the page that replaces the tracking page once the delivery is complete as a delivery', async () => {
    const delivered = { status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your delivery has been completed successfully.', last_update: null, expected_delivery: null, summary_only: true, events: [] };
    expect(parsePigeonshipPage(200, page('completed'), DELIVERED)).toEqual(delivered);
    // Its thanks and the delivery's pictures are not read.
    expect(JSON.stringify(parsePigeonshipPage(200, page('completed'), DELIVERED))).not.toMatch(/example\.com|Thank you|Photo|Signature/);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(page('completed')));
    await expect(createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'pigeonship', number: DELIVERED }))
      .resolves.toMatchObject({ source: 'pigeonship', result: { current_stage: 'delivered', summary_only: true } });
    await expect(direct(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    for (const edit of [(html: string) => html.replace('completed successfully.', 'completed.'), (html: string) => html.replace('id="completed-live-tracking"', 'id="live"'),
      (html: string) => html.replace(/<h2 class="text-center">/, '<h3>')]) {
      expect(() => parsePigeonshipPage(200, edit(page('completed')), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    // A tracking page for another number is never taken for the completed one.
    expect(() => parsePigeonshipPage(200, page('completed').replace('<div class="container-fluid" id="root">',
      `<div class="container-fluid" id="root">${/<div id='live-tracking'>[\s\S]*?Tracking number [^<]*<\/div>/.exec(assigned())![0]}`), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes a delivery from either the flag or the code, and leaves unseen codes unstaged', () => {
    const flagged = parsePigeonshipPage(200, assigned(html => html.replace('delivered: false,\n          status', 'delivered: true,\n          status')), NUMBER);
    expect(flagged).toMatchObject({ current_stage: 'delivered', provider_code: '16', last_status_text: 'Assigned', expected_delivery: null });
    expect(parsePigeonshipPage(200, assigned(html => html.replace('status: 16,', 'status: 64,')), NUMBER).current_stage).toBe('delivered');
    const unseen = parsePigeonshipPage(200, assigned(html => html.replace('status: 16,', 'status: 128,').replace("'Assigned'", "'Cancelled'")), NUMBER);
    expect(unseen).toMatchObject({ status: 'unknown', provider_code: '128', last_status_text: 'Cancelled', expected_delivery: '2026-03-05T03:00:00Z' });
    expect(unseen.current_stage).toBeUndefined();
    const escaped = parsePigeonshipPage(200, assigned(html => html.replace("'Assigned'", "'Driver\\u0027s route \\u2013 Assigned'")), NUMBER);
    expect(escaped.last_status_text).toBe('Driver\'s route – Assigned');
  });

  it('reads a missing due date as no estimate and rejects an invalid one', () => {
    for (const due of ["new Date('')", "new Date('None')", 'null']) {
      expect(parsePigeonshipPage(200, assigned(html => html.replace("new Date('2026-03-05T03:00:00+00:00')", due)), NUMBER).expected_delivery).toBeNull();
    }
    for (const due of ["new Date('2026-03-05T03:00:00')", "new Date('2026-02-30T03:00:00+00:00')", "new Date('soon')"]) {
      expect(() => parsePigeonshipPage(200, assigned(html => html.replace("new Date('2026-03-05T03:00:00+00:00')", due)), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('never reads the recipient, the map, the other stops or the delivery picture', () => {
    const result = parsePigeonshipPage(200, page('delivered'), DELIVERED);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE RECIPIENT|40\.0|111\.0|example\.com|2026-03-04/);
  });

  it('tells an unknown number from another page, another number and a changed page', () => {
    expect(() => parsePigeonshipPage(404, page('not-found'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePigeonshipPage(404, '<html><head><title>404 Not Found</title></head><body>nginx</body></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parsePigeonshipPage(200, assigned(), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePigeonshipPage(200, page('not-found'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const edit of [(html: string) => html.replace('status: 16,', 'status: "16",'), (html: string) => html.replace("statusDisplay: 'Assigned',", ''),
      (html: string) => html.replace('delivered: false,\n          status', 'status'), (html: string) => html.replace("el: '#live-tracking'", "el: '#other'"),
      (html: string) => html.replace('Tracking number', 'Order')]) {
      expect(() => parsePigeonshipPage(200, assigned(edit), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('maps every recorded code to its stage', () => {
    for (const entry of statuses.entries) {
      if (entry.code) expect(pigeonshipStage(entry.code)).toBe(entry.stage);
      expect(statusMap.stage(entry.code ?? null, entry.wording.toLowerCase())).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'pigeonship', providerCode: entry.code ?? null, description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(STAGES).toContain(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'pigeonship', providerCode: '16', description: 'Assigned' })).toMatchObject({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'pigeonship', providerCode: '128', description: 'Cancelled' })).toMatchObject({ kind: 'unknown' });
  });

  it.each([[302, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status, { 'retry-after': '60', ...(status === 302 ? { location: '/accounts/login/' } : {}) }));
    await expect(new PigeonshipTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new PigeonshipTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new PigeonshipTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('recognizes an order the page shows, and not an unknown number', async () => {
    await expect(direct(vi.fn<typeof fetch>().mockResolvedValue(response(assigned()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(direct(vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found'), 404))).recognize!(NUMBER)).resolves.toMatchObject({ known: false });
    const never = vi.fn<typeof fetch>();
    await expect(direct(never).recognize!('P-1')).resolves.toMatchObject({ known: false });
    expect(never).not.toHaveBeenCalled();
    await expect(direct(vi.fn<typeof fetch>().mockResolvedValue(response('', 429))).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('routes the recipient\'s link and an explicit selection, and offers the number\'s layout to recognition', async () => {
    expect(parseTrackingInput(`https://admin.pigeonship.com/shipping/tracking/package/${NUMBER}/`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'pigeonship', confidence: 'high', source: 'link' });
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ confidence: 'low', candidates: ['pigeonship'] });
    expect(detectCarrierMatch('9P8P765H432H10H9P').candidates).not.toContain('pigeonship');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).toContain('pigeonship');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(assigned()));
    const result = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'pigeonship', number: NUMBER });
    expect(result.source).toBe('pigeonship');
    expect(result.result).toMatchObject({ current_stage: 'in_transit', summary_only: true });
    for (const number of ['', 'P-1', `${NUMBER},${DELIVERED}`, 'A'.repeat(31), 'ABC1234']) expect(() => normalizePigeonshipNumber(number)).toThrow();
    expect(normalizePigeonshipNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
  });
});
