import { describe, expect, it } from 'vitest';
import {
  brandCarrierIds, brandTimeZones, carrierIdFromName, carrierIdFromPartner, carrierIdFromPartnerLinks, carrierNameCountryZone, isCarrierFeedName,
  isKnownCarrierName, nationalPostCandidate,
} from './hints.js';

describe('brand networks', () => {
  it('lists the catalog networks of a bare or group brand name', () => {
    expect(new Set(brandCarrierIds('DPD Group'))).toEqual(new Set(['dpd', 'dpd-fr', 'dpd-de', 'dpd-uk']));
    expect(brandCarrierIds('gls')).toEqual(expect.arrayContaining(['gls-ch', 'gls-de', 'gls-fr']));
    expect(brandCarrierIds('DPD UK')).toEqual([]);
    expect(brandCarrierIds('Swiss Post')).toEqual([]);
  });
});

describe('national postal lookup candidates', () => {
  it.each([
    ['CH', 'swiss-post'], [' Switzerland ', 'swiss-post'], ['FI', 'posti'], ['finland', 'posti'],
    ['NL', 'spring-gds'], ['FR', 'la-poste'], ['GB', 'royal-mail'], ['US', 'usps'],
    ['CA', 'canada-post'], ['DE', 'dhl'], ['ES', 'correos-spain'], ['IN', 'india-post'],
    ['IT', 'poste-italiane'], ['JP', 'japan-post'], ['Japan', 'japan-post'], ['MY', 'pos-malaysia'], ['PT', 'ctt'],
  ])('suggests one operator for destination %s', (country, expected) => {
    expect(nationalPostCandidate(country)).toBe(expected);
  });
  it.each(['XX', 'LI', 'unknown', 'Arrived in Switzerland', 'constructor', '', null, 123])(
    'leaves unavailable or ambiguous destinations alone: %s', (country) => {
      expect(nationalPostCandidate(country)).toBeUndefined();
    },
  );
});

describe('delivery partner evidence', () => {
  it.each([
    ['Posti', '', 'posti'],
    ['Unknown partner label', 'https://www.posti.fi/en/tracking#/lahetys/TEST1234?lang=en', 'posti'],
    ['Swiss Post', 'https://www.post.ch/', 'swiss-post'],
    ['USPS', 'https://tools.usps.com/go/TrackConfirmAction', 'usps'],
    ['Asendia USA', '', 'asendia'],
    ['Asendia', 'https://a1.asendiausa.com/tracking/?trackingnumber=TEST1234', 'asendia'],
    ['GLS', '', undefined],
    ['constructor', '', undefined],
    ['Unknown carrier', '', undefined],
    ['Posti', 'https://www.post.ch/', undefined],
    ['', 'https://www.posti.fi.evil.test/', undefined],
    ['', 'https://www.posti.fi@evil.test/', undefined],
    ['', 'https://evil.test/?url=https://www.posti.fi/', undefined],
    ['', 'javascript://www.posti.fi/', undefined],
    ['', 'not a URL', undefined],
    // A named partner stands unless its link is on another carrier's host.
    ['DHL eCommerce', 'https://www.dhl.com/', 'dhl-ecommerce'],
    ['DHL eCommerce', 'https://www.dhl.com/us-en/home.html', 'dhl-ecommerce'],
    ['DHL eCommerce', 'https://www.dhl.com/us-en/home/tracking/tracking-ecommerce.html', 'dhl-ecommerce'],
    ['GLS Germany', 'https://gls-group.eu/EU/en/parcel-tracking', 'gls-de'],
    ['GLS France', 'https://gls-group.eu/EU/en/parcel-tracking', 'gls-fr'],
    ['GLS Germany', 'https://www.dhl.com/', undefined],
    // Without a name, a rule limited to some paths of a shared host covers only those paths.
    ['', 'https://www.gofo.com/', 'gofo'],
    ['', 'https://www.gofo.com/us/track?searchID=GFUS01000000000001', 'gofo'],
    ['', 'https://www.gofo.com/fr/', undefined],
    ['', 'https://www.gofo.com/usa/', undefined],
    ['', 'https://gls-group.eu/FR/fr/suivi-colis', 'gls-fr'],
    ['', 'https://gls-group.eu/', undefined],
    // DHL's eCommerce tracking page is shared, like its global one; its other pages are DHL's.
    ['', 'https://www.dhl.com/us-en/home/tracking/tracking-ecommerce.html', undefined],
    ['', 'https://www.dhl.com/us-en/home/tracking/tracking-express.html', 'dhl'],
  ])('resolves name %s and URL %s without guessing', (name, url, expected) => {
    expect(carrierIdFromPartner(name, url)).toBe(expected);
  });

  it('does not pick one of multiple partner links, but ignores the origin’s own links', () => {
    const origin = 'See https://www.dhl.de/ for tracking.';
    expect(carrierIdFromPartnerLinks([origin, 'Partner: https://www.posti.fi/en/tracking'], 'dhl')).toBe('posti');
    expect(carrierIdFromPartnerLinks(['https://www.posti.fi/ https://www.post.ch/'], 'dhl')).toBeUndefined();
  });
});

