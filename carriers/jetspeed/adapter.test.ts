import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JetspeedTracker } from './adapter.js';
import { jetspeedUrl, parseJetspeedPage } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic sample in numbers.json, which `track.html` answers.
const NUMBER = 'JSD000000000199';
const UNKNOWN = 'JSD000000000000';
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('JETSPEED tracking adapter', () => {
  it('offers its JSD numbers to recognition', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['jetspeed'] });
  });

  it('reads the tracker’s page for the whole number, every row on its wall clock', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.html')));
    const result = await new JetspeedTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
    expect(String(fetcher.mock.calls[0]![0])).toBe(`https://www.jetspeed-express.com/search_kuai_di/search/orderid/${NUMBER}`);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_update: null,
      last_status_text: 'Parcel arrived at the local delivery station, serving Lyon,69007.', last_update_local: '2026-05-23T01:16:57',
    });
    expect(result.events).toHaveLength(19);
    expect(result.events?.every((event) => event.local_time && !event.time && event.stage)).toBe(true);
    expect(result.events?.at(-1)).toEqual({
      local_time: '2026-05-04T11:20:18', description: 'Mississauga,ON,CA,L5T 0A1,Order information received by the carrier.',
      stage: 'registered', stage_source: 'carrier_map',
    });
    expect(result.events?.at(-2)).toMatchObject({ stage: 'accepted' });
  });

  it('settles the site’s no-order page as not found, and recognition with it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(own('unknown.html')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(adapter(environment(fetcher)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.html')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true, lastActivityLocal: '2026-05-23T01:16:57' });
  });

  it('never takes another page, another number or an empty history for a missing parcel', () => {
    expect(() => parseJetspeedPage(own('track.html'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJetspeedPage(own('unknown.html').replace('未查询到对应订单', '系统繁忙'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJetspeedPage('<html><title>Just a moment...</title>cf-chl-</html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const empty = own('track.html').replace(/<div class="timeline-item[\s\S]*?<\/div>\s*<\/div>/g, '');
    expect(() => parseJetspeedPage(empty, NUMBER)).toThrow(NoHistoryError);
  });

  it('reads a refusal as a challenge, and one number only', async () => {
    const refused = vi.fn<typeof fetch>().mockImplementation(async () => reply('Forbidden', 403));
    await expect(adapter(environment(refused)).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(refused)).track({ number: `${NUMBER};${UNKNOWN}` })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(jetspeedUrl('A B')).toBe('https://www.jetspeed-express.com/search_kuai_di/search/orderid/A%20B');
  });

  it('maps every row it has written, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'jetspeed', providerCode: null, description: 'Origin processing completed [Example].' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'jetspeed', providerCode: null, description: 'Consignment received at the local warehouse in Example.' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'jetspeed', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });
});
