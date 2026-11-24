import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, planeteCourrierDetailUrl, planeteCourrierListUrl } from './adapter.js';
import { normalizePlaneteCourrierNumber, parsePlaneteCourrierDetail, parsePlaneteCourrierList } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples from archived tracking links, and an invented number.
const DELIVERED = '13749541';
const REDELIVERED = '13458399';
const HANDED_TO_FEDEX = '9381042';
const INVENTED = '19999991';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A fetcher that answers the order's page and the list from these fixtures. */
const tracker = (detail: string, list: string) => vi.fn<typeof fetch>().mockImplementation(async (url) => html(fixture(String(url).endsWith('&detail=true') ? detail : list)));

describe('Planète Courrier numbers', () => {
  it('takes the order number of digits', () => {
    expect(normalizePlaneteCourrierNumber(' 1374 9541 ')).toBe(DELIVERED);
    for (const other of ['', '12345', 'PC13749541', '1'.repeat(11), '1374954%']) {
      expect(() => normalizePlaneteCourrierNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Planète Courrier tracking adapter', () => {
  it('reads the order’s page alone when it has a history', async () => {
    const fetcher = tracker(`detail-${DELIVERED}`, 'list-unknown');
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.planetecourrier.com/fr/suivi-courrier.html?r=${DELIVERED}&detail=true`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'planete-courrier', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('asks the list when the order’s page has no dated step, and reads its notice as not found', async () => {
    const fetcher = tracker('detail-unknown', 'list-unknown');
    await expect(carrier(fetcher).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([planeteCourrierDetailUrl(INVENTED), planeteCourrierListUrl(INVENTED)]);
  });

  it('keeps refusals, error pages, checks and redirects apart from a missing order', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: INVENTED }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>500</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><title>Just a moment...</title></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.planetecourrier.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html><body>Maintenance</body></html>'))).toMatchObject({ kind: 'schema' });
  });
});

describe('Planète Courrier replies', () => {
  it('reads a delivered order: its steps newest first, the depot moved to the location, its wall clocks kept', () => {
    expect(parsePlaneteCourrierDetail(fixture(`detail-${DELIVERED}`), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Livré',
      last_update: null, last_update_local: '2026-11-09T09:52:00', expected_delivery: null, destination_country: 'CA',
      events: [
        { local_time: '2026-11-09T09:52:00', description: 'Livré', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2026-11-06T13:21:00', description: 'Arrivé au centre de tri', location: 'Lachine, QC',
          original_description: 'Arrivé au centre de tri - Lachine, QC', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-11-06T06:05:00', description: 'Commande placée chez Planète Courrier', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads a failed attempt and the booked second one', () => {
    const result = parsePlaneteCourrierDetail(fixture(`detail-${REDELIVERED}`), REDELIVERED)!;
    expect(result.events!.map((event) => [event.local_time, event.stage])).toEqual([
      ['2026-07-03T11:34:00', 'delivered'], ['2026-07-02T16:11:00', 'in_transit'], ['2026-07-02T14:47:00', 'failed_attempt'],
      ['2026-07-02T11:19:00', 'failed_attempt'], ['2026-06-30T20:29:00', 'in_transit'], ['2026-06-30T07:25:00', 'registered'],
    ]);
    const attempt = parsePlaneteCourrierDetail(fixture(`detail-${REDELIVERED}`).replace(/<li\s*>(?:(?!<\/li>)[\s\S])*Livré\s*<\/span>\s*<\/li>/, ''), REDELIVERED);
    expect(attempt).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Retourné au centre de tri - Lachine, QC' });
  });

  it('names FedEx and its number for an order handed over, and keeps FedEx’s scans', () => {
    const result = parsePlaneteCourrierDetail(fixture(`detail-${HANDED_TO_FEDEX}`), HANDED_TO_FEDEX)!;
    expect(result).toMatchObject({ status: 'delivered', delivery_carrier: 'fedex', delivery_tracking_number: '608940108801', destination_country: 'CA' });
    expect(result.events).toHaveLength(17);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2023-05-04T10:30:00', description: 'Livré', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2023-05-04T09:23:00', description: 'Dans un véhicule FedEx pour livraison', stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    // FedEx's delay notice keeps the stage before it.
    expect(result.events!.find((event) => event.description === 'Delay')).not.toHaveProperty('stage');
  });

  it('reads the list: an order’s status, and the notice for a number without an order, expired or never placed', () => {
    expect(parsePlaneteCourrierList(fixture(`list-${DELIVERED}`), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Livrée',
      last_update: null, expected_delivery: null, summary_only: true, events: [],
    });
    expect(() => parsePlaneteCourrierList(fixture('list-unknown'), INVENTED)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePlaneteCourrierList(fixture(`list-${HANDED_TO_FEDEX}`), HANDED_TO_FEDEX)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(parsePlaneteCourrierDetail(fixture('detail-unknown'), INVENTED)).toBeUndefined();
  });

  it('refuses an answer for another order', () => {
    expect(() => parsePlaneteCourrierDetail(fixture(`detail-${DELIVERED}`), '13749542')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePlaneteCourrierList(fixture(`list-${DELIVERED}`), '13749542')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed page', () => {
    const detail = fixture(`detail-${DELIVERED}`);
    const list = fixture('list-unknown');
    for (const changed of [
      '<html><body>Maintenance</body></html>',
      detail.replace('Historique de commande', 'Historique'),
      detail.replace('6 novembre 2026', '6 brumaire 2026'),
      detail.replace(/N&deg; 13749541/, 'Commande 13749541'),
    ]) {
      expect(() => parsePlaneteCourrierDetail(changed, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const changed of [list.replace('Livraisons liées à ce numéro', 'Résultats'), list.replace(/Il n’y aucune commande[^<]*/, 'Erreur')]) {
      expect(() => parsePlaneteCourrierList(changed, INVENTED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('stages every step the tracker showed, and leaves its notices without a stage on purpose', () => {
    for (const { wording, stage } of statuses.entries) {
      const answer = statusMapAnswer({ carrier: 'planete-courrier', providerCode: null, description: wording });
      expect(answer, wording).toEqual(stage ? { kind: 'mapped', stage } : expect.objectContaining({ kind: 'intentional_gap' }));
    }
    expect(statusMapAnswer({ carrier: 'planete-courrier', providerCode: null, description: normalizeStatusWording('Livré') })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});
