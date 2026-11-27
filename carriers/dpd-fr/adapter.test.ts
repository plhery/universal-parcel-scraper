import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../app.js';
import type { StepRecord, StepRecorder } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { TrawlClient } from '../../core/transport/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import {
  DPDFranceChallengeError,
  DPDFranceTracker,
  DPDFranceTrackingError,
  adapter,
  dpdFranceTrackingUrl,
  normalizeDPDFranceTrackingNumber,
  parseDPDFranceTrackingHtml,
} from './adapter.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { classifyStatus, statusMap } from './status.js';
import { resultStage } from '../../core/result/resolve.js';

type Row = [date: string, clock: string, description: string, location: string];
type Detail = [label: string, value: string];

// Fully synthetic identifiers paired with provider-shaped HTML. The live suite
// verifies DPD France separately with a privacy-safe wrong-number canary.
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/claim-after-delivery.json', import.meta.url), 'utf8'),
) as {
  outboundNumber: string;
  returnNumber: string;
  outboundDetails: Detail[];
  returnDetails: Detail[];
  outboundRows: Row[];
  returnRows: Row[];
  privateSections: Record<string, string>;
};
const TEST_TRACKING_NUMBER = FIXTURE.outboundNumber;
const TEST_RETURN_NUMBER = FIXTURE.returnNumber;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function detailsBlock(id: string, details: Detail[]): string {
  const rows = details.map(([label, value]) => (
    `<ul class="tableInfosAR"><li><strong>${label}</strong></li><li class="tdInfos">${value}</li></ul>`
  )).join('');
  return `<div id="${id}">${rows}</div>`;
}

function traceRows(className: string, rows: Row[]): string {
  return rows.map(([date, clock, description, location]) => (
    `<tr class="${className}"><td>${date}</td><td>${clock}</td><td>${description}</td><td>${location}</td></tr>`
  )).join('');
}

function trackingFixture(overrides: {
  outboundNumber?: string;
  outboundRows?: Row[];
  outboundDetails?: Detail[];
  /** The number the page binds to its outbound tab, the one it was asked for. */
  tab?: string;
} = {}): string {
  const outboundNumber = overrides.outboundNumber ?? TEST_TRACKING_NUMBER;
  const outboundDetails = (overrides.outboundDetails ?? FIXTURE.outboundDetails)
    .map(([label, value]): Detail => (label === 'N° colis' ? [label, outboundNumber] : [label, value]));
  const privateSections = Object.entries(FIXTURE.privateSections)
    .map(([id, value]) => `<div id="${id}">${value}</div>`).join('');
  const tab = overrides.tab ? `<div id="btnOngletAller" class="ongletInfo ongletInfoActif" data-colis="${overrides.tab}">Informations</div>` : '';
  return `<!doctype html><html><body>
    ${tab}
    <div id="iconsAller">
      <span class="infosTitle parcelNumberAller">Votre colis ${outboundNumber}</span>
    </div>
    <span class="parcelNumberRetour">Votre colis ${TEST_RETURN_NUMBER}</span>
    ${detailsBlock('infos1', outboundDetails)}
    ${detailsBlock('infos2', FIXTURE.returnDetails)}
    <table id="tableTrace">
      ${traceRows('tabTraceColisAller', overrides.outboundRows ?? FIXTURE.outboundRows)}
      ${traceRows('tabTraceColisRetour', FIXTURE.returnRows)}
    </table>
    ${privateSections}
  </body></html>`;
}

function recordingRecorder(): { recorder: StepRecorder; steps: StepRecord[] } {
  const steps: StepRecord[] = [];
  return { steps, recorder: { step: (record) => { steps.push(record); }, lookup() {} } };
}

afterEach(() => vi.restoreAllMocks());

/** Synthetic: another DPD unit's fourteen digits, as DPD's group service answers for them. */
const GROUP_NUMBER = '06080000000001';

/** DPD's group guest service answering for GROUP_NUMBER, placed in `countryCode` with `description` as its status. */
function groupReply(countryCode: string, description: string) {
  const details = JSON.parse(readFileSync(new URL('../dpd/fixtures/delivered-unverified.json', import.meta.url), 'utf8')) as
    { parcelNumber: string; status: Record<string, unknown> };
  expect(details.parcelNumber).toBe(GROUP_NUMBER);
  Object.assign(details.status, { countryCode, description });
  return vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ fid: 'unit-test-fid', authToken: { token: 'installation-token', expiresIn: '604800s' } }))
    .mockResolvedValueOnce(Response.json({ entries: { basic_dpd_token: 'dW5pdDp0ZXN0' } }))
    .mockResolvedValueOnce(Response.json({ access_token: 'unit-test-access-token', expires_in: 3600 }))
    .mockResolvedValueOnce(Response.json(details));
}

it('reads the depot collection notice as ready for pickup', () => {
  const wording = 'Votre colis est disponible au retrait dans votre agence DPD';
  const result = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: [
    ['08/10/2026', '10:00', wording, 'Agence DPD de Exemple'],
  ] }), TEST_TRACKING_NUMBER);
  expect(result.events?.[0]).toMatchObject({ description: wording, stage: 'ready_for_pickup' });
});

