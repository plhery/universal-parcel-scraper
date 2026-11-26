import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { jomkirimTrackingUrl, normalizeJomkirimNumber, parseJomkirim, readJomkirimForm } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = fixture('delivered');
const notFound = fixture('not-found');
const SAMPLE = numbers.records[0]!.number;
// An invented code in the sample's layout, and the sample's page under it.
const OTHER = 'AWB99999';
const other = delivered.replaceAll(SAMPLE, OTHER);
const SESSION = 'jomkirim_courier_session=session-value';
const FORM = 'https://courier.jomkirim.com/shipment/tracking';

const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const redirect = (location: string, cookies = ['XSRF-TOKEN=token-value; path=/', `${SESSION}; path=/; httponly`]) => new Response(null, {
  status: 302, headers: [['Location', location], ...cookies.map((cookie) => ['Set-Cookie', cookie] as [string, string])] });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, userAgent: 'Jomkirim test agent', recorder: NOOP_RECORDER, env: {},
  trawl: null, browserExecutablePath: null });
const failure = async (...responses: (() => Response)[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockImplementationOnce(async () => response());
  return carrier(fetcher).track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
};

describe('Jomkirim numbers', () => {
  it('takes a shipment code, a letter prefix and digits, in capitals', () => {
    expect(normalizeJomkirimNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeJomkirimNumber('sh00001')).toBe('SH00001');
    expect(jomkirimTrackingUrl(SAMPLE.toLowerCase())).toBe(`${FORM}/${SAMPLE}`);
    for (const wrong of ['', '05912', 'AWB', 'AWB12', 'AWB05912X', 'AWB/05912', 'ABCDEFGHIJK123', `AWB${'1'.repeat(16)}`]) {
      expect(() => normalizeJomkirimNumber(wrong), wrong).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Jomkirim pages', () => {
  it('reads the public sample: its rows on the tracker’s wall clock, newest first', () => {
    expect(parseJomkirim(delivered, SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2023-03-15T19:05:34', expected_delivery: null,
      events: [
        { local_time: '2023-03-15T19:05:34', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2023-03-02T19:15:11', description: 'Out for delivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2023-03-02T13:00:37', description: 'In Processing', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-03-02T12:41:41', description: 'Created', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The partner's tracking link is not a confirmed hand-over.
    expect(JSON.stringify(parseJomkirim(delivered, SAMPLE))).not.toMatch(/line|partner|tracking\.my/i);
  });

  it('reads a midnight row, a row it repeats and a status no rule knows', () => {
    const page = delivered
      .replace('15-03-2023 07:05:34pm', '16-03-2023 12:05:34am')
      .replace(/(<tbody>)/, '$1<tr><td>3 years ago (02-03-2023 12:41:41pm)</td><td>Created</td><td></td><td></td></tr>')
      .replace('<span class="opacity-70 d-block">Delivered</span>', '<span class="opacity-70 d-block">Pending</span>');
    const result = parseJomkirim(page, SAMPLE);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Pending', last_update_local: '2023-03-16T00:05:34' });
    expect(result.events).toHaveLength(4);
  });

  it('keeps a shipment with a status and no rows as its status alone', () => {
    const page = delivered.replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>');
    expect(parseJomkirim(page, SAMPLE)).toMatchObject({ current_stage: 'delivered', summary_only: true, events: [] });
  });

  it('refuses another shipment’s page, a check page and a changed page', () => {
    expect(() => parseJomkirim(other, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJomkirim('<title>Just a moment...</title>', SAMPLE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    for (const page of [
      notFound,
      delivered.replace('Shipment: ', 'Order: '),
      delivered.replace('Current Status', 'Status'),
      delivered.replace('>Details<', '>Event<'),
      delivered.replace('(02-03-2023 12:41:41pm)', '(2023-03-02 12:41:41)'),
      delivered.replace('(02-03-2023 12:41:41pm)', '(31-02-2023 12:41:41pm)'),
      delivered.replace('<td>Created</td>', '<td></td>'),
      delivered.replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>').replace('<span class="opacity-70 d-block">Delivered</span>', '<span class="opacity-70 d-block"></span>'),
    ]) {
      expect(() => parseJomkirim(page, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads the form’s notice as not found, and the form without it as no answer', () => {
    expect(() => readJomkirimForm(notFound)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => readJomkirimForm(notFound.replace(/<script[\s\S]*<\/script>/, ''))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => readJomkirimForm(delivered)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Jomkirim tracking adapter', () => {
  it('opens the shipment’s page, as the tracking form does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(delivered));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${FORM}/${SAMPLE}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(init?.headers).get('User-Agent')).toBe('Jomkirim test agent');
    expect(new Headers(init?.headers).get('Cookie')).toBeNull();
    expect(carrier(fetcher)).toMatchObject({ id: 'jomkirim', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('follows an unknown code to the form in its session and reads the notice as not found', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => redirect(FORM))
      .mockImplementationOnce(async () => html(notFound));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe(FORM);
    expect(new Headers(init?.headers).get('Cookie')).toBe(SESSION);
  });

  it('keeps redirects, refusals and failures apart from a missing shipment', async () => {
    expect(await failure(() => redirect(FORM), () => html(notFound.replace(/<script[\s\S]*<\/script>/, '')))).toMatchObject({ kind: 'indeterminate' });
    expect(await failure(() => redirect(FORM, []))).toMatchObject({ kind: 'indeterminate' });
    expect(await failure(() => redirect('https://courier.jomkirim.com/login'))).toMatchObject({ kind: 'transport' });
    expect(await failure(() => redirect(`${FORM}?code=${OTHER}`))).toMatchObject({ kind: 'transport' });
    expect(await failure(() => redirect(FORM), () => redirect('https://courier.jomkirim.com/login'))).toMatchObject({ kind: 'transport' });
    expect(await failure(() => html('', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await failure(() => html('<title>Forbidden</title>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await failure(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await failure(() => html('<title>Server Error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await failure(() => html('<html><body>Maintenance</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await failure(() => html(delivered))).toMatchObject({ kind: 'indeterminate' });
  });
});

describe('Jomkirim statuses', () => {
  it('maps each wording seen on the tracker', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'jomkirim', description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'pending')).toBeUndefined();
  });
});
