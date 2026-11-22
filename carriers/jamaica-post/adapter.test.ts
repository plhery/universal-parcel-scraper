import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JAMAICA_POST_FORM, JAMAICA_POST_RESULT, JamaicaPostTracker } from './adapter.js';
import { normalizeJamaicaPostNumber, parseJamaicaPostForm, parseJamaicaPostResult } from './parser.js';
import { jamaicaPostStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample: a registered item sorted to the Half Way Tree post office.
const ITEM = 'RR014310824JM';
const UNKNOWN = 'RR999999995JM';
// The synthetic value the form fixture carries for its CSRF field.
const FORM_FIELD = '0123456789abcdef'.repeat(4);
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const formReply = () => reply(page('form'), 200, { 'Set-Cookie': 'PHPSESSID=syntheticsession0123456789; path=/; secure; HttpOnly; SameSite=Lax' });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (result: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(formReply()).mockResolvedValueOnce(result);
// One row of the page's history, as the page writes it.
const row = (handler: string, time: string, next: string, status = '') => `<tr>
<td class="resultCell text-nowrap" align="right">9.</td><td>&nbsp;</td><td class="resultCell text-nowrap">${handler}</td><td>&nbsp;</td>
<td class="resultCell">${time}</td><td >&nbsp;</td><td class="resultCell text-nowrap" >${next}</td><td>&nbsp;</td>
<td class="resultCell">${status}</td><td>&nbsp;</td><td class="resultCell">SAMPLE COMMENT</td></tr>`;
const heading = (day: string) => `<tr><th colspan="3">${day}</th><th>&nbsp;</th><th>Time</th><th>&nbsp;</th><th>Next Location</th>
<th>&nbsp;</th><th>Status</th><th>&nbsp;</th><th>Comments</th></tr>`;
// The sample's page with these rows instead of its own.
const withRows = (rows: string) => page('registered').replace(/(<table[^>]*>)[\s\S]*?(<\/table>)/, `$1${rows}$2`);
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';

describe('Jamaica Post tracking adapter', () => {
  it('opens a session on the form page, then posts the whole code with its token, through the supplied transport', async () => {
    const fetcher = lookup(reply(page('registered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new JamaicaPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rr 014 310 824 jm ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [formUrl, formInit] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(formUrl).toBe(JAMAICA_POST_FORM);
    expect(formInit).toMatchObject({ redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    const [resultUrl, resultInit] = fetcher.mock.calls[1]! as [string, RequestInit];
    expect(resultUrl).toBe(JAMAICA_POST_RESULT);
    expect(resultInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Cookie: 'PHPSESSID=syntheticsession0123456789', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(resultInit.body)))).toEqual({ csrf_token: FORM_FIELD, Consignment: ITEM, submit: 'Track Now' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jamaica-post', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s hand-offs newest first on Jamaica\'s clock, with its service', () => {
    expect(parseJamaicaPostForm(page('form'))).toBe(FORM_FIELD);
    const result = parseJamaicaPostResult(page('registered'), ITEM);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Next Location: HALF WAY TREE PO', last_update: '2025-02-12T16:50:00-05:00', expected_delivery: null,
      service_name: 'Registered Mail', events: [
        { time: '2025-02-12T16:50:00-05:00', description: 'Next Location: HALF WAY TREE PO', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2025-02-12T15:04:00-05:00', description: 'Next Location: distributor4', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2025-02-12T13:59:00-05:00', description: 'Next Location: distributor1', stage: 'in_transit', stage_source: 'carrier_map' },
      ] });
    expect(JSON.stringify(result)).not.toMatch(/bag_opener/);
  });

  it('keeps a status it cannot map visible, sorts days newest first and drops the comments', () => {
    const result = parseJamaicaPostResult(withRows([
      heading('Thursday, February 13, 2025'), row('counter1', '09:15', '', 'Delivered to Addressee'),
      heading('Wednesday, February 12, 2025'), row('distributor4', '16:50', 'HALF WAY TREE PO'),
    ].join('')), ITEM);
    expect(result).toMatchObject({ status: 'in_transit', last_update: '2025-02-13T09:15:00-05:00' });
    expect(result.events!.map((event) => [event.time, event.description, event.stage])).toEqual([
      ['2025-02-13T09:15:00-05:00', 'Delivered to Addressee', undefined],
      ['2025-02-12T16:50:00-05:00', 'Next Location: HALF WAY TREE PO', 'in_transit'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE COMMENT/);
  });

  it('reads the notice for a code the tracker holds nothing for as not found', async () => {
    expect(() => parseJamaicaPostResult(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(lookup(reply(page('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(lookup(reply(page('not-found')))).recognize!(UNKNOWN)).resolves.toMatchObject({ known: false });
    await expect(carrier(lookup(reply(page('registered')))).recognize!(ITEM)).resolves.toMatchObject({ known: true });
  });

  it('refuses another item, a changed form, invalid rows and clocks, and a block page', () => {
    expect(() => parseJamaicaPostResult(page('registered'), 'RR014310807JM')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJamaicaPostResult(page('not-found'), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJamaicaPostForm(page('form').replace('name="csrf_token"', 'name="token"'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJamaicaPostForm(BLOCKED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseJamaicaPostResult(withRows(heading('Wednesday, February 30, 2025') + row('a', '16:50', 'X')), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJamaicaPostResult(withRows(heading('Wednesday, February 12, 2025') + row('a', '24:50', 'X')), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJamaicaPostResult(withRows(heading('Wednesday, February 12, 2025') + row('a', '16:50', '')), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJamaicaPostResult(withRows(row('a', '16:50', 'X')), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJamaicaPostResult(withRows('<tr><td>16:50</td></tr>'), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJamaicaPostResult(withRows(''), ITEM)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseJamaicaPostResult(BLOCKED, ITEM)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseJamaicaPostResult('<html><title>Jamaica</title></html>', ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a session it cannot open, redirects, refusals and rate limits apart from a missing item, and retries a network failure once', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(page('form')))).track({ number: ITEM }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(lookup(reply('', 302, { Location: 'track-status.php' }))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(lookup(reply(BLOCKED, 403))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('', 404))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(lookup(reply('', 429))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'rate_limited' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(formReply())
      .mockResolvedValueOnce(reply(page('registered')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('takes S10 codes with a valid check digit and refuses anything else before a request', async () => {
    expect(normalizeJamaicaPostNumber('rr014310824jm')).toBe(ITEM);
    for (const bad of ['RR014310825JM', 'ZL53533553', 'CSN6754', 'X'.repeat(65)]) {
      expect(() => normalizeJamaicaPostNumber(bad)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'RR014310825JM' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording to its stage', () => {
    for (const entry of statuses.entries) {
      expect(jamaicaPostStage(entry.wording.split(': ')[0]!) ?? null, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'jamaica-post', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});