describe('DPD France tracking input', () => {
  it('accepts the official 12-to-15-digit formats and builds the public URL', () => {
    expect(normalizeDPDFranceTrackingNumber('1059 4002 3786 11')).toBe('10594002378611');
    expect(normalizeDPDFranceTrackingNumber('250.999.999.999.980')).toBe(TEST_TRACKING_NUMBER);
    expect(normalizeDPDFranceTrackingNumber('099999999998')).toBe('099999999998');
    expect(dpdFranceTrackingUrl(TEST_TRACKING_NUMBER))
      .toBe(`https://trace.dpd.fr/fr/trace/${TEST_TRACKING_NUMBER}`);
  });

  it('looks a label barcode up by its parcel number when the GS1 check digit matches', () => {
    expect(normalizeDPDFranceTrackingNumber('2509 9999 9999 9801')).toBe(TEST_TRACKING_NUMBER);
    expect(dpdFranceTrackingUrl('2509999999999801'))
      .toBe(`https://trace.dpd.fr/fr/trace/${TEST_TRACKING_NUMBER}`);
    expect(() => normalizeDPDFranceTrackingNumber('2509999999999808')).toThrow('12 to 15 digits');
  });

  it('accepts the eighteen-digit numbers beginning 1660 that DPD France also tracks', () => {
    expect(normalizeDPDFranceTrackingNumber('1660 0000 0000 0000 17')).toBe('166000000000000017');
    expect(dpdFranceTrackingUrl('166000000000000017')).toBe('https://trace.dpd.fr/fr/trace/166000000000000017');
    // Other eighteen-digit numbers, such as a shipper's SSCC, are not DPD France's.
    for (const value of ['166100000000000017', '340000000000000014', '1660000000000000171']) {
      expect(() => normalizeDPDFranceTrackingNumber(value)).toThrow('12 to 15 digits');
    }
  });

  it('rejects unsafe or non-France identifiers', () => {
    for (const value of [
      '25099999999',
      '2509999999999800',
      '350999999999980',
      '25099999999998A',
      '250999999999980?admin=true',
    ]) {
      expect(() => normalizeDPDFranceTrackingNumber(value)).toThrow('12 to 15 digits');
    }
  });
});

