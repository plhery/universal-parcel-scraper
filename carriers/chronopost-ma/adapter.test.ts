import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { ChronopostMaTracker } from './adapter.js';
import { CHRONOPOST_MA_ENDPOINT, chronopostMaReply, normalizeChronopostMaNumber, parseChronopostMa } from './parser.js';
import { chronopostMaStage, statusMap } from './status.js';

const NUMBER = 'EW178243201FR';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = () => JSON.parse(text('delivered.json'));
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const response = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const statuses = JSON.parse(text('../statuses.json')) as { entries: { wording: string; stage: string }[] };

describe('Chronopost Maroc tracker', () => {
  it('posts the number as the page does, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new ChronopostMaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(' ew 178 243 201 fr ', { budgetMs: 4000 });
    expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(CHRONOPOST_MA_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1' } });
    expect(JSON.parse(init!.body as string)).toEqual({ SendingNumber: NUMBER, Mode: 2 });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'chronopost-ma', step: 'direct', outcome: 'ok' }));
  });

  it('reads the history newest first on its wall clocks, with places and reasons', () => {
    const result = parseChronopostMa(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Livré',
      last_update: null, last_update_local: '2026-11-05T12:28:00' });
    expect(result.events!.map(event => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-11-05T12:28:00', 'Livré', 'AGENCE CHRONOPOST RABAT', 'delivered'],
      ['2026-11-05T08:52:02', 'En cours de livraison', 'AGENCE CHRONOPOST RABAT', 'out_for_delivery'],
      ['2026-11-05T08:29:40', 'Entrée dans l\'agence d\'arrivée', 'CI-CIMA', 'in_transit'],
      ['2026-11-04T14:53:52', 'Sorti du centre import', 'CI-CIMA', 'in_transit'],
      ['2026-11-04T11:38:59', 'Arrivé au centre Import', 'CI-CIMA', 'in_transit'],
      ['2026-11-04T11:38:59', 'Envoi sorti de l\'agence import (Envoi dédouané)', 'CI-CIMA', 'in_transit'],
    ]);
    expect(result.events!.every(event => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/"Maroc"/);
  });

  it('classifies a wording it does not map by the shared rules', () => {
    const result = parseChronopostMa(changed(d => { d.AllTrackingEvents[0].EventName = 'Tentative de livraison échouée'; }), NUMBER);
    expect(result.current_stage).toBe('failed_attempt');
    expect(result.current_stage_source).toMatch(/^wording:/);
    expect(chronopostMaStage('LIVRÉ')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });

  it('keeps the summary event when the list is empty', () => {
    const result = parseChronopostMa(changed(d => { d.AllTrackingEvents = []; }), NUMBER);
    expect(result.events).toEqual([expect.objectContaining({ local_time: '2026-11-05T12:28:00', description: 'Livré' })]);
  });

  it('reads the relayed 404 as not found and an empty answer the same way', async () => {
    expect(() => chronopostMaReply(500, text('unknown.html'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseChronopostMa({ LastEvent: null, AllTrackingEvents: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('unknown.html'), 500, { 'Content-Type': 'text/html' }));
    await expect(new ChronopostMaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps other failures apart from a missing parcel', async () => {
    const failed = text('unknown.html').replaceAll('404 ()', '503 ()');
    expect(() => chronopostMaReply(500, failed)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => chronopostMaReply(500, '<html><title>Runtime Error</title></html>')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => chronopostMaReply(200, '<html><title>Just a moment...</title></html>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => chronopostMaReply(200, '<html><body>Maintenance</body></html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const status of [403, 429]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('refused', status));
      await expect(new ChronopostMaTracker({ fetcher }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
    }
    const moved = vi.fn<typeof fetch>().mockResolvedValue(response('', 302, { Location: '/' }));
    await expect(new ChronopostMaTracker({ fetcher: moved }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
  });

  it('rejects an answer for another number or with unreadable clocks', () => {
    expect(() => parseChronopostMa(changed(d => { d.AllTrackingEvents[2].SendingNumber = 'EW000000000FR'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseChronopostMa(changed(d => {
      for (const row of [d.LastEvent, ...d.AllTrackingEvents]) { row.AssociatedNumber = row.SendingNumber; row.SendingNumber = 'XX000000000XX'; }
    }), NUMBER).events).toHaveLength(6);
    expect(() => parseChronopostMa(changed(d => { d.AllTrackingEvents[1].EventHour = '095202'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChronopostMa(changed(d => { d.AllTrackingEvents[1].EventDate = '2026-11-05'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChronopostMa(changed(d => { d.AllTrackingEvents[1].EventName = ''; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChronopostMa({ LastEvent: null, AllTrackingEvents: [fixture().LastEvent] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChronopostMa({ events: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses an input that is not one token of letters and digits without a request', async () => {
    for (const raw of ['', 'EW1', 'EW178243201FR/1', 'É'.repeat(10)]) expect(() => normalizeChronopostMaNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ChronopostMaTracker({ fetcher }).fetch('EW1')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every wording it lists, and only those', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    expect(statusMap.stage(null, 'colis perdu')).toBeUndefined();
  });
});
