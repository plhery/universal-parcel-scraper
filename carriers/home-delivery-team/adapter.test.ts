import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { HdtTracker } from './adapter.js';
import { normalizeHdtNumber, parseHdt } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '3527375';
const RETURNED = '3320041';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });

describe('Home Delivery Team guest adapter', () => {
  it('opens the tracking page for one order number, with no session or token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const result = await new HdtTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(' 3527375 ', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://homedt.hu/nyomonkovetes?track_number=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'A címzett megkapta az általa várt megrendelést',
      last_update: null, last_update_local: '2026-05-29T10:21:29' });
  });

  it('keeps the steps newest first on Budapest wall clocks, and the central warehouse as the place', () => {
    const result = parseHdt(page('delivered.html'), DELIVERED);
    expect(result.events!.map(event => [event.local_time, event.provider_code, event.location, event.stage])).toEqual([
      ['2026-05-29T10:21:29', 'Kiszállítva', undefined, 'delivered'],
      ['2026-05-29T06:09:46', 'Címzetthez szállítás alatt', undefined, 'out_for_delivery'],
      ['2026-05-27T19:46:51', 'Központi raktárban', 'Budapest', 'in_transit'],
      ['2026-05-27T11:00:27', 'Várakozik', undefined, 'registered'],
    ]);
    expect(result.events!.every(event => !event.time)).toBe(true);
    expect(result.events![2]!.description).toBe('Megrendelése a budapesti központi raktárunkban van');
  });

  it('reads a cancelled order brought back to the shop as returned', () => {
    const result = parseHdt(page('returned.html'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_update_local: '2025-05-29T08:57:46' });
    expect(result.events!.map(event => [event.provider_code, event.stage])).toEqual([
      ['Visszáru / leadva a feladónál', 'returned'],
      ['Visszáru / Központi raktárban', 'returned'],
      ['Beszállítás alatt', 'accepted'],
      ['Várakozik', 'registered'],
    ]);
  });

  it('reports an unknown order as not found and checks the number and the steps', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new HdtTracker({ fetcher }).fetch('1234567')).rejects.toMatchObject({ kind: 'not_found' });
    const html = page('delivered.html');
    expect(() => parseHdt(html.replace('2026-05-29 06:09:46', '2026-02-30 06:09:46'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHdt(html.replace('Időpont: 2026-05-29 06:09:46', 'Időpont: 2026-05-29'), DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHdt(html.replace(/<div class="boxs">[\s\S]*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/, ''), DELIVERED))
      .toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHdt('<html><body>Karbantartás</body></html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const number of ['12345', '123456789', '0352737', 'HDT3527375', 'XX/2026/000001/3527375']) {
      expect(() => normalizeHdtNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('keeps checks and transport failures distinct', async () => {
    expect(() => parseHdt('<html><title>Just a moment...</title></html>', DELIVERED)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new HdtTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the status titles and leaves others without a stage', () => {
    expect(statusMap.stage('Kiszállítva', '')).toBe('delivered');
    expect(statusMap.stage('Visszáru / Központi raktárban', '')).toBe('returned');
    expect(statusMap.stage('Sikertelen kézbesítés', '')).toBeUndefined();
    const result = parseHdt(page('delivered.html').replace('<h2>Kiszállítva</h2>', '<h2>Sikertelen kézbesítés</h2>'), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: 'Sikertelen kézbesítés' });
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.status).toBe('unknown');
  });

  it('reads the archived /track links and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('home-delivery-team');
    for (const link of [`https://www.homedt.hu/track?track_number=${DELIVERED}`, `https://homedt.hu/nyomonkovetes?track_number=${DELIVERED}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: DELIVERED, carrier: 'home-delivery-team' });
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'home-delivery-team', number: DELIVERED });
    expect(tracked.source).toBe('home-delivery-team');
    expect(tracked.result.status).toBe('delivered');
  });
});