describe('DPD France rendered tracking', () => {
  it('parses a provider-shaped fixture and excludes private page sections', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture(), TEST_TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'exception',
      last_status_text: 'Nous avons reçu une réclamation : une enquête est ouverte',
      last_update: '2026-02-12T09:50:00+01:00',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '2026-02-12T09:50:00+01:00',
        location: 'Agence DPD de La Crau (283)',
        description: 'Nous avons reçu une réclamation : une enquête est ouverte',
        stage: 'exception',
        point: { latitude: 43.1512, longitude: 6.0712 },
      },
      {
        time: '2026-01-23T12:45:00+01:00',
        // The cell repeats the delivery, which is no place.
        location: '',
        description: 'Votre colis est livré',
        stage: 'delivered',
      },
      {
        time: '2026-01-23T08:31:00+01:00',
        location: 'Agence DPD de La Crau (283)',
        description: 'Votre colis est en cours de livraison',
        stage: 'out_for_delivery',
        point: { latitude: 43.1512, longitude: 6.0712 },
      },
      {
        time: '2026-01-22T16:16:00+01:00',
        location: 'Centre de tri DPD de Le Coudray (175)',
        description: 'Votre colis est arrivé en France',
        stage: 'in_transit',
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'private-order-reference',
      'Private return event',
      'Private Street',
      'Private Recipient',
      'private@example.test',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('gives an acceptance notice the stage of the scan before it, so a late one moves nothing back', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: [
      ['05/03/2026', '05:11', 'Le destinataire est informé par e-mail de la prise en charge de son colis dans notre réseau', ''],
      ['05/03/2026', '02:59', 'Le destinataire est informé par SMS de la prise en charge de son colis dans notre réseau', ''],
      ['05/03/2026', '02:32', 'Votre colis est en transit dans notre réseau', 'Centre de tri DPD de Exemple (999)'],
      ['04/03/2026', '20:00', 'Votre colis a été pris en charge dans notre réseau', 'Agence DPD de Exemple (998)'],
    ] }), TEST_TRACKING_NUMBER);

    expect(result.status).toBe('in_transit');
    expect(result.events?.map((event) => [event.stage, event.stage_source])).toEqual([
      ['in_transit', 'none'], ['in_transit', 'none'], ['in_transit', undefined], ['accepted', undefined],
    ]);
    const notice = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: [
      ['05/03/2026', '08:00', 'Le destinataire est informé par SMS de la prise en charge de son colis dans notre réseau', ''],
      ['05/03/2026', '07:00', 'Votre colis a été pris en charge dans notre réseau', 'Agence DPD de Exemple (998)'],
    ] }), TEST_TRACKING_NUMBER);
    expect(notice.events?.map((event) => event.stage)).toEqual(['accepted', 'accepted']);
  });

  it("gives the notice of the delivery's current step the stage of the scan before it", () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: [
      ['05/03/2026', '08:48', "Le destinataire est informé par SMS de l'étape actuelle de sa livraison", ''],
      ['05/03/2026', '06:58', 'Votre colis est en cours de livraison', 'Agence DPD de Exemple (998)'],
      ['05/03/2026', '02:32', 'Votre colis est en transit dans notre réseau', 'Centre de tri DPD de Exemple (999)'],
    ] }), TEST_TRACKING_NUMBER);
    expect(result.status).toBe('out_for_delivery');
    expect(result.events?.map((event) => [event.stage, event.stage_source])).toEqual([
      ['out_for_delivery', 'none'], ['out_for_delivery', undefined], ['in_transit', undefined],
    ]);
    const notice = normalizeStatusWording("Le destinataire est informé par SMS de l'étape actuelle de sa livraison");
    expect(statusMap.stage(null, notice)).toBeUndefined();
    expect(statusMap.gapNote?.(null, notice)).toMatch(/current step.*keeps the stage/);
    // So does the notice that the parcel is on its way, which can come during the round.
    const shipped = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: [
      ['05/03/2026', '07:40', "Le destinataire a été notifié par SMS de l'expédition de son colis", ''],
      ['05/03/2026', '07:29', 'Votre colis est en cours de livraison', 'Agence DPD de Exemple (998)'],
    ] }), TEST_TRACKING_NUMBER);
    expect(shipped.status).toBe('out_for_delivery');
    expect(shipped.events?.[0]).toMatchObject({ stage: 'out_for_delivery', stage_source: 'none' });
    expect(shipped.current_stage).toBe('out_for_delivery');
    const shipment = normalizeStatusWording("Le destinataire a été notifié par SMS de l'expédition de son colis");
    expect(statusMap.stage(null, shipment)).toBeUndefined();
    expect(statusMap.gapNote?.(null, shipment)).toMatch(/on its way.*keeps the stage/);
  });

  it('keeps the round\'s stage on the notice of a put-off delivery, until the round\'s own failed attempt', () => {
    const rows: [string, string, string, string][] = [
      ['05/03/2026', '16:32', "Votre colis n'a pas pu être livré, car le destinataire était absent : reprogrammez votre livraison maintenant", 'Agence DPD de Exemple (998)'],
      ['05/03/2026', '13:15', 'Le destinataire est informé par e-mail du report de sa livraison', ''],
      ['05/03/2026', '12:41', 'Le destinataire est informé par SMS du report de sa livraison', ''],
      ['05/03/2026', '06:58', 'Votre colis est en cours de livraison', 'Agence DPD de Exemple (998)'],
    ];
    const result = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: rows }), TEST_TRACKING_NUMBER);
    expect(result.events?.map((event) => [event.stage, event.stage_source])).toEqual([
      ['failed_attempt', undefined], ['out_for_delivery', 'none'], ['out_for_delivery', 'none'], ['out_for_delivery', undefined],
    ]);
    expect(parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: rows.slice(1) }), TEST_TRACKING_NUMBER).current_stage).toBe('out_for_delivery');
    const notice = normalizeStatusWording('Le destinataire est informé par SMS du report de sa livraison');
    expect(statusMap.stage(null, notice)).toBeUndefined();
    expect(statusMap.gapNote?.(null, notice)).toMatch(/put off.*keeps the stage/);
  });

  it('keeps the stage before the notice of the delivery\'s planned day, even with the template\'s word for the day', () => {
    const rows: [string, string, string, string][] = [
      ['05/03/2026', '10:33', 'La livraison de votre colis est programmée Date', 'Agence DPD de Exemple (998)'],
      ['05/03/2026', '06:16', 'Votre colis est en transit dans notre réseau', 'Agence DPD de Exemple (998)'],
    ];
    const result = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: rows }), TEST_TRACKING_NUMBER);
    expect(result.events?.map((event) => [event.stage, event.stage_source])).toEqual([['in_transit', 'none'], ['in_transit', undefined]]);
    const notice = normalizeStatusWording('La livraison de votre colis est programmée Date');
    expect(statusMap.stage(null, notice)).toBeUndefined();
    expect(statusMap.gapNote?.(null, notice)).toMatch(/planned day.*keeps the stage/);
  });

  it('reads a delay on the way, announced before any round, as transit, and the put-off notice after it too', () => {
    const rows: [string, string, string, string][] = [
      ['05/03/2026', '11:30', 'Le destinataire est informé par e-mail du report de sa livraison', ''],
      ['05/03/2026', '11:05', "Votre livraison risque d'être reportée d'un jour ouvré à cause d'un retard d'acheminement", 'Agence DPD de Exemple (998)'],
      ['05/03/2026', '05:20', 'Votre colis est en transit dans notre réseau', 'Agence DPD de Exemple (998)'],
    ];
    const result = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: rows }), TEST_TRACKING_NUMBER);
    expect(result.events?.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'in_transit']);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('reads a round that did not deliver, the notice to book again and the booked day', () => {
    const rows: [string, string, string, string][] = [
      ['05/03/2026', '17:43', 'Les instructions de livraison ont bien été prises en compte. Le destinataire a programmé une nouvelle livraison à son adresse pour le 09.03.2026', ''],
      ['05/03/2026', '17:14', 'Le destinataire est informé par e-mail de la nécessité de reprogrammer sa livraison', ''],
      ['05/03/2026', '17:02', "Votre livraison n'a pas pu être réalisée ce jour, elle est reprogrammée au prochain jour ouvré", 'Agence DPD de Exemple (998)'],
      ['05/03/2026', '06:58', 'Votre colis est en cours de livraison', 'Agence DPD de Exemple (998)'],
    ];
    const booked = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: rows }), TEST_TRACKING_NUMBER);
    expect(booked).toMatchObject({ status: 'in_transit', expected_delivery: '2026-03-09' });
    expect(booked.events?.map((event) => [event.stage, event.stage_source])).toEqual([
      ['in_transit', undefined], ['failed_attempt', 'none'], ['failed_attempt', undefined], ['out_for_delivery', undefined],
    ]);
    // Before the booking, the round that did not deliver is the parcel's state, with no day.
    const failed = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: rows.slice(1) }), TEST_TRACKING_NUMBER);
    expect(failed).toMatchObject({ status: 'exception', expected_delivery: null });
    // A newer scan than the booking takes over, and with it the details block's day, if any.
    const moved = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: [
      ['09/03/2026', '07:10', 'Votre colis est en cours de livraison', 'Agence DPD de Exemple (998)'], ...rows,
    ] }), TEST_TRACKING_NUMBER);
    expect(moved.expected_delivery).not.toBe('2026-03-09');
    const notice = normalizeStatusWording('Le destinataire est informé par e-mail de la nécessité de reprogrammer sa livraison');
    expect(statusMap.stage(null, notice)).toBeUndefined();
    expect(statusMap.gapNote?.(null, notice)).toMatch(/book the delivery again.*keeps the stage/);
    expect(statusMap.stage(null, normalizeStatusWording(rows[2]![2]))).toBe('failed_attempt');
    expect(statusMap.stage(null, normalizeStatusWording(rows[0]![2]))).toBe('in_transit');
  });

  it('reads the driver\'s collection from the sender, beside the acceptance into the network, as accepted', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: [
      ['05/03/2026', '14:48', 'Votre colis a été pris en charge dans notre réseau', 'Agence DPD de Exemple (998)'],
      ['05/03/2026', '14:48', 'Votre colis a été pris en charge par notre livreur', 'Agence DPD de Exemple (998)'],
      ['05/03/2026', '03:55', "Votre colis est en préparation chez l'expéditeur", ''],
    ] }), TEST_TRACKING_NUMBER);
    expect(result.events?.map((event) => event.stage)).toEqual(['accepted', 'accepted', 'registered']);
    expect(statusMap.stage(null, normalizeStatusWording('Votre colis a été pris en charge par notre livreur'))).toBe('accepted');
    // The round's own wording stays the round.
    expect(statusMap.stage(null, normalizeStatusWording('Le chauffeur a pris en charge votre colis'))).toBe('out_for_delivery');
  });

  it('returns every declared capability from one fixture', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({
      outboundRows: FIXTURE.outboundRows.slice(2),
    }), TEST_TRACKING_NUMBER);

    const delivered = parseDPDFranceTrackingHtml(trackingFixture({
      outboundRows: FIXTURE.outboundRows.slice(1),
    }), TEST_TRACKING_NUMBER);

    expect(CAPABILITIES).toEqual(['history', 'location', 'eta', 'delivered_at']);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.expected_delivery).toBe('2026-01-24');
    expect(delivered).toMatchObject({ status: 'delivered', delivered_at: '2026-01-23T12:45:00+01:00' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads the shorter rows and the weight of earlier trace pages', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({
      outboundDetails: [['N° colis', TEST_TRACKING_NUMBER], ['Poids du colis', '1.2 Kg'], ['Livré le', '09/01/2026']],
      outboundRows: [
        ['09/01/2026', '12:37', 'Colis livré', 'Relais Pickup'],
        ['08/01/2026', '16:54', 'Le destinataire est informé que son colis est disponible au point relais Pickup', 'Relais Pickup'],
        ['08/01/2026', '16:53', 'Colis à disposition du destinataire au point relais Pickup', 'Relais Pickup'],
        ['07/01/2026', '10:57', 'Livraison reportée, prise de rendez-vous nécessaire', 'Agence DPD de La Crau (283)'],
        ['06/01/2026', '08:56', 'En attente de vos instructions', ''],
        ['05/01/2026', '17:10', 'Colis refusé, en attente de vos instructions', 'Agence DPD de La Crau (283)'],
        ['05/01/2026', '08:38', 'Colis en livraison', 'Agence DPD de La Crau (283)'],
        ['04/01/2026', '09:32', 'Colis en agence DPD France', 'Agence DPD de La Crau (283)'],
        ['31/12/2025', '10:48', 'Livraison reportée suite à une prise de rendez-vous', 'Agence DPD de La Crau (283)'],
        ['30/12/2025', '04:18', 'Colis en cours d´acheminement', 'Centre de tri DPD de Le Coudray (175)'],
        ['29/12/2025', '15:36', 'Colis en retour vers l\'adresse d\'expédition, en attente de livraison chez l’expéditeur', 'Agence DPD de La Crau (283)'],
        ['28/12/2025', '09:00', 'Colis en préparation chez l´expéditeur', ''],
      ],
    }), '2509999999999801');

    expect(result).toMatchObject({
      status: 'delivered',
      delivered_at: '2026-01-09T12:37:00+01:00',
      weight_kg: 1.2,
    });
    expect(result.events?.map((event) => event.stage)).toEqual([
      'delivered',
      'ready_for_pickup',
      'ready_for_pickup',
      'failed_attempt',
      'exception',
      'exception',
      'out_for_delivery',
      'in_transit',
      'in_transit',
      'in_transit',
      'returned',
      'registered',
    ]);
  });

  it('reads a parcel left at a Pickup point after the recipient was absent as waiting there', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({ outboundRows: [
      ['05/03/2026', '15:36', 'Le destinataire est avisé par SMS de la disponibilté de son colis dans le relais Pickup', ''],
      ['05/03/2026', '14:37', "Le destinataire ne peut être avisé de la disponibilité de son colis dans le relais Pickup car l'envoi de l'e-mail ou SMS a échoué", ''],
      ['05/03/2026', '14:34', 'Votre colis est disponible en relais Pickup, nous en avons informé le destinataire par SMS/e-mail', 'Relais Pickup'],
      ['05/03/2026', '14:32', 'Le destinataire était absent lors du passage de notre livreur, nous avons déposé votre colis en point Pickup', 'Agence DPD de Exemple (998)'],
      ['05/03/2026', '06:58', 'Votre colis est en cours de livraison', 'Agence DPD de Exemple (998)'],
    ] }), TEST_TRACKING_NUMBER);
    expect(result.events?.map((event) => event.stage)).toEqual([
      'ready_for_pickup', 'ready_for_pickup', 'ready_for_pickup', 'failed_attempt', 'out_for_delivery',
    ]);
    // The status says out for delivery for every row waiting at a Pickup point; the newest row's stage leads.
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(resultStage(result)).toBe('ready_for_pickup');
    expect(statusMap.stage(null, normalizeStatusWording(result.events![3]!.description!))).toBe('failed_attempt');
  });

  it('leaves unrecognized wording without a stage and falls back to the newest mapped row', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({
      outboundRows: [
        ['13/02/2026', '07:05', 'Votre colis fait l’objet d’un traitement particulier', 'Agence DPD de La Crau (283)'],
        ...FIXTURE.outboundRows.slice(1),
      ],
    }), TEST_TRACKING_NUMBER);

    const [newest] = result.events ?? [];
    expect(newest?.description).toBe('Votre colis fait l’objet d’un traitement particulier');
    expect(newest && 'stage' in newest).toBe(false);
    // The unmapped row decides nothing: the newest recognized row still does.
    expect(result.status).toBe('delivered');
    expect(result.last_status_text).toBe('Votre colis fait l’objet d’un traitement particulier');
    expect(result).not.toHaveProperty('current_stage');
  });

  it('reports status unknown when no event wording is recognized', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture({
      outboundRows: [
        ['13/02/2026', '07:05', 'Votre colis fait l’objet d’un traitement particulier', 'Agence DPD de La Crau (283)'],
      ],
    }), TEST_TRACKING_NUMBER);

    expect(result.status).toBe('unknown');
    expect(result.events).toEqual([{
      time: '2026-02-13T07:05:00+01:00',
      location: 'Agence DPD de La Crau (283)',
      description: 'Votre colis fait l’objet d’un traitement particulier',
      point: { latitude: 43.1512, longitude: 6.0712 },
    }]);
  });

  it('puts only the delivering depot\'s scans on its map marker', () => {
    const result = parseDPDFranceTrackingHtml(trackingFixture(), TEST_TRACKING_NUMBER);
    const points = result.events?.map((event) => [event.location, event.point ?? null]);

    expect(points).toEqual([
      ['Agence DPD de La Crau (283)', { latitude: 43.1512, longitude: 6.0712 }],
      ['', null],
      ['Agence DPD de La Crau (283)', { latitude: 43.1512, longitude: 6.0712 }],
      // Another depot: the page only places the delivering one.
      ['Centre de tri DPD de Le Coudray (175)', null],
    ]);
  });

  it('lets the delivered scan stored with its status as the location keep its row', () => {
    const scans = (parseDPDFranceTrackingHtml(trackingFixture(), TEST_TRACKING_NUMBER).events ?? []).map((event) => ({
      time: event.time, stage: event.stage ?? '', description: event.description ?? '', location: event.location ?? '', providerCode: '',
    }));
    // What an earlier release stored: the same rows, the delivered one placed at its status.
    const stored = scans.map((scan) => (scan.stage === 'delivered' ? { ...scan, location: 'Livré au destinataire' } : scan));
    const policy = sameInstantIdentityPolicy('dpd-fr', { supportsScanMatching: true })!;
    // As the app matches: one row at the scan's instant, and that row matching no other scan of the batch.
    const takenOver = scans.map((scan) => {
      const rows = stored.filter((row) => row.time === scan.time && policy.matches!(scan, row));
      const others = scans.filter((other) => other.time === scan.time && rows[0] && policy.matches!(other, rows[0]));
      return rows.length === 1 && others.length === 1 ? rows[0]!.location : null;
    });
    // Rows whose location did not change keep their identity and are never asked.
    expect(takenOver).toEqual([null, 'Livré au destinataire', null, null]);
  });

  it('rejects browser challenges, unknown shipments, and mismatched responses', () => {
    expect(() => parseDPDFranceTrackingHtml(
      '<title>Just a moment...</title><p>Performing security verification</p>',
      TEST_TRACKING_NUMBER,
    )).toThrow(DPDFranceChallengeError);
    expect(() => parseDPDFranceTrackingHtml(
      '<p>Nous ne sommes pas en mesure de retrouver le numéro de colis recherché.</p>',
      TEST_TRACKING_NUMBER,
    )).toThrow(DPDFranceTrackingError);
    expect(() => parseDPDFranceTrackingHtml(
      trackingFixture({ outboundNumber: '250999999999999' }),
      TEST_TRACKING_NUMBER,
    )).toThrow('different shipment');
  });

  it('reads the label form of the requested number, which some pages show', () => {
    // The fifteen digits and the GS1 check digit, as a parcel's page shows them.
    const result = parseDPDFranceTrackingHtml(trackingFixture({ outboundNumber: '2509999999999801' }), TEST_TRACKING_NUMBER);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.canonical_tracking_number).toBeUndefined();
  });

  it("answers another DPD unit's number under DPD France's own when tracking, never when recognizing", () => {
    // Synthetic: another unit's fourteen digits, which the page binds to its outbound tab beside DPD France's label.
    const other = '07200000000001';
    const html = trackingFixture({ outboundNumber: '2509999999999801', tab: other });
    expect(parseDPDFranceTrackingHtml(html, other, { aliases: true })).toMatchObject({
      canonical_tracking_number: TEST_TRACKING_NUMBER, events: parseDPDFranceTrackingHtml(html, TEST_TRACKING_NUMBER).events,
    });
    expect(() => parseDPDFranceTrackingHtml(html, other)).toThrow('different shipment');
    // A page bound to another number answers for none.
    expect(() => parseDPDFranceTrackingHtml(trackingFixture({ tab: '07200000000002' }), other, { aliases: true })).toThrow('different shipment');
    expect(() => parseDPDFranceTrackingHtml(trackingFixture(), other, { aliases: true })).toThrow('different shipment');
  });

  it('selects the requested return leg without mixing outbound events', () => {
    const html = `<!doctype html><html><body>
      <span class="parcelNumberAller">Votre colis 10612345678900</span>
      <span class="parcelNumberRetour">Votre colis ${TEST_RETURN_NUMBER}</span>
      <div id="infos1"><ul class="tableInfosAR"><li><strong>N° colis</strong></li><li class="tdInfos">10612345678900</li></ul></div>
      <div id="infos2"><ul class="tableInfosAR"><li><strong>N° colis</strong></li><li class="tdInfos">${TEST_RETURN_NUMBER}</li></ul></div>
      <table id="tableTrace">
        <tr class="tabTraceColisAller"><td>18/11/2024</td><td>12:20</td><td>Votre colis est livré</td><td>Outbound location</td></tr>
        <tr class="tabTraceColisRetour"><td>19/11/2024</td><td>09:01</td><td>Votre colis est en transit dans notre réseau</td><td>Return location</td></tr>
      </table>
    </body></html>`;

    expect(parseDPDFranceTrackingHtml(html, TEST_RETURN_NUMBER)).toMatchObject({
      status: 'in_transit',
      events: [{ location: 'Return location', stage: 'in_transit' }],
    });
    expect(JSON.stringify(parseDPDFranceTrackingHtml(html, TEST_RETURN_NUMBER)))
      .not.toContain('Outbound location');
  });
});

