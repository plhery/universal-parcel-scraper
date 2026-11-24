import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { CambodiaPostTracker } from './adapter.js';
import { CAMBODIA_POST_SEARCH, normalizeCambodiaPostNumber, parseCambodiaPost } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = 'RU833689939NL';
const UNKNOWN = 'RR473182659KH';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
// The page as it comes after /lang/en: the same scans under English headings.
const english = (html: string) => html.replace(/<thead[\s\S]*?<\/thead>/, `<thead><tr>${['Local Date and Time', 'Country', 'Location',
  'Event Type', 'Mail Category', 'Next Office', 'Extra Information'].map(name => `<th><div>${name}</div></th>`).join('')}</tr></thead>`);

describe('Cambodia Post guest adapter', () => {
  it('opens the page the tracking form opens for one item code, with no session or captcha', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new CambodiaPostTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' ru 833 689 939 nl ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${CAMBODIA_POST_SEARCH}?search=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Deliver item (Inb)', last_update: null, last_update_local: '2022-07-28T14:15:00', destination_country: 'KH' });
  });

  it('reads the scans newest first as wall clocks, with their offices and the details of a failed attempt', () => {
    const result = parseCambodiaPost(page('delivered.html'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2022-07-28T14:15:00', 'PHNOM PENH, Cambodia', 'Deliver item (Inb)', 'delivered'],
      ['2022-07-21T15:37:00', 'PHNOM PENH, Cambodia',
        'Unsuccessful item delivery attempt (Inb): Other; Scheduled for further action/processing today', 'failed_attempt'],
      ['2022-07-21T14:21:11', 'PHNOM PENH, Cambodia', 'Handover item to delivery agent (Inb)', 'out_for_delivery'],
      ['2022-07-21T14:13:02', 'PHNOM PENH, Cambodia', 'Receive item at delivery office (Inb)', 'in_transit'],
      ['2022-07-21T13:47:11', 'PHNOM PENH, Cambodia', 'Send item to domestic location (Inb)', 'in_transit'],
      ['2022-07-21T13:43:38', 'PHNOM PENH, Cambodia', 'Return item from customs (Inb)', 'in_transit'],
      ['2022-07-21T13:33:55', 'PHNOM PENH, Cambodia', 'Record item customs information (Inb)', 'customs'],
      ['2022-07-21T13:27:53', 'PHNOM PENH, Cambodia', 'Send item to customs (Inb)', 'customs'],
      ['2022-07-21T13:07:46', 'PHNOM PENH, Cambodia', 'Receive item at office of exchange (Inb)', 'in_transit'],
      ['2022-07-17T16:15:00', 'DEN HAAG A POSTNL IMEC, Netherlands', 'Send item abroad (EDI-received)', 'in_transit'],
      ['2022-07-15T22:11:00', 'DEN HAAG A POSTNL IMEC, Netherlands', 'Insert item into bag (Otb)', 'in_transit'],
      ['2022-07-05T03:07:00', 'AMSTERDAM E INTERNATIONAL MAIL, Netherlands', 'Receive item from customer (Otb)', 'accepted'],
    ]);
    expect(result.events!.every(event => !event.time && event.stage_source === 'carrier_map')).toBe(true);
    // The signatory the delivery's extra information names is not read.
    expect(JSON.stringify(result)).not.toMatch(/SIGNATORY|Sign by/i);
    expect(result.signed_by).toBeUndefined();
  });

  it('reads the English page alike and keeps a scan the page lists twice once', () => {
    expect(parseCambodiaPost(english(page('delivered.html')), DELIVERED).events).toEqual(parseCambodiaPost(page('delivered.html'), DELIVERED).events);
    const html = page('delivered.html');
    const row = /<tr style="font-size:0\.875rem" class="border-bottom">[\s\S]*?<\/tr>/.exec(html)![0];
    expect(parseCambodiaPost(html.replace(row, row + row), DELIVERED).events).toHaveLength(12);
  });

  it('reports the page\'s Not Found row as not found and requires the whole item code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new CambodiaPostTracker({ fetcher }).fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseCambodiaPost(english(page('not-found.html')), UNKNOWN)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseCambodiaPost(page('delivered.html'), 'RU833689942NL')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCambodiaPost(page('not-found.html').replace('>Not Found<', '>Server Error<'), UNKNOWN))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCambodiaPost(page('not-found.html').replace(/<tr>\s*<td colspan[\s\S]*?<\/tr>/, ''), UNKNOWN))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['RU833689938NL', 'RU83368993NL', '833689939', 'RU833689939N']) {
      expect(() => normalizeCambodiaPostNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('refuses a changed page, an impossible clock and an offset it does not expect', () => {
    const html = page('delivered.html');
    for (const changed of [
      html.replace('2022-07-21T13:07:46.953Z', '2022-02-30T13:07:46.953Z'),
      html.replace('2022-07-21T13:07:46.953Z', '2022-07-21T13:07:46.953+07:00'),
      html.replace('Mail Category', 'Category').replace('ប្រភេទសំបុត្រ', 'Category'),
      html.replace('<td class="py-4">', ''),
      '<html><title>Maintenance</title></html>',
    ]) expect(() => parseCambodiaPost(changed, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps checks, rate limits and transport failures distinct', async () => {
    expect(() => parseCambodiaPost('<html><title>Just a moment...</title><body><div id="cf-turnstile"></div></body></html>', DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new CambodiaPostTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the IPS event names without their leg and leaves others to the shared rules', () => {
    expect(statusMap.stage('', 'Handover item to delivery agent (Inb)')).toBe('out_for_delivery');
    expect(statusMap.stage('', 'Unsuccessful item delivery attempt (Inb): Other; Scheduled for further action/processing today')).toBe('failed_attempt');
    expect(statusMap.stage('', 'Send item abroad (EDI-received)')).toBe('in_transit');
    expect(statusMap.stage('', 'Hold item at office')).toBeUndefined();
    const result = parseCambodiaPost(page('delivered.html').replace('Deliver item (Inb)', 'Hold item at office (Inb)'), DELIVERED);
    expect(result.events![0]).toMatchObject({ description: 'Hold item at office (Inb)' });
    expect(result.events![0]!.stage_source).not.toBe('carrier_map');
  });

  it('is not detected and tracks on explicit selection, dating each office on its own clock', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('cambodia-post');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'cambodia-post', number: DELIVERED });
    expect(tracked.source).toBe('cambodia-post');
    expect(tracked.result.status).toBe('delivered');
    const events = tracked.result.events ?? [];
    expect(events[0]).toMatchObject({ local_time: '2022-07-28T14:15:00', time_zone: 'Asia/Phnom_Penh' });
    expect(events.at(-1)).toMatchObject({ local_time: '2022-07-05T03:07:00', time_zone: 'Europe/Amsterdam' });
  });
});
