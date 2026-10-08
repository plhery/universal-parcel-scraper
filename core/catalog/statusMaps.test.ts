import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeStatusWording, statusMapAnswer } from '../../app.js';
import type { CarrierStatusMap } from '../status/statusMap.js';
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
    for (const code of ['IN_TRANSIT', 'AT_DELIVERY_CENTER', 'ORI', 'SPL', 'OTHER', 'SPE', 'MSDLO', 'MIDLI']) {
      expect(answer('dpd', code, 'Any wording at all'), code).toEqual(gap);
    }
    // A label gap covers that wording without a code, and only then.
    expect(answer('dpd', null, '  Your parcel is ON its way')).toEqual({
      kind: 'intentional_gap', note: "The label of IN_TRANSIT, which DPD's map leaves unmapped on purpose.",
    });
    expect(answer('dpd', 'ENA', 'Your parcel is on its way')).toEqual(unknown);
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
    expect(answer('yunexpress', null, 'Arrived at GOFO Regional Destination Facility')).toEqual(mapped('in_transit'));
    expect(answer('dhl-express', 'PL', 'Processed at EXAMPLE CITY - FRANCE')).toEqual(mapped('in_transit'));
    expect(answer('dhl-express', null, 'Synthetic checkpoint')).toEqual(unknown);
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

  it.each(['unknown', 'app', '', 'china-post', 'dpd-fr', '__proto__', 'toString'])('does not know %s', (carrier) => {
    expect(answer(carrier, 'DLO', 'Delivered')).toEqual(unknown);
  });

  it('does not know a scan without wording', () => {
    expect(answer('dpd', 'DLO', '   ')).toEqual(unknown);
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