describe('DPD France status vocabulary', () => {
  it('checks returns and incidents before the delivery wording', () => {
    expect(classifyStatus('Votre colis sera retourné à l’expéditeur'))
      .toEqual({ status: 'exception', stage: 'returned' });
    expect(classifyStatus('Votre colis est livré'))
      .toEqual({ status: 'delivered', stage: 'delivered' });
    expect(classifyStatus('Votre colis est disponible en relais'))
      .toEqual({ status: 'out_for_delivery', stage: 'ready_for_pickup' });
  });

  it('reads a round that could not deliver as a failed attempt', () => {
    expect(classifyStatus("Nous n'avons pas pu livrer votre colis"))
      .toEqual({ status: 'exception', stage: 'failed_attempt' });
    expect(classifyStatus("Votre livraison n'a pas pu être réalisée ce jour, elle est reprogrammée au prochain jour ouvré"))
      .toEqual({ status: 'exception', stage: 'failed_attempt' });
  });

  it('holds a parcel whose address the sender must complete, and moves it on once the address is put right', () => {
    expect(classifyStatus("L'adresse de livraison nécessite un complément d'informations de la part de l'expéditeur"))
      .toEqual({ status: 'exception', stage: 'exception' });
    expect(classifyStatus("Les instructions de livraison ont bien été prises en compte. L'adresse de livraison a été complétée ou modifiée"))
      .toEqual({ status: 'in_transit', stage: 'in_transit' });
  });

  it('keeps the same-day delivery notices on the delivery round and gives acceptance notices no stage', () => {
    for (const channel of ['SMS', 'e-mail']) {
      expect(classifyStatus(`Le destinataire est informé par ${channel} de la livraison de son colis ce jour`))
        .toEqual({ status: 'out_for_delivery', stage: 'out_for_delivery' });
      const notice = `Le destinataire est informé par ${channel} de la prise en charge de son colis dans notre réseau`;
      expect(classifyStatus(notice).status).toBe('unknown');
      expect(statusMap.stage(null, normalizeStatusWording(notice))).toBeUndefined();
      expect(statusMap.gapNote?.(null, normalizeStatusWording(notice))).toMatch(/keeps the stage/);
    }
    expect(statusMap.gapNote?.(null, normalizeStatusWording('Votre colis a été pris en charge dans notre réseau'))).toBeUndefined();
    expect(classifyStatus('Votre colis a été pris en charge dans notre réseau'))
      .toEqual({ status: 'in_transit', stage: 'accepted' });
    // The driver taking the parcel over is still the delivery round.
    expect(classifyStatus('Le chauffeur a pris en charge votre colis'))
      .toEqual({ status: 'out_for_delivery', stage: 'out_for_delivery' });
  });
});

