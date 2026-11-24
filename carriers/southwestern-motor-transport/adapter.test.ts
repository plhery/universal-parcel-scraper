import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SMT_SCREEN } from './adapter.js';
import { normalizeSmtNumber, parseSmtSession, parseSmtTrace } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, as published and as the trace reads it, and an invented PRO.
const SAMPLE = '00171053240';
const PRO = '171053240';
const OTHER = '999999998';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const OPENED = fixture('opened');
const DELIVERED = fixture('delivered');
const NO_SHIPMENT = fixture('no-shipment');
const PSID = (JSON.parse(OPENED) as { psid: string }).psid;
const text = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/plain; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

type Screen = { layers: { formats: { name: string; data: Record<string, string>; subfiles: Record<string, { data: string[][] }> }[] }[] };
/** The delivered screen with its fields and trace rows changed. */
const screen = (data: Record<string, string> = {}, rows?: string[][]) => {
  const reply = JSON.parse(DELIVERED) as Screen;
  const format = reply.layers[0]!.formats[0]!;
  Object.assign(format.data, data);
  if (rows) format.subfiles.TRACEPRO!.data = rows;
  return reply;
};

/** A fetcher that opens the session, answers the trace with `trace`, and takes the closing post. */
const tracker = (trace: () => Response) => vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
  const body = String(init?.body);
  if (String(url) === SMT_SCREEN) return text(OPENED);
  return body === 'shutdown=1' ? text('{"success":true}') : trace();
});

