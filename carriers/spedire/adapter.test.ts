import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SPEDIRE_LOOKUPS } from './adapter.js';
import { normalizeSpedireNumber, parseSpedire } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's reply, with its people and places replaced, and a synthetic delivered shipment.
const SAMPLE = 'OE29112537098', SAMPLE_LABEL = '8UW058X000532';
const NUMBER = 'ZZ00000000001', LABEL = 'ZZ00000000002';

type Reply = { success: boolean; shipment: Record<string, unknown>; tracking: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const shipment = (changes: Record<string, unknown> = {}, tracking?: Record<string, unknown>[]) => {
  const reply = fixture('delivered');
  return { ...reply, shipment: { ...reply.shipment, ...changes }, tracking: tracking ?? reply.tracking };
};

describe('Spedire numbers', () => {
  it('takes a reference or a label number in letters and digits, and reads a link to the tracker', () => {
    expect(normalizeSpedireNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeSpedireNumber(SAMPLE_LABEL)).toBe(SAMPLE_LABEL);
    for (const other of ['', 'OE12', 'ABCDEFGHIJ', 'OE2911253709!', 'X'.repeat(41) + '1']) {
      expect(() => normalizeSpedireNumber(other), other).toThrow('Spedire shipment reference');
    }
    expect(parseTrackingInput(`https://www.spedire.com/tracking/${SAMPLE}`)).toMatchObject({ trackingNumber: SAMPLE, carrier: 'spedire' });
  });
});

describe('Spedire tracking adapter', () => {
  it('asks spedire pro, then spedire, for the whole code, as the tracker page does', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => json({ success: false }))
      .mockImplementationOnce(async () => json(fixture(`reference-${SAMPLE.slice(2)}`)));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ provider_code: 'S' });
    expect(SPEDIRE_LOOKUPS).toEqual(['https://www.spedirepro.com/api/public/tracking', 'https://www.spedire.com/api/public/tracking']);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([...SPEDIRE_LOOKUPS]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(JSON.parse(String(init!.body))).toEqual({ code: SAMPLE });
    }
    expect(carrier(fetcher)).toMatchObject({ id: 'spedire', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('stops at spedire pro when it has the shipment', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(shipment()));
    await expect(carrier(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads a code neither platform has as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps refusals, pages and redirects apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: NUMBER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.spedire.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Spedire replies', () => {
  it('reads the public sample: its status letter, its row on the Italian clock and its label number', () => {
    const result = parseSpedire(fixture(`reference-${SAMPLE.slice(2)}`), SAMPLE);
    expect(result).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', provider_code: 'S',
      last_status_text: 'La spedizione risulta in viaggio verso il destinatario.', last_update: null,
      last_update_local: '2025-11-29T14:02:16', expected_delivery: null, destination_country: 'DE',
      delivery_tracking_number: SAMPLE_LABEL,
      events: [{ local_time: '2025-11-29T14:02:16', description: 'Spedizione creata', location: 'Spedire.com', stage: 'registered', stage_source: 'carrier_map' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/name|city|00000|CP0/i);
    // Asked by its label number, the reply hands over nothing new.
    expect(parseSpedire(fixture(`reference-${SAMPLE.slice(2)}`), SAMPLE_LABEL)).not.toHaveProperty('delivery_tracking_number');
  });

  it('stages relayed rows by their wording, newest first, without repeats', () => {
    const result = parseSpedire(shipment(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'D', delivery_tracking_number: LABEL,
      last_status_text: 'La spedizione è stata consegnata al destinatario.', last_update_local: '2026-03-04T11:20:00' });
    expect(result.events!.map(({ local_time, description, stage }) => [local_time, description, stage])).toEqual([
      ['2026-03-04T11:20:00', 'Consegnata', 'delivered'],
      ['2026-03-04T08:05:00', 'In consegna', 'out_for_delivery'],
      ['2026-03-03T18:40:00', 'In transito', 'in_transit'],
      ['2026-03-02T16:00:00', 'Presa in carico', 'accepted'],
      ['2026-03-02T09:15:00', 'Spedizione creata', 'registered'],
    ]);
  });

  it('reads the page’s missed delivery, a pickup point and an unknown letter', () => {
    expect(parseSpedire(shipment({ last_status: 'X', exception_code: 5 }), NUMBER)).toMatchObject({ current_stage: 'failed_attempt', provider_code: 'X',
      last_status_text: expect.stringMatching(/^La consegna della spedizione non è andata a buon fine/) });
    expect(parseSpedire(shipment({ last_status: 'X', exception_code: 0 }), NUMBER)).toMatchObject({ current_stage: 'exception' });
    expect(parseSpedire(shipment({ last_status: 'P' }), NUMBER)).toMatchObject({ current_stage: 'ready_for_pickup' });
    // A letter the page has no sentence for leaves the rows to decide.
    expect(parseSpedire(shipment({ last_status: 'Q' }), NUMBER)).toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language',
      provider_code: 'Q', last_status_text: 'Consegnata' });
  });

  it('answers a shipment without rows by its letter alone', () => {
    expect(parseSpedire(shipment({ last_status: 'N' }, []), NUMBER)).toMatchObject({ status: 'pending', current_stage: 'pending',
      summary_only: true, events: [] });
    expect(() => parseSpedire(shipment({ last_status: null }, []), NUMBER)).toThrow('without a status or rows');
  });

  it('refuses another shipment and a changed reply', () => {
    expect(() => parseSpedire(shipment({ reference: 'ZZ00000000003', tracker: null }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const reply of [null, [], { success: 'true' }, { success: true }, shipment({ last_status: 'DD' }), shipment({ exception_code: '5' }),
      shipment({}, [{ data: '2026-02-30 10:00:00', status: 'x' }]), shipment({}, [{ data: '2026-03-01 10:00', status: '' }]),
      shipment({}, [{ data: '2026-03-01T10:00:00Z', status: 'x' }]), { ...shipment(), tracking: {} }]) {
      expect(() => parseSpedire(reply, NUMBER), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Spedire statuses', () => {
  it('maps each letter by its sentence, as the app reads them back', () => {
    for (const entry of statuses.entries) {
      const code = ('code' in entry && entry.code) || null;
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), `${code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'spedire', ...(code ? { providerCode: code } : {}), description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('X', 'anything else')).toBe('exception');
  });
});