describe('DPD France transport tiers', () => {
  it('uses direct HTTP when Cloudflare permits it', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      trackingFixture(),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ));
    const { recorder, steps } = recordingRecorder();

    await expect(new DPDFranceTracker({ timeoutMs: 2_000, trawl: null, recorder })
      .fetch(TEST_TRACKING_NUMBER)).resolves.toMatchObject({
        status: 'exception',
        tracking_url: dpdFranceTrackingUrl(TEST_TRACKING_NUMBER),
        tracking_source: 'rendered-page',
      });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(dpdFranceTrackingUrl(TEST_TRACKING_NUMBER));
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      cache: 'no-store',
      redirect: 'follow',
    });
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'ok']]);
  });

  it('asks the browser service at once, with the same TRAWL scrape protocol used for UPS', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        html: trackingFixture(),
        cookies: [],
      }), { headers: { 'Content-Type': 'application/json' } }));
    const { recorder, steps } = recordingRecorder();

    await expect(new DPDFranceTracker({
      timeoutMs: 2_000,
      trawl: new TrawlClient('http://trawl.internal:8191/v1'),
      recorder,
    }).fetch(TEST_TRACKING_NUMBER)).resolves.toMatchObject({ status: 'exception' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://trawl.internal:8191/scrape');
    const trawlRequest = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(trawlRequest).toEqual({
      url: dpdFranceTrackingUrl(TEST_TRACKING_NUMBER),
      skipHttp: true,
      maxTier: 3,
      maxTimeout: 2_000,
    });
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['trawl', 'ok']]);
  });

  it('gives the browser tier the caller\'s signal and what is left of the budget', async () => {
    let reached!: () => void;
    const browserRequest = new Promise<void>((resolve) => { reached = resolve; });
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce((_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
        reached();
      }));
    const controller = new AbortController();
    const cancelled = new Error('caller cancelled');

    const lookup = new DPDFranceTracker({ timeoutMs: 60_000, trawl: new TrawlClient('http://trawl.internal:8191/v1') })
      .fetch(TEST_TRACKING_NUMBER, { signal: controller.signal, budgetMs: 30_000 });
    await browserRequest;
    controller.abort(cancelled);

    await expect(lookup).rejects.toBe(cancelled);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).maxTimeout).toBeLessThanOrEqual(30_000);
  });

  it('retries a GET that hangs once, inside the budget, but not an unknown parcel', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: 300, reply: () => new Response(trackingFixture()) }]);
    const { recorder, steps } = recordingRecorder();
    const lookup = new DPDFranceTracker({ fetcher, trawl: null, recorder }).fetch(TEST_TRACKING_NUMBER, { budgetMs: 30_000 });
    await vi.advanceTimersByTimeAsync(15_300);
    await expect(lookup).resolves.toMatchObject({ status: 'exception' });
    expect(ended).toEqual([15_000, 15_300]);
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([['direct', 'transport'], ['retry', 'ok']]);
    const unknown = delayedFetcher([{ afterMs: 10,
      reply: () => new Response('<p>Nous ne sommes pas en mesure de retrouver le numéro de colis recherché.</p>') }]);
    const missing = expect(new DPDFranceTracker({ fetcher: unknown.fetcher, trawl: null }).fetch(TEST_TRACKING_NUMBER))
      .rejects.toBeInstanceOf(DPDFranceTrackingError);
    await vi.advanceTimersByTimeAsync(10);
    await missing;
    expect(unknown.fetcher).toHaveBeenCalledOnce();
  });

  it('surfaces an actionable error when no browser solver is configured', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<title>Just a moment...</title>',
      { status: 403, headers: { 'CF-Mitigated': 'challenge' } },
    ));
    const { recorder, steps } = recordingRecorder();

    await expect(new DPDFranceTracker({ timeoutMs: 2_000, trawl: null, recorder })
      .fetch(TEST_TRACKING_NUMBER)).rejects.toThrow('configure FLARESOLVERR_URL');
    // The missing tier is a disabled step, not a failed one.
    expect(steps.map((step) => step.step)).toEqual(['direct']);
  });
});