describe('Southwestern Motor Transport numbers', () => {
  it('takes six to eleven digits and drops leading zeros', () => {
    expect(normalizeSmtNumber(SAMPLE)).toBe(PRO);
    expect(normalizeSmtNumber(` ${PRO.slice(0, 3)} ${PRO.slice(3)} `)).toBe(PRO);
    for (const other of ['', '12345', '000000', '123456789012', 'SMT171053240', `${PRO},${OTHER}`, '1'.repeat(65)]) {
      expect(() => normalizeSmtNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Southwestern Motor Transport tracking adapter', () => {
  it('opens a session, traces the PRO on it and closes it', async () => {
    const fetcher = tracker(() => text(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const calls = fetcher.mock.calls.map(([url, init]) => [String(url), String(init?.body)]);
    expect(calls).toEqual([
      [SMT_SCREEN, 'program=MWP705C&library=PROFOUNDUI&init=1'],
      [`${SMT_SCREEN}/${PSID}`, `TRACEBY.FHPRO=${PRO}&TRACEBY.TABINDEX=0`],
      [`${SMT_SCREEN}/${PSID}`, 'shutdown=1'],
    ]);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'southwestern-motor-transport', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('keeps the answer when closing the session fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url) === SMT_SCREEN) return text(OPENED);
      if (String(init?.body) === 'shutdown=1') throw new TypeError('fetch failed');
      return text(DELIVERED);
    });
    await expect(carrier(fetcher).track({ number: PRO })).resolves.toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the empty screen of a PRO the trace does not find as inconclusive, never as not found', async () => {
    const fetcher = tracker(() => text(NO_SHIPMENT));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'indeterminate' });
    // The session is closed after a failed trace too.
    expect(fetcher.mock.calls.at(-1)?.[1]?.body).toBe('shutdown=1');
  });

  it('keeps challenges, refusals, redirects and changed replies apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(tracker(response))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => text(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => text(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => text('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => text('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => text('', { status: 302, headers: { Location: 'https://www.smtl.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => text('', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => text('<!doctype html><html><body>Error</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => text('{"success":false}'))).toMatchObject({ kind: 'indeterminate' });
    // The screen an ended session shows proves nothing about the shipment.
    const ended = JSON.stringify({ success: true, psid: '', layers: [{ formats: [{ name: 'TIMOUTSCRN', data: {} }] }] });
    expect(await answer(() => text(ended))).toMatchObject({ kind: 'indeterminate' });
    // A session that does not open never reaches the trace.
    const unopened = vi.fn<typeof fetch>().mockResolvedValue(text('{"success":true,"psid":"","layers":[{"formats":[{"name":"TRACEBY","data":{}}]}]}'));
    await expect(carrier(unopened).track({ number: OTHER })).rejects.toMatchObject({ kind: 'schema' });
    expect(unopened).toHaveBeenCalledTimes(1);
  });
});

describe('Southwestern Motor Transport screens', () => {
  it('reads the session a new screen opens', () => {
    expect(parseSmtSession(JSON.parse(OPENED))).toBe(PSID);
  });

  it('reads the delivered sample: its rows from the pickup in Houston on their wall clocks, without the signer', () => {
    const result = parseSmtTrace(JSON.parse(DELIVERED), SAMPLE);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-10-22T10:55:00', expected_delivery: null, weight_kg: 46.72,
      events: [
        { local_time: '2026-10-22T10:55:00', description: 'Delivered', location: 'ANGLETON, TX', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-10-22T08:30:00', description: 'Out for Delivery', location: 'HOUSTON, TX', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-10-21T10:51:00', description: 'Cut off not made', location: 'ANGLETON, TX', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-10-21T08:00:00', description: 'Out for Delivery', location: 'HOUSTON, TX', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2026-10-14T12:57:00', description: 'Pickup', location: 'HOUSTON, TX', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
    // The signer, the bill of lading and the purchase order are never read.
    for (const hidden of ['SIGNER', 'Signed by', 'SHIPPER']) expect(JSON.stringify(result)).not.toContain(hidden);
  });

  it('leads with the newest staged row before a delivery, with the appointment or due day as the estimate', () => {
    const rows = [['HOUSTON, TX', '10/21/2026', 'Out for Delivery', '8:00:00'], ['HOUSTON, TX', '10/14/2026', 'Pickup', '']];
    const moving = parseSmtTrace(screen({ $STAT: 'Out for delivery' }, rows), PRO);
    expect(moving).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for Delivery',
      last_update_local: '2026-10-21T08:00:00', expected_delivery: '2026-10-21' });
    expect(moving.events?.at(-1)).toMatchObject({ local_time: '2026-10-14', description: 'Pickup' });
    expect(parseSmtTrace(screen({ $STAT: 'In transit', APPTDATE: '' }, rows.slice(1)), PRO)).toMatchObject({ expected_delivery: '2026-10-15' });
    // A day behind the newest row is stale.
    expect(parseSmtTrace(screen({ $STAT: 'In transit', APPTDATE: '' }, rows), PRO)).toMatchObject({ expected_delivery: null });
    // An oldest-first list is turned round.
    expect(parseSmtTrace(screen({}, [...rows].reverse()), PRO).events?.[0]).toMatchObject({ description: 'Out for Delivery' });
  });

  it('stands a shipment without rows on its status line, and keeps an unknown row visible', () => {
    expect(parseSmtTrace(screen({}, []), PRO)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_status_text: 'Delivered to customer', summary_only: true, events: [] });
    expect(() => parseSmtTrace(screen({ $STAT: '' }, []), PRO)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    const unknown = parseSmtTrace(screen({ $STAT: '' }, [['HOUSTON, TX', '10/21/2026', 'Parked', '8:00:00']]), PRO);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Parked' });
    expect(unknown.events).toEqual([{ local_time: '2026-10-21T08:00:00', description: 'Parked', location: 'HOUSTON, TX' }]);
  });

  it('refuses a screen for another PRO, and reads the empty screen as inconclusive', () => {
    expect(() => parseSmtTrace(JSON.parse(DELIVERED), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSmtTrace(JSON.parse(NO_SHIPMENT), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed screen', () => {
    const row = (cells: string[]) => screen({}, [cells]);
    for (const changed of [null, [], 'x', {}, { success: 'true' }, { success: true }, { success: true, layers: [] },
      { success: true, layers: [{ formats: [] }] }, { success: true, layers: [{ formats: [{ name: 'TRACEBY' }] }] },
      screen({ SHPPRO: '' }), screen({ SHPPRO: 'SMT' }), screen({ SHPPRO: '0' }), screen({ $STAT: 7 as unknown as string }),
      row(['HOUSTON, TX', '2026-10-21', 'Pickup', '8:00:00']), row(['HOUSTON, TX', '02/30/2026', 'Pickup', '8:00:00']),
      row(['HOUSTON, TX', '10/21/2026', 'Pickup', '25:00:00']), row(['HOUSTON, TX', '10/21/2026', '', '8:00:00']),
      row(['HOUSTON, TX', '10/21/2026', 'Pickup']), screen({}, Array.from({ length: 201 }, () => ['HOUSTON, TX', '10/21/2026', 'Pickup', '8:00:00']))]) {
      expect(() => parseSmtTrace(changed, PRO), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Southwestern Motor Transport statuses', () => {
  it('maps every row and status line by its whole wording', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'southwestern-motor-transport', description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
