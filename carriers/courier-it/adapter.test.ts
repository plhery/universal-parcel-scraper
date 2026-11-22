import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parsePostNetEvents, postNetResult } from '../postnet-za/parser.js';
import { adapter, CourierItTracker, normalizeCourierItNumber } from './adapter.js';
import { courierItStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples: a review's waybill, delivered in April 2026, and ParcelPanel's sample, delivered in August 2022.
const DELIVERED = 'CDM132108761';
const REDELIVERED = 'ATS122393';
const UNKNOWN = 'CDM999999990';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const postNetFixture = (name: string) => readFileSync(new URL(`../postnet-za/fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': body.startsWith('[') ? 'application/json' : 'text/html; charset=UTF-8', ...headers } });
const trackerReply = () => reply(postNetFixture('tracker.html'), 200, { 'Set-Cookie': 'PHPSESSID=syntheticsession0123456789; path=/; secure; HttpOnly' });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (answer: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(trackerReply()).mockResolvedValueOnce(answer);
const event = (description: string, time: string) => ({ date: '22 April 2026', time, location: 'JNB', description });

describe('Courier IT tracking adapter', () => {
  it('asks PostNet\'s tracker for Courier IT\'s network alone, in a session the tracker page opens', async () => {
    const fetcher = lookup(reply(fixture('delivered.json')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new CourierItTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${DELIVERED.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![0]).toBe('https://www.postnet.co.za/tracker');
    const url = new URL(String(fetcher.mock.calls[1]![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ tracking_number: DELIVERED, provider: 'cit' });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ headers: { Cookie: 'PHPSESSID=syntheticsession0123456789', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'courier-it', step: 'direct', outcome: 'ok' }));
  });

  it('reads a waybill from its handover to its proof of delivery, keeping events without their names', () => {
    const result = postNetResult(parsePostNetEvents(fixture('delivered.json'), 'cit'));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'POD Rec. In Branch',
      last_update: '2026-04-28T14:55:00+02:00' });
    expect(result.events).toHaveLength(16);
    expect(result.events!.map(({ description, stage }) => [description, stage ?? null])).toEqual([
      ['POD Rec. In Branch', 'delivered'], ['Proof Of Delivery', 'delivered'], ['Delivery Details', 'delivered'], ['Text POD', 'delivered'],
      ['Loaded Into Vehicle', 'out_for_delivery'], ['Parcel Handover (Cage)', 'in_transit'], ['Loaded Into Vehicle', 'out_for_delivery'],
      ['Depot checkin', 'in_transit'], ['Depot checkout', 'in_transit'], ['Captured Ops', 'registered'], ['Depot checkin', 'in_transit'],
      ['Depot checkout', 'in_transit'], ['Captured Ops', 'registered'], ['Collection Booked', null], ['Courier Pick-Up Number', null],
      ['Handed Over', 'accepted'],
    ]);
    expect(result.events!.at(-1)).toEqual({ time: '2026-04-22T15:59:00+02:00', location: 'JNB', description: 'Handed Over', stage: 'accepted',
      stage_source: 'carrier_map' });
    // The details name the sender, the driver and who signed.
    expect(JSON.stringify(result)).not.toMatch(/Received From|SCHEDULE|Route|Pieces Counted|Waybill Scanned/);
  });

  it('reads delivery exceptions and leaves out staff comments', () => {
    const result = postNetResult(parsePostNetEvents(fixture('redelivered.json'), 'cit'));
    expect(result).toMatchObject({ status: 'delivered', last_update: '2022-08-18T11:03:00+02:00' });
    expect(result.events).toHaveLength(16);
    expect(result.events!.filter(({ stage }) => stage === 'failed_attempt').map(({ time }) => time))
      .toEqual(['2022-08-15T18:41:00+02:00', '2022-08-11T14:53:00+02:00']);
    expect(result.events!.some(({ description }) => /comment/i.test(description!))).toBe(false);
  });

  it('keeps a waybill taken over when its details are captured after the handover', () => {
    const events = parsePostNetEvents(JSON.stringify([event('Captured Ops - Waybill Information Received InTo System.', '05:35 PM'),
      event('Handed Over - Received From Sample Sender', '03:59 PM')]), 'cit');
    expect(postNetResult(events)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Captured Ops' });
    expect(postNetResult(events.slice(0, 1))).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it('reads a waybill Courier IT\'s network answers without as not found', async () => {
    const fetcher = lookup(reply(''));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(carrier(lookup(reply('{"error":"Your tracking session has expired."}', 403))).track({ number: REDELIVERED }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('takes waybills of letters and digits and refuses anything else before a request', async () => {
    expect(normalizeCourierItNumber('ats 122393')).toBe(REDELIVERED);
    expect(normalizeCourierItNumber('pn9124099')).toBe('PN9124099');
    for (const bad of ['122393', 'A1234567', 'CDM12345', 'CDM12345678901', 'X'.repeat(65)]) {
      expect(() => normalizeCourierItNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '122393' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording to its stage and names why the others have none', () => {
    for (const entry of statuses.entries) {
      expect(courierItStage(entry.wording) ?? null, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'courier-it', description: entry.wording }).kind).toBe(entry.stage ? 'mapped' : 'intentional_gap');
      expect(statusMapAnswer({ carrier: 'postnet-za', description: entry.wording }), entry.wording)
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage } : expect.anything());
    }
    expect(courierItStage('Delivery Details - SAMPLE SIGNER')).toBe('delivered');
  });
});
