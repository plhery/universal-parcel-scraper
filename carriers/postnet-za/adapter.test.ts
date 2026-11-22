import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, POSTNET_LOOKUP, POSTNET_TRACKER, PostNetTracker } from './adapter.js';
import { normalizePostNetNumber, parsePostNetEvents, parsePostNetTracker, postNetResult } from './parser.js';
import { postNetStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples: a review's waybill, collected at a PostNet, and a collection notice's waybill.
const COLLECTED = 'PPA81910065407';
const READY = 'PPA78181363215';
// A seven-digit PN waybill Courier IT carried.
const LEGACY = 'PN9124099';
const UNKNOWN = 'PPA99999999990';
// The synthetic value the tracker fixture carries for its token.
const FORM_FIELD = '0123456789abcdef'.repeat(2);
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': body.startsWith('[') || body.startsWith('{') ? 'application/json' : 'text/html; charset=UTF-8', ...headers } });
const trackerReply = () => reply(fixture('tracker.html'), 200, { 'Set-Cookie': 'PHPSESSID=syntheticsession0123456789; path=/; secure; HttpOnly' });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The tracker page, then the networks' answers in the adapter's order. */
const lookup = (...answers: Response[]) => answers.reduce((mock, answer) => mock.mockResolvedValueOnce(answer),
  vi.fn<typeof fetch>().mockResolvedValueOnce(trackerReply()));
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';
const FORBIDDEN = '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN"><html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>';

describe('PostNet tracking adapter', () => {
  it('opens a session on the tracker page, then asks the networks in turn with its token until one has the waybill', async () => {
    const fetcher = lookup(reply(fixture('collected.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PostNetTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ppa 8191 0065 407 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [pageUrl, pageInit] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(pageUrl).toBe(POSTNET_TRACKER);
    expect(pageInit).toMatchObject({ redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    const [lookupUrl, lookupInit] = fetcher.mock.calls[1]! as [string, RequestInit];
    const url = new URL(lookupUrl);
    expect(`${url.origin}${url.pathname}`).toBe(POSTNET_LOOKUP);
    expect(Object.fromEntries(url.searchParams)).toEqual({ rawpost: '1', tracking_number: COLLECTED, provider: 'aramex', t: FORM_FIELD });
    expect(lookupInit).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Cookie: 'PHPSESSID=syntheticsession0123456789', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'postnet-za', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a waybill created at one PostNet and collected at another on South Africa\'s clock, newest first', () => {
    expect(parsePostNetTracker(fixture('tracker.html'))).toBe(FORM_FIELD);
    expect(postNetResult(parsePostNetEvents(fixture('collected.json'), 'aramex'))).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Customer Collection (Collected from PostNet - Robertson)', last_update: '2026-03-20T14:13:00+02:00', expected_delivery: null,
      events: [
        { time: '2026-03-20T14:13:00+02:00', location: 'Robertson, South Africa', description: 'Customer Collection (Collected from PostNet - Robertson)',
          stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-03-20T14:12:00+02:00', location: 'Robertson, South Africa', description: 'Ready For Collection (Received at PostNet - Robertson)',
          stage: 'ready_for_pickup', stage_source: 'carrier_map' },
        { time: '2026-03-18T12:12:00+02:00', location: 'Witbank, South Africa', description: 'Shipment Created (Shipment Created at PostNet - Ben Fleur)',
          stage: 'accepted', stage_source: 'carrier_map' },
      ] });
    expect(postNetResult(parsePostNetEvents(fixture('ready-for-collection.json'), 'aramex')))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', last_update: '2022-03-15T09:07:00+02:00' });
  });

  it('keeps only the event of Courier IT\'s answer for an older waybill, after the networks before it answer without it', async () => {
    const fetcher = lookup(reply(''), reply(fixture('courier-it.json')));
    await expect(carrier(fetcher).track({ number: LEGACY })).resolves.toMatchObject({ status: 'delivered',
      events: [{ time: '2019-09-18T11:02:00+02:00', location: 'CPT', description: 'Proof Of Delivery', stage: 'delivered' }] });
    expect(fetcher.mock.calls.slice(1).map(([url]) => new URL(String(url)).searchParams.get('provider'))).toEqual(['aramex', 'cit']);
    const detailed = JSON.stringify([{ date: '28 April 2026', time: '02:43 PM', location: 'DUR', description: 'Delivery Details - SAMPLE SIGNER' }]);
    expect(JSON.stringify(parsePostNetEvents(detailed, 'cit'))).not.toMatch(/SAMPLE SIGNER/);
  });

  it('reads a waybill every network answers without as not found', async () => {
    const empty = () => reply('');
    const fetcher = lookup(empty(), empty(), empty(), empty(), empty());
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.slice(1).map(([url]) => new URL(String(url)).searchParams.get('provider'))).toEqual(['aramex', 'cit', 'dhl', 'sprint', 'coastal']);
    await expect(carrier(lookup(empty(), empty(), empty(), empty(), empty())).recognize!(UNKNOWN)).resolves.toMatchObject({ known: false });
    await expect(carrier(lookup(reply(fixture('collected.json')))).recognize!(COLLECTED)).resolves.toMatchObject({ known: true });
  });

  it('refuses a changed tracker page, invalid events and clocks, and a block page', () => {
    expect(() => parsePostNetTracker(fixture('tracker.html').replace('id="track-token"', 'id="token"'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePostNetTracker(BLOCKED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const event = (fields: Record<string, unknown>) => JSON.stringify([{ date: '20 March 2026', time: '02:13 PM', location: 'Robertson, South Africa',
      description: 'Customer Collection', ...fields }]);
    for (const bad of [event({ date: '30 February 2026' }), event({ time: '14:13' }), event({ time: '13:13 PM' }), event({ description: '' }),
      event({ location: 7 }), '[]', '{}', '[1]', 'nonsense']) {
      expect(() => parsePostNetEvents(bad, 'aramex'), bad).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parsePostNetEvents(BLOCKED, 'aramex')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(parsePostNetEvents(event({ location: '' }), 'aramex')[0]).not.toHaveProperty('location');
  });

  it('keeps refusals, expired sessions, redirects and failures apart from a missing waybill, and retries a network failure once', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('tracker.html')))).track({ number: COLLECTED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(lookup(reply('{"error":"Your tracking session has expired. Reload the page and try again."}', 403))).track({ number: COLLECTED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(lookup(reply(FORBIDDEN, 403))).track({ number: COLLECTED })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(lookup(reply(BLOCKED, 403))).track({ number: COLLECTED })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(lookup(reply(''), reply('', 302, { Location: '/tracker' }))).track({ number: COLLECTED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(lookup(reply(''), reply('', 429))).track({ number: COLLECTED })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(lookup(reply(''), reply('', 404))).track({ number: COLLECTED })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(BLOCKED, 403))).track({ number: COLLECTED })).rejects.toMatchObject({ kind: 'challenge' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(trackerReply())
      .mockResolvedValueOnce(reply(fixture('collected.json')));
    await expect(carrier(fetcher).track({ number: COLLECTED })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('takes PostNet\'s waybills and refuses anything else before a request', async () => {
    expect(normalizePostNetNumber('ppa78181363215')).toBe(READY);
    expect(normalizePostNetNumber('PNA1234567890')).toBe('PNA1234567890');
    expect(normalizePostNetNumber('pp1039303')).toBe('PP1039303');
    for (const bad of ['PPA8086008210', 'PNA12345678901', 'PX1234567', 'CDM132108761', 'PAR1234567890', 'X'.repeat(65)]) {
      expect(() => normalizePostNetNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'CDM132108761' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording to its stage', () => {
    for (const entry of statuses.entries) {
      expect(postNetStage(entry.wording) ?? null, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'postnet-za', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});
