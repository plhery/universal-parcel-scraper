import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeStatusWording, statusMapAnswer } from '../../app.js';
import { seventeenTrackEvent } from '../../providers/seventeentrack/events.js';
import { event } from '../../providers/shared/result.js';
import { statusMap as universal } from '../../providers/status.js';
import type { CarrierEvent } from '../result/index.js';
import type { CarrierStatusMap } from '../status/statusMap.js';
import { classifyWording } from '../status/wording.js';
import { STATUS_MAPS } from './statusMaps.js';

const carriers = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../carriers');
const answer = (carrier: string, providerCode: string | null, description: string) => statusMapAnswer({ carrier, providerCode, description });
const mapped = (stage: string) => ({ kind: 'mapped', stage });
const gap = { kind: 'intentional_gap', note: expect.any(String) };
const unknown = { kind: 'unknown' };

describe('status map answers', () => {
  it('normalizes wording as the app keys its observations', () => {
    expect(normalizeStatusWording('  Parcel\thanded   to DPD\n')).toBe('parcel handed to dpd');
    const long = `${'A'.repeat(499)} B C`;
    expect(normalizeStatusWording(long)).toBe(`${'a'.repeat(499)} `);
    // Stored wording can be asked again as it is.
    expect(normalizeStatusWording('parcel handed to dpd')).toBe('parcel handed to dpd');
  });

  it("answers DPD's codes, and the codes and labels it leaves unmapped on purpose", () => {
    expect(answer('dpd', 'DLO', 'Your parcel is out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('dpd', 'HUI', 'Your parcel arrived at our hub')).toEqual(mapped('in_transit'));
    expect(answer('dpd', 'DELIVERED', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('dpd', 'PARCEL_HANDED', 'Parcel handed to DPD')).toEqual({
      kind: 'intentional_gap',
      note: "DPD's map leaves it unmapped on purpose: it moves the parcel in transit without a milestone of its own.",
    });
    for (const code of ['IN_TRANSIT', 'AT_DELIVERY_CENTER', 'ORI', 'SPL', 'OTHER', 'SPE', 'MSDLO', 'MIDLI', 'ENA']) {
      expect(answer('dpd', code, 'Any wording at all'), code).toEqual(gap);
    }
    // A label gap covers that wording without a code, and only then.
    expect(answer('dpd', null, '  Your parcel is ON its way')).toEqual({
      kind: 'intentional_gap', note: "The label of IN_TRANSIT, which DPD's map leaves unmapped on purpose.",
    });
    expect(answer('dpd', 'ZZZ', 'Your parcel is on its way')).toEqual(unknown);
    // A code gap covers no wording that came without the code.
    expect(answer('dpd', null, 'Your parcel arrived at our depot')).toEqual(unknown);
    expect(answer('dpd', null, 'Parcel out for delivery')).toEqual(unknown);
  });

  it("answers DPD Germany's app scans by their wording, and its guest API by DPD's codes", () => {
    expect(answer('dpd-de', null, 'Picked up from Pickup parcelshop by consignee.')).toEqual(mapped('delivered'));
    expect(answer('dpd-de', null, 'delivered by driver to dpd pickup parcelshop/ station.')).toEqual(mapped('ready_for_pickup'));
    expect(answer('dpd-de', null, 'Pickup ordered for: 05.01.2026')).toEqual(mapped('registered'));
    expect(answer('dpd-de', null, 'Parcel handed to DPD')).toEqual(mapped('accepted'));
    expect(answer('dpd-de', 'DLO', 'Your parcel is out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('dpd-de', 'PARCEL_HANDED', 'Parcel handed to DPD')).toEqual(gap);
    // The Swiss page's labels are not read for German lookups.
    expect(answer('dpd-de', null, 'Your parcel is on its way')).toEqual(unknown);
    expect(answer('dpd-de', null, 'Picked up')).toEqual(unknown);
  });

  it('answers the other declared maps by their own keys', () => {
    expect(answer('tnt', 'RES', 'Shipment delivered in good condition')).toEqual(mapped('delivered'));
    expect(answer('tnt', null, 'Livré')).toEqual(mapped('delivered'));
    expect(answer('tnt', 'ZZ', 'Shipment delivered in good condition')).toEqual(unknown);
    expect(answer('postlogistics', 'DLV', 'Livré')).toEqual(mapped('delivered'));
    expect(answer('postlogistics', 'IMG', 'IMAGE')).toEqual(gap);
    expect(answer('postlogistics', null, 'Image')).toEqual(unknown);
    expect(answer('ups', 'OF', 'Out For Delivery Today')).toEqual(mapped('out_for_delivery'));
    // Without a code, UPS's map reads only the rendered page's banner.
    expect(answer('ups', null, 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('ups', null, 'Arrived at Facility')).toEqual(unknown);
    expect(answer('ups', 'ZZ', 'Delivered')).toEqual(unknown);
    expect(answer('yunexpress', null, 'Arrived at GOFO Regional Destination Facility')).toEqual(mapped('in_transit'));
    expect(answer('yunexpress', null, 'REMINDER EMAIL SENT FAILED')).toEqual(gap);
    expect(answer('dhl-express', 'PL', 'Processed at EXAMPLE CITY - FRANCE')).toEqual(mapped('in_transit'));
    expect(answer('dhl-express', null, 'Synthetic checkpoint')).toEqual(unknown);
    expect(answer('speedx', '57104', 'Out for Delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('speedx', '50001', 'Shipping Label Created')).toEqual(mapped('registered'));
    // A code SpeedX's map does not list is staged by its event's category, which the code alone lacks.
    expect(answer('speedx', '57999', 'Synthetic scan')).toEqual(unknown);
    expect(answer('speedx', null, 'Delivered')).toEqual(unknown);
    expect(answer('j-and-t', '94', 'Package will be delivered')).toEqual(mapped('out_for_delivery'));
    expect(answer('j-and-t', '210', 'Pick-Up')).toEqual(mapped('accepted'));
    // Every router scan carries its code, which alone gives the stage.
    expect(answer('j-and-t', null, 'Delivered')).toEqual(unknown);
    expect(answer('j-and-t', '999', 'Delivered')).toEqual(unknown);
  });

  it("answers La Poste by the group and code it reads, for every carrier its adapter serves", () => {
    const sort = 'Votre envoi est sur son site de distribution. Nous le préparons pour le mettre en livraison.';
    expect(answer('la-poste', 'DISTOU/MD1', sort)).toEqual(mapped('out_for_delivery'));
    expect(answer('delivengo', 'DISTOU/MD1', sort)).toEqual(mapped('out_for_delivery'));
    expect(answer('la-poste', 'AG1', 'Votre colis vous attend')).toEqual(mapped('ready_for_pickup'));
    expect(answer('la-poste', 'DISARR', 'Votre colis est en cours d’acheminement')).toEqual(mapped('in_transit'));
    // Under keys the map does not read, the stage comes from wording and a default.
    expect(answer('la-poste', null, 'Votre colis vous attend dans votre point de retrait')).toEqual(unknown);
    expect(answer('la-poste', 'XYZ/ZZ9', sort)).toEqual(unknown);
  });

  it('keeps Chronopost codes to the wording seen with them, and its notice is a gap', () => {
    expect(answer('chronopost', 'DC', "Colis en cours de préparation chez l'expéditeur")).toEqual(mapped('registered'));
    expect(answer('chronopost', 'DC', 'Colis livré')).toEqual(unknown);
    expect(answer('chronopost', 'TA', 'Colis en cours de livraison')).toEqual(mapped('out_for_delivery'));
    expect(answer('chronopost', 'RB', 'Colis en cours de livraison au point de retrait')).toEqual(mapped('in_transit'));
    expect(answer('chronopost', 'AB', 'Colis mis à disposition au point de retrait')).toEqual(mapped('ready_for_pickup'));
    expect(answer('chronopost', 'TA', 'Colis en cours de livraison par le livreur')).toEqual(unknown);
    expect(answer('chronopost', 'SM', 'Destinataire informé par SMS ou mail')).toEqual(gap);
    expect(answer('chronopost', 'SM', 'Autre message')).toEqual(unknown);
  });

  it('reads the last segment of a Swiss Post code, and a revoked scan has no stage', () => {
    expect(answer('swiss-post', 'LETTER.*.106.859', 'Your shipment will shortly be handed over to the Swiss Post')).toEqual(mapped('registered'));
    expect(answer('swiss-post', 'LETTER.*.93.9112', 'Enquiry initiated')).toEqual(gap);
    expect(answer('swiss-post', 'PARCEL.*.1.4000', 'Delivered — Revocation')).toEqual(unknown);
    expect(answer('swiss-post', 'PARCEL.*.1.9224', 'Order triggered by recipient: forward')).toEqual(gap);
    expect(answer('swiss-post', 'LETTER.*.90.1800', 'Delay')).toEqual(gap);
    expect(answer('swiss-post', 'PARCEL.*.0.501', 'Picked up at the client')).toEqual(mapped('accepted'));
    expect(answer('swiss-post', 'PARCEL.*.1.502', 'Picked up')).toEqual(mapped('accepted'));
    expect(answer('swiss-post', 'PARCEL.*.1.9999', 'Synthetic scan')).toEqual(unknown);
  });

  it("answers Cainiao's action codes, and the wording the queue holds without one", () => {
    expect(answer('aliexpress', 'TD_TRANS_ARRIVE_DCP', 'Awaiting for transit to final delivery office')).toEqual(mapped('in_transit'));
    expect(answer('aliexpress', 'GTMS_SIGNED', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('aliexpress', 'GWMS_ACCEPT', 'Shipment accepted by the warehouse')).toEqual(mapped('registered'));
    expect(answer('aliexpress', 'GTMS_DEL_FAILURE', 'Delivery attempt failed')).toEqual(mapped('failed_attempt'));
    expect(answer('aliexpress', 'GTMS_STA_SIGN_FAILURE', 'Synthetic failure')).toEqual(mapped('exception'));
    for (const wording of ['Handed over from linehaul office', 'Leaving transit country/region',
      'Awaiting for transit to final delivery office', '[Exampleville] Departed from destination country/region sorting center']) {
      expect(answer('aliexpress', null, wording), wording).toEqual(mapped('in_transit'));
    }
    expect(answer('aliexpress', 'GTMS_DO_DEPART', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('aliexpress', 'NEW_UNSEEN_CODE', 'Synthetic scan')).toEqual(unknown);
    expect(answer('aliexpress', null, 'Arrived at linehaul office')).toEqual(unknown);
  });

  it("answers DPD France's wording, the only key its trace page has", () => {
    expect(answer('dpd-fr', null, 'Votre colis a été pris en charge dans notre réseau')).toEqual(mapped('accepted'));
    expect(answer('dpd-fr', null, 'Le destinataire est informé par SMS de la prise en charge de son colis dans notre réseau'))
      .toEqual(mapped('accepted'));
    expect(answer('dpd-fr', null, 'Le destinataire est informé par e-mail de la livraison de son colis ce jour'))
      .toEqual(mapped('out_for_delivery'));
    expect(answer('dpd-fr', null, 'Synthetic wording')).toEqual(unknown);
    expect(answer('dpd-fr', 'DLO', 'Votre colis est livré')).toEqual(unknown);
  });

  it("answers Correos by its event code, and its office hold without one", () => {
    expect(answer('correos-spain', 'G01L020V', 'A disposición del destinatario')).toEqual(mapped('ready_for_pickup'));
    expect(answer('correos-spain', null, 'A disposición del destinatario')).toEqual(mapped('ready_for_pickup'));
    expect(answer('correos-spain', 'A010000V', 'Admitido.')).toEqual(mapped('accepted'));
    expect(answer('correos-spain', 'Z999999Z', 'A disposición del destinatario')).toEqual(unknown);
    expect(answer('correos-spain', null, 'Admitido.')).toEqual(unknown);
  });

  it("answers Thailand Post's scan codes, and leaves its call and COD payment out on purpose", () => {
    expect(answer('thailand-post', '3', 'Posting/Collection [ EXAMPLE Posting Center ]')).toEqual(mapped('accepted'));
    expect(answer('thailand-post', '31', 'Out for delivery [ EXAMPLE Post Office ]')).toEqual(mapped('out_for_delivery'));
    expect(answer('thailand-post', '28', 'Return to the origin post office')).toEqual(mapped('exception'));
    expect(answer('thailand-post', '57', 'Contact recipient')).toEqual(gap);
    expect(answer('thailand-post', '36', 'Successfully transfer money to seller')).toEqual(gap);
    // A final delivery reads its delivery result, and a utility row its status group.
    expect(answer('thailand-post', '35', 'Successful delivery [ EXAMPLE Post Office ]')).toEqual(unknown);
    expect(answer('thailand-post', '34', 'Item held,addressee notified due to Payment of charges')).toEqual(unknown);
    expect(answer('thailand-post', null, 'Contact recipient')).toEqual(unknown);
    expect(answer('thailand-post', 'toString', 'Synthetic scan')).toEqual(unknown);
  });

  it("answers STO's scan types by the wording stored for them, on the way out and back", () => {
    expect(answer('sto', '派件', 'Out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('sto', '发件', 'Departed for Example hub')).toEqual(mapped('in_transit'));
    expect(answer('sto', '签收', 'Delivered')).toEqual(mapped('delivered'));
    expect(answer('sto', '签收', 'Returned to the sender')).toEqual(mapped('returned'));
    expect(answer('sto', '派件', 'Out for delivery back to the sender')).toEqual(mapped('out_for_delivery'));
    expect(answer('sto', '退回件', 'Return to the sender started')).toEqual(mapped('exception'));
    expect(answer('sto', '派件', 'Delivered')).toEqual(unknown);
    expect(answer('sto', '问题件', '问题件')).toEqual(unknown);
    expect(answer('sto', null, 'Delivered')).toEqual(unknown);
  });

  it("answers An Post's trace codes, narrowed by wording, and its delivery attempt by the website's wording", () => {
    expect(answer('an-post', '70', 'Your item is now available for collection')).toEqual(mapped('ready_for_pickup'));
    expect(answer('an-post', '35', 'We have received information about your incoming item from the sender')).toEqual(mapped('registered'));
    expect(answer('an-post', '83', 'Synthetic customs wording')).toEqual(mapped('customs'));
    // The app's broad in-transit and return categories take a narrower stage from wording.
    expect(answer('an-post', '1', 'Synthetic scan')).toEqual(mapped('in_transit'));
    expect(answer('an-post', '1', 'Your item is out for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('an-post', '53', 'Synthetic scan')).toEqual(mapped('returned'));
    // Code 52 at a post office waits there for collection; at any other office it stays the app's sorting.
    expect(answer('an-post', '52', 'Your delivery is in SYNTHETIC TOWN, POST OFFICE')).toEqual(mapped('ready_for_pickup'));
    expect(answer('an-post', '52', 'Your delivery is in SYNTHETIC MAIL CENTRE')).toEqual(mapped('in_transit'));
    expect(answer('an-post', '16', 'Your item was delivered')).toEqual(mapped('delivered'));
    expect(answer('an-post', '16', 'We attempted to deliver your item')).toEqual(mapped('failed_attempt'));
    // Codes the map does not know, and wording without a code, stay open for review.
    expect(answer('an-post', '9999', 'Your item has been delivered')).toEqual(unknown);
    expect(answer('an-post', '014', 'Your item has been delivered')).toEqual(unknown);
    expect(answer('an-post', null, 'Your item has been delivered')).toEqual(unknown);
  });

  it("answers China Post by its scan code, and by the state label that replaced a scan's text", () => {
    expect(answer('china-post', '461', '已到达【美国】投递局')).toEqual(mapped('in_transit'));
    expect(answer('china-post', 'EXB', '出口海关/留存待验')).toEqual(mapped('customs'));
    // The code decides: a delivery attempt keeps its stage under the label 运送中.
    expect(answer('china-post', '542', '运送中')).toEqual(mapped('failed_attempt'));
    expect(answer('china-post', '711', '已退回')).toEqual(mapped('returned'));
    // The acceptance dated from the collector record has no code.
    expect(answer('china-post', null, '已揽收')).toEqual(mapped('accepted'));
    expect(answer('china-post', '999', '已签收')).toEqual(mapped('delivered'));
    // An unmapped code with the scan's own text is staged by a label the key does not hold.
    expect(answer('china-post', '999', '【美国】已妥投')).toEqual(unknown);
    expect(answer('china-post', null, 'Delivered')).toEqual(unknown);
  });

  it('answers Old Dominion by its status, which is its provider code', () => {
    expect(answer('old-dominion', 'In Transit', 'Arrived at EXAMPLE CITY, ST (ABC)')).toEqual(mapped('in_transit'));
    expect(answer('old-dominion', 'Returned To Dock', 'Returned To Dock')).toEqual(mapped('in_transit'));
    expect(answer('old-dominion', 'Pickup Confirmed', 'Pickup Confirmed')).toEqual(mapped('registered'));
    expect(answer('old-dominion', 'Agent Handoff', 'Agent Handoff')).toEqual(mapped('out_for_delivery'));
    expect(answer('old-dominion', 'Delivery Confirmed', 'Delivery Confirmed')).toEqual(mapped('delivered'));
    expect(answer('old-dominion', 'Synthetic Status', 'Synthetic Status')).toEqual(unknown);
    // Every scan of the trace service carries its status.
    expect(answer('old-dominion', null, 'Delivered')).toEqual(unknown);
  });

  it.each(['app', '', 'hongkong-post', '__proto__', 'toString', 'Unknown'])('does not know %s', (carrier) => {
    expect(answer(carrier, 'DLO', 'Delivered')).toEqual(unknown);
  });

  it('does not know a scan without wording', () => {
    expect(answer('dpd', 'DLO', '   ')).toEqual(unknown);
  });
});

describe("universal providers' answers", () => {
  const TIME = '2026-01-01T12:00:00Z';

  it('answer by the wording rules the providers apply, as the app files their scans under unknown', () => {
    expect(answer('unknown', null, 'Processed at EXAMPLE CITY - FRANCE')).toEqual(mapped('in_transit'));
    expect(answer('unknown', null, 'Shipment information received')).toEqual(mapped('registered'));
    expect(answer('unknown', null, 'Clearance processing complete at EXAMPLE GATEWAY - USA')).toEqual(mapped('in_transit'));
    expect(answer('unknown', null, "  Colis en préparation chez l'expéditeur ")).toEqual(mapped('registered'));
    expect(answer('unknown', null, 'Delivered')).toEqual(mapped('delivered'));
    // Wording no rule reads, and a delivery still to come, stay open as gaps.
    expect(answer('unknown', null, 'Estado interno 99')).toEqual(unknown);
    expect(answer('unknown', null, 'Will be delivered tomorrow')).toEqual(unknown);
    expect(answer('unknown', null, '   ')).toEqual(unknown);
  });

  it("answer by the providers' own reading, not the generic classifier's keyword rules", () => {
    // Posti's repeated handling scan, which the providers read before the shared rules.
    expect(classifyWording('The item has been registered').stage).toBe('registered');
    expect(answer('unknown', null, 'The item has been registered')).toEqual(mapped('in_transit'));
    // The providers leave a bare "Returned" unread, so the sync stores it unstaged.
    expect(classifyWording('Returned').source).toBe('wording:returned');
    expect(answer('unknown', null, 'Returned')).toEqual(unknown);
  });

  it('let a 17TRACK sub-status outrank the wording where the sync does', () => {
    expect(answer('unknown', 'Exception_Cancel', 'Estado interno 99')).toEqual(mapped('exception'));
    expect(answer('unknown', 'Exception_Returned', 'Delivered')).toEqual(mapped('returned'));
    expect(answer('unknown', 'InfoReceived', 'Shipping label created')).toEqual(mapped('registered'));
    expect(answer('unknown', 'InTransit_PickedUp', 'Processed at EXAMPLE HUB')).toEqual(mapped('accepted'));
    // Generic transit yields to any reading of the wording, and a delivery code
    // to wording that does not read as delivered.
    expect(answer('unknown', 'InTransit_Other', 'Arrived at customs')).toEqual(mapped('customs'));
    expect(answer('unknown', 'InTransit_Other', 'Estado interno 99')).toEqual(mapped('in_transit'));
    expect(answer('unknown', 'Delivered_Other', 'Not delivered')).toEqual(mapped('failed_attempt'));
    expect(answer('unknown', 'Delivered_Other', 'Estado interno 99')).toEqual(unknown);
    // Any other code, such as a UPU event code the provider does not map, leaves it to the wording.
    expect(answer('unknown', 'EMZ', 'Processed at EXAMPLE HUB')).toEqual(mapped('in_transit'));
    expect(answer('unknown', 'NotFound_Other', 'Estado interno 99')).toEqual(unknown);
  });

  it('give every scan the sync would review the stage the sync stored', () => {
    const wordings = ['Processed at EXAMPLE CITY - FRANCE', 'Shipment information received', 'Arrived at customs',
      'Released from import customs', 'Not delivered', 'Delivered', 'The item has been registered', 'Returned',
      'Will be delivered tomorrow', 'Estado interno 99', 'Parcel on hold at recipient’s request', 'Shipping label created'];
    const codes = [undefined, 'InfoReceived', 'InTransit_Other', 'InTransit_PickedUp', 'Delivered_Other',
      'Exception_Cancel', 'Exception_Returned', 'NotFound_Other'];
    const scans: CarrierEvent[] = [];
    for (const description of wordings) {
      scans.push(event(TIME, description)!);
      // 17TRACK's own stage label, absent or one the providers do not map, decides whether the scan is reviewed.
      for (const code of codes) for (const stage of [null, 'Synthetic']) {
        scans.push(seventeenTrackEvent({ time_utc: TIME, description, stage, sub_status: code }, {})!);
      }
    }
    // The app reviews every scan whose stage did not come from a map.
    const reviewed = scans.filter(({ stage_source }) => stage_source !== 'carrier_map');
    expect(reviewed.filter(({ provider_code: code }) => code).length).toBeGreaterThan(50);
    for (const scan of reviewed) {
      expect(answer('unknown', scan.provider_code ?? null, scan.description!), JSON.stringify(scan))
        .toEqual(scan.stage === 'pending' ? unknown : mapped(scan.stage!));
    }
  });

  it('close the relayed wording the shared rules read, and keep the rest open', () => {
    expect(answer('unknown', null, 'order details received')).toEqual(mapped('registered'));
    expect(answer('unknown', null, 'shipment is out with courier for delivery')).toEqual(mapped('out_for_delivery'));
    expect(answer('unknown', null, 'admitido.. el envío ha tenido admisión en origen.')).toEqual(mapped('accepted'));
    expect(answer('unknown', null, 'i̇ptal edildi')).toEqual(mapped('exception'));
    for (const wording of ["in paack's distribution centre", 'girildi', 'order triggered by recipient: forward']) {
      expect(answer('unknown', null, wording), wording).toEqual(unknown);
    }
  });

  it('leave nothing out on purpose', () => {
    expect(universal.gaps).toEqual([]);
  });
});

describe('declared status maps', () => {
  const declared = Object.entries<CarrierStatusMap>(STATUS_MAPS);

  it('registers every carrier that declares one', async () => {
    const found: string[] = [];
    for (const carrier of readdirSync(carriers).sort()) {
      if (!readdirSync(path.join(carriers, carrier)).includes('status.ts')) continue;
      const module = await import(path.join(carriers, carrier, 'status.ts')) as { statusMap?: CarrierStatusMap };
      if (module.statusMap) {
        found.push(carrier);
        expect(STATUS_MAPS[carrier], carrier).toBe(module.statusMap);
      }
    }
    expect(found).toEqual(Object.keys(STATUS_MAPS).sort());
  });

  it.each(declared)('%s keys its gaps as the app does, and stages none of them', (_carrier, map) => {
    const keys = map.gaps.map(({ code, wording }) => JSON.stringify([code ?? null, wording ?? null]));
    expect(new Set(keys).size).toBe(keys.length);
    for (const { code, wording, note } of map.gaps) {
      expect(code !== undefined || wording !== undefined).toBe(true);
      expect(code === undefined || (code.length >= 1 && code.length <= 100)).toBe(true);
      if (wording !== undefined) expect(normalizeStatusWording(wording)).toBe(wording);
      expect(note.length >= 1 && note.length <= 500).toBe(true);
      expect(map.stage(code ?? null, wording ?? 'synthetic wording')).toBeUndefined();
    }
  });
});