describe('carrier names reported by universal providers', () => {
  it.each([
    ['UPS', 'ups'], ['La Poste (Colissimo)', 'la-poste'], ['Chronopost France', 'chronopost'],
    ['Chronopost (France)', 'chronopost'], ['Posti Finland', 'posti'], ['Swiss Post CH', 'swiss-post'],
    ['Finland Post', 'posti'], ['Spain Post', 'correos-spain'],
    ['Correos de España', 'correos-spain'], ['Correos Spain', 'correos-spain'],
    ['Intelcom', 'intelcom'], ['Dragonfly', 'intelcom'], ['Orange Connex', 'speedpak'],
    ['Evri International', 'evri'], ['Hermes UK', 'evri-uk'], ['DPD Germany', 'dpd-de'], ['DPD UK', 'dpd-uk'],
  ])('maps %s, a carrier followed by its own country included', (name, expected) => {
    expect(carrierIdFromName(name)).toBe(expected);
  });

  it.each([
    // Another company under the brand, a country without one zone, a brand with several networks.
    'Chronopost Portugal', 'Correos Chile', 'UPS United States', 'DHL Germany', 'GLS', 'France', 'Evri',
  ])('does not guess a carrier from %s', (name) => {
    expect(carrierIdFromName(name)).toBeUndefined();
  });

  it.each([
    'La Poste', 'La Poste (Colissimo)', 'Chronopost France', 'FedEx', 'India Post', 'Posti', 'UPS',
    'Chronopost Portugal', 'Correos Chile', 'Royal Mail (UK)', 'DHL', 'DHL Express', 'GLS Italy', 'DPD UK',
    'Finland Post', 'Spain Post', 'Correos de España', 'Correos Spain',
  ])('knows %s from the catalog', (name) => {
    expect(isKnownCarrierName(name)).toBe(true);
  });

  it.each(['Example Parcel Co', 'Example Express Italy', 'Postexample Courier'])('treats %s as new', (name) => {
    expect(isKnownCarrierName(name)).toBe(false);
  });

  it.each(['UPU', 'upu', 'Universal Postal Union'])('takes %s for the postal union\'s feed, not for a carrier', (name) => {
    expect(isCarrierFeedName(name)).toBe(true);
    expect(carrierIdFromName(name)).toBeUndefined();
    expect(isKnownCarrierName(name)).toBe(false);
    expect(carrierNameCountryZone(name)).toBeNull();
  });

  it.each(['UPS', 'Posti', 'Finland Post', 'Post', 'Example Parcel Co', ''])('takes %s for no feed', (name) => {
    expect(isCarrierFeedName(name)).toBe(false);
  });
});

describe('zones implied by carrier names', () => {
  it.each([
    // A carrier or brand network followed by a single-clock country, even when no carrier is identified.
    ['Chronopost France', 'Europe/Paris'], ['DPD UK', 'Europe/London'], ['GLS Italy', 'Europe/Rome'],
    ['DHL Parcel Netherlands', 'Europe/Amsterdam'], ['DHL Germany', 'Europe/Berlin'], ['Chronopost Portugal', 'Europe/Lisbon'],
    ['Royal Mail (UK)', 'Europe/London'], ['Cainiao (China)', 'Asia/Shanghai'],
  ])('reads %s in %s', (name, zone) => {
    expect(carrierNameCountryZone(name)).toBe(zone);
  });

  it.each(['Swiss Post', 'UPS', 'Asendia USA', 'UPS United States', 'Correos Chile', 'DPD Group', 'DHL', 'Example Express Italy', ''])(
    'implies no zone for %s', (name) => {
      expect(carrierNameCountryZone(name)).toBeNull();
    },
  );

  it('resolves supported national names and keeps uncatalogued networks ambiguous', () => {
    expect(carrierIdFromName('DPD UK')).toBe('dpd-uk');
    expect(carrierIdFromName('DHL Parcel Netherlands')).toBe('dhl-ecommerce-nl');
    expect(carrierIdFromName('DHL Parcel Spain')).toBe('dhl-ecommerce-es');
    expect(carrierIdFromName('DHL Parcel UK')).toBe('dhl-ecommerce-uk');
    expect(carrierIdFromName('DHL Parcel Poland')).toBe('dhl-ecommerce-pl');
    for (const name of ['GLS Italy', 'DHL Parcel Italy', 'DPD Group']) expect(carrierIdFromName(name)).toBeUndefined();
  });

  it('lists the zones of a bare brand only when all of its carriers keep a local clock', () => {
    // ParcelsApp reads brand-only scans in these zones. A catalog change here moves
    // stored scan instants, and so event ids: plan a re-key before updating the sets.
    expect(new Set(brandTimeZones('DPD Group'))).toEqual(new Set(['Europe/Zurich', 'Europe/Paris', 'Europe/Berlin', 'Europe/London']));
    expect(new Set(brandTimeZones('dpd'))).toEqual(new Set(['Europe/Zurich', 'Europe/Paris', 'Europe/Berlin', 'Europe/London']));
    expect(new Set(brandTimeZones('GLS'))).toEqual(new Set(['Europe/Zurich', 'Europe/Berlin', 'Europe/Paris']));
    expect(brandTimeZones('Hermes')).toEqual(['Europe/Berlin']);
    // DHL eCommerce is UTC, so the brand's clock is unknown.
    for (const name of ['DHL', 'DHL Group', 'DPD Local', 'DPD UK', 'Post', 'Example Parcel Co']) expect(brandTimeZones(name)).toEqual([]);
  });
});