describe('DPD France adapter factory', () => {
  it('declares both tiers and tracks through the direct page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(trackingFixture()));
    const { recorder } = recordingRecorder();
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder, env: {} });

    expect(instance.id).toBe('dpd-fr');
    expect(instance.steps).toEqual(['direct', 'retry', 'trawl']);
    await expect(instance.track({ number: TEST_TRACKING_NUMBER }))
      .resolves.toMatchObject({ status: 'exception' });
  });

  it('confirms a number in browser recognition only, from the dated rows the browser service shows', async () => {
    const trawl = new TrawlClient('http://trawl.internal:8191/v1');
    const scraped = (html: string) => new Response(JSON.stringify({ tier: 3, statusCode: 200, html, cookies: [] }),
      { headers: { 'Content-Type': 'application/json' } });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(scraped(trackingFixture()));
    const instance = adapter({ trawl, browserExecutablePath: null, recorder: recordingRecorder().recorder, env: {} });

    const known = await instance.recognizeWithBrowser!(TEST_TRACKING_NUMBER, { budgetMs: 30_000 });
    expect(known).toMatchObject({ known: true, lastActivityAt: expect.any(String) });
    expect(known.result?.events?.length).toBeGreaterThan(0);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://trawl.internal:8191/scrape');

    fetcher.mockResolvedValueOnce(scraped('<p>Nous ne sommes pas en mesure de retrouver le numéro de colis recherché.</p>'));
    await expect(instance.recognizeWithBrowser!(TEST_TRACKING_NUMBER, { budgetMs: 30_000 })).resolves.toEqual({ known: false, lastActivityAt: null });

    // A number DPD France does not issue is not asked.
    await expect(instance.recognizeWithBrowser!('ABC', { budgetMs: 30_000 })).resolves.toEqual({ known: false, lastActivityAt: null });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Another unit's number answered under DPD France's own tracks the parcel; recognition still finds no parcel of that number.
    const other = '07200000000001';
    const aliased = () => scraped(trackingFixture({ outboundNumber: '2509999999999801', tab: other }));
    fetcher.mockResolvedValueOnce(aliased());
    await expect(instance.track({ number: other }, { budgetMs: 30_000 })).resolves.toMatchObject({ canonical_tracking_number: TEST_TRACKING_NUMBER });
    fetcher.mockResolvedValueOnce(aliased());
    await expect(instance.recognizeWithBrowser!(other, { budgetMs: 30_000 })).rejects.toThrow('different shipment');
  });

  it('is a browser recognition candidate for the ex-Exapaq depots\' fourteen digits only, never an HTTP one', () => {
    // Synthetic: a 10xx depot's fourteen digits.
    const number = '10080000000001';
    expect(recognitionCandidates(number).map((candidate) => candidate.carrier)).not.toContain('dpd-fr');
    // Another unit's fourteen digits are asked over HTTP, of DPD's group service, and never in a browser.
    expect(recognitionCandidates(GROUP_NUMBER).map((candidate) => candidate.carrier)).toContain('dpd-fr');
    expect(recognitionCandidates(GROUP_NUMBER, { phase: 'browser' }).map((candidate) => candidate.carrier)).not.toContain('dpd-fr');
    expect(recognitionCandidates(number, { phase: 'browser' }).map((candidate) => candidate.carrier)).toContain('dpd-fr');
    // Other runs of digits its rules suggest are more often other carriers': no browser lookup is spent on them.
    expect(recognitionCandidates('100800000000', { phase: 'browser' }).map((candidate) => candidate.carrier)).not.toContain('dpd-fr');
  });

  it('recognizes another DPD unit\'s number once DPD\'s group service places the parcel at a French delivery depot', async () => {
    const fetcher = groupReply('FR', 'PARCEL_OUT_FOR_DELIVERY');
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder: recordingRecorder().recorder, env: {} });
    await expect(instance.recognize!(GROUP_NUMBER, { budgetMs: 15_000 })).resolves.toEqual({ known: true });
    // Belgium's unit asks the group's service, as for DPD Ireland.
    expect(String(fetcher.mock.calls[3]![0])).toContain('businessUnit=DPD-BE');
  });

  it('leaves a parcel DPD places in another country to that country\'s unit', async () => {
    groupReply('DE', 'PARCEL_OUT_FOR_DELIVERY');
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder: recordingRecorder().recorder, env: {} });
    await expect(instance.recognize!(GROUP_NUMBER, { budgetMs: 15_000 })).resolves.toEqual({ known: false });
  });

  it('keeps a parcel in France before its delivery depot inconclusive: the country can still be the sender\'s', async () => {
    groupReply('FR', 'IN_TRANSIT');
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder: recordingRecorder().recorder, env: {} });
    await expect(instance.recognize!(GROUP_NUMBER, { budgetMs: 15_000 })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('leaves DPD France\'s own numbers to the trace page and asks nothing for a number it does not issue', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const instance = adapter({ trawl: null, browserExecutablePath: null, recorder: recordingRecorder().recorder, env: {} });
    await expect(instance.recognize!('10080000000001', { budgetMs: 15_000 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(instance.recognize!('84000000000001', { budgetMs: 15_000 })).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
