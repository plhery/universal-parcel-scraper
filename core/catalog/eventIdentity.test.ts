import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { sameInstantIdentityPolicy } from '../../app.js';

describe('same-instant identity policies', () => {
  it('requires India Post scans to retain their provider code, and lets a scan abroad take its own offset', () => {
    expect(sameInstantIdentityPolicy('india-post')).toEqual({
      sourceCarrierId: 'india-post', storedSources: ['india-post'], requireProviderCode: true, relabelledFrom: 'Asia/Kolkata',
    });
  });

  // A carrier giving wall clocks in no stated zone also matches a scan a better deduced zone re-dates.
  it.each([
    ['ctt', 'UTC', { matchWallClock: true }],
    ['canada-post', 'Etc/GMT+5', { matchWallClock: true }],
    ['royal-mail', 'Europe/London', { matchWallClock: true }],
    ['parcelforce', 'Europe/London', {}],
    ['la-poste', 'Europe/Paris', {}],
    ['posta-slovenije', 'Europe/Ljubljana', { matchWallClock: true }],
  ])('requires %s scans to retain their provider code, and lets a scan take its own offset', (source, zone, wallClock) => {
    expect(sameInstantIdentityPolicy(source)).toEqual({
      sourceCarrierId: source, storedSources: [source], requireProviderCode: true, relabelledFrom: zone, ...wallClock,
    });
  });

  // The stored instant, read in the policy's zone, shows the wall clock the scan now carries.
  it.each([
    ['ctt', '2026-08-04T13:29:00Z', '2026-08-04T13:29:00+02:00'],
    ['canada-post', '2026-03-10T19:00:00-05:00', '2026-03-10T19:00:00+09:00'],
    ['canada-post', '2026-07-10T19:00:00-05:00', '2026-07-10T19:00:00-04:00'],
    ['nz-post', '2026-08-14T00:47:00Z', '2026-08-14T12:47:00+08:00'],
    ['nz-post', '2026-01-14T00:47:00Z', '2026-01-14T13:47:00+08:00'],
    ['swiss-post', '2026-08-09T14:30:00+02:00', '2026-08-09T14:30:00+08:00'],
    ['swiss-post', '2026-01-09T14:30:00+01:00', '2026-01-09T14:30:00-06:00'],
    ['royal-mail', '2026-10-10T20:51:00Z', '2026-10-10T21:51:00+02:00'],
    ['royal-mail', '2026-01-10T21:51:00Z', '2026-01-10T21:51:00+01:00'],
    ['parcelforce', '2026-10-20T21:54:00Z', '2026-10-20T22:54:00+02:00'],
    ['la-poste', '2026-07-05T20:25:00+02:00', '2026-07-05T20:25:00+03:00'],
    ['la-poste', '2026-01-05T14:45:00+01:00', '2026-01-05T14:45:00Z'],
    ['posta-slovenije', '2026-10-08T16:07:00Z', '2026-10-08T18:07:00+03:00'],
    ['posta-slovenije', '2026-03-02T16:07:00Z', '2026-03-02T17:07:00+02:00'],
    ['postnord', '2026-10-23T10:23:00Z', '2026-10-23T10:23:00+02:00'],
  ])('reads a %s scan stored as %s on the clock it was labelled with', (source, stored, current) => {
    const policy = sameInstantIdentityPolicy(source, { supportsScanMatching: true });
    expect(policy?.requireProviderCode).toBe(true);
    const wall = (time: string, zone?: string) =>
      DateTime.fromISO(time, zone ? { zone } : { setZone: true }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
    expect(wall(stored, policy?.relabelledFrom)).toBe(wall(current));
  });

  it('requires Amazon Shipping scans to retain their event code', () => {
    // A scan stored on a local clock shows the same wall clock under +00:00.
    expect(sameInstantIdentityPolicy('amazon-shipping')).toEqual({
      sourceCarrierId: 'amazon-shipping', storedSources: ['amazon-shipping'], requireProviderCode: true, matchWallClock: true,
    });
  });

  it('keeps DPD postcode variants and universal copies eligible', () => {
    expect(sameInstantIdentityPolicy('dpd')).toEqual({
      sourceCarrierId: 'dpd', storedSources: ['dpd', 'unknown'], requireProviderCode: false,
    });
  });

  it('lets SF Express scans take over universal copies at the same instant', () => {
    expect(sameInstantIdentityPolicy('sf-express')).toEqual({
      sourceCarrierId: 'sf-express', storedSources: ['sf-express', 'unknown'], requireProviderCode: false,
    });
  });

  it.each(['dhl-ecommerce-nl', 'gls', '', 'toString'])('does not opt in %s', (source) => {
    expect(sameInstantIdentityPolicy(source)).toBeUndefined();
    expect(sameInstantIdentityPolicy(source, { supportsScanMatching: true })).toBeUndefined();
  });

  it.each([
    ['austrian-post', 'in_transit', 'Sendung von Postbetreiber Zielland übernommen', 'PLZ DE', 'Synthetic exchange office'],
    ['austrian-post', 'out_for_delivery', 'Sendung in Zustellung', 'PLZ FR 1', 'Zustellbasis Beispielort'],
    ['austrian-post', 'delivered', 'Sendung wurde zugestellt', 'PLZ 12345, Deutschland', 'PLZ BEISPIELSTADT, Deutschland'],
    ['chronopost', 'registered', "Colis en cours de préparation chez l'expéditeur", 'Web Services', 'CORBAS CHRONOPOST'],
    ['chronopost', 'in_transit', 'Destinataire informé par SMS ou mail', 'Service d’avisage', 'Example Town - DE (depot 0001)'],
    ['chronopost', 'in_transit', "Colis en cours d'acheminement", 'CHRONOPOST NETWORKS', 'Example Town - DE (depot 0001)'],
    ['dpd-fr', 'delivered', 'Votre colis est livré', 'Livré au destinataire', 'Agence DPD de Example Town (1)'],
    ['poczta-polska', 'in_transit', 'In transport', 'Transshipment', 'Placówka Pocztowa Example Town'],
    ['poczta-polska', 'registered', 'Electronic item data received', 'Elektroniczny Nadawca', 'Placówka Pocztowa Example Town'],
    ['posti', 'in_transit', 'Item has been registered The item can be registered several times during delivery.', 'ULKOMAILLA', 'EXAMPLE CITY'],
    ['posti', 'delivered', 'Item delivered to the recipient.', 'ULKOMAILLA', 'EXAMPLE CITY'],
    ['posti', 'in_transit', 'The item is in transport The item was picked up from the original location.', 'Posti kuljetus', 'EXAMPLE CITY'],
  ])('lets a %s scan that lost "%s" take over its stored row', (source, stage, description, dropped, place) => {
    expect(sameInstantIdentityPolicy(source)).toBeUndefined();
    const policy = sameInstantIdentityPolicy(source, { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: [source], requireProviderCode: false, matchEachScan: true });
    const stored = { stage, description, location: dropped, providerCode: 'X' };
    const incoming = { ...stored, description: ` ${description.toUpperCase()} `, location: '', providerCode: '' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, location: `  ${dropped.toLowerCase()}` })).toBe(true);
    // A scan that keeps a place, or a stored place, is no dropped label.
    expect(policy?.matches?.({ ...incoming, location: place }, stored)).toBe(false);
    expect(policy?.matches?.(stored, incoming)).toBe(false);
    for (const different of [
      { ...stored, location: place },
      { ...stored, location: '' },
      { ...stored, description: 'Another scan' },
      { ...stored, stage: 'exception' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    for (const unknownStage of ['', 'unknown']) {
      expect(policy?.matches?.({ ...incoming, stage: unknownStage }, { ...stored, stage: unknownStage })).toBe(false);
    }
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
  });

  it.each(['unknown', 'swiss-post', 'mondial-relay', 'ciblex', 'yanwen'])('matches %s location enrichment only with unchanged scan evidence', (source) => {
    expect(sameInstantIdentityPolicy(source)).toBeUndefined();
    const policy = sameInstantIdentityPolicy(source, { supportsScanMatching: true });
    expect(policy?.storedSources).toEqual([source]);
    expect(policy?.requireProviderCode).toBe(source === 'swiss-post');
    expect(policy?.matchEachScan).toBe(true);
    const stored = { stage: 'in_transit', description: 'Arrived at sorting centre', location: '', providerCode: 'SORT' };
    const incoming = { ...stored, location: 'Example City, France' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, incoming)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(false);
    for (const different of [
      { ...stored, description: 'Departed sorting centre' },
      { ...stored, stage: 'out_for_delivery' },
      { ...stored, location: 'Another City, France' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, stage: 'pending' }, { ...stored, stage: 'pending' })).toBe(true);
    for (const stage of ['', 'unknown']) {
      expect(policy?.matches?.({ ...incoming, stage }, { ...stored, stage })).toBe(false);
    }
  });

  it('lets a Swiss Post scan stored with a bare site number lose it', () => {
    const policy = sameInstantIdentityPolicy('swiss-post', { supportsScanMatching: true });
    const stored = { stage: 'in_transit', description: 'Sorting - forwarding', location: '100000', providerCode: 'PARCEL.*.1.3001' };
    const incoming = { ...stored, location: '' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    for (const different of [
      { ...stored, location: 'Example Depot 100000' },
      { ...stored, location: 'CH' },
      { ...stored, description: 'Sorted for delivery' },
      { ...stored, stage: 'out_for_delivery' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
  });

  it('lets a Swiss Post scan worded in another language take over its stored row at the same place', () => {
    const policy = sameInstantIdentityPolicy('swiss-post', { supportsScanMatching: true });
    // The app requires the same provider code at the same instant before it asks.
    const stored = { stage: 'delivered', description: 'Delivered', location: 'Example Town 999999', providerCode: 'PARCEL.*.1.4000' };
    for (const description of ['Distribué', 'Zugestellt', 'Recapitato']) {
      expect(policy?.matches?.({ ...stored, description }, stored)).toBe(true);
      expect(policy?.matches?.(stored, { ...stored, description })).toBe(true);
    }
    const revoked = { ...stored, stage: '', description: 'Delivered — Revocation' };
    expect(policy?.matches?.({ ...revoked, description: 'Distribué — Révocation' }, revoked)).toBe(true);
    for (const different of [revoked, { ...stored, location: 'Another Town 999998' }, { ...stored, location: '' }]) {
      expect(policy?.matches?.({ ...stored, description: 'Distribué' }, different)).toBe(false);
    }
  });

  it('lets a universal copy that lost Posti\'s "abroad" label take over its stored row', () => {
    const policy = sameInstantIdentityPolicy('unknown', { supportsScanMatching: true });
    const stored = { stage: 'in_transit', description: 'Item is in transport in destination country.', location: 'ULKOMAILLA', providerCode: '' };
    const incoming = { ...stored, location: '' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, location: ' ulkomailla' })).toBe(true);
    for (const different of [
      { ...stored, location: 'Example City, France' },
      { ...stored, description: 'Item has been registered' },
      { ...stored, stage: 'delivered' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
  });

  it('lets a universal copy that lost a label naming no place, or the words before a depot, take over its stored row', () => {
    const policy = sameInstantIdentityPolicy('unknown', { supportsScanMatching: true });
    const stored = { stage: 'registered', description: 'Shipping Label Created', location: 'US, SYSTEM, SYSTEM', providerCode: '' };
    expect(policy?.matches?.({ ...stored, location: '' }, stored)).toBe(true);
    const depot = { stage: 'delivered', description: 'Delivered', location: 'from the operational headquarters in EXAMPLE TOWN (Example Region)', providerCode: '' };
    expect(policy?.matches?.({ ...depot, location: 'EXAMPLE TOWN (Example Region)' }, depot)).toBe(true);
    for (const different of [
      { ...depot, location: 'OTHER TOWN (Example Region)' },
      { ...depot, location: '' },
      { ...depot, description: 'In transit' },
    ]) expect(policy?.matches?.(different, depot)).toBe(false);
    expect(policy?.matches?.({ ...stored, location: '' }, { ...stored, location: 'Example System Park, US' })).toBe(false);
  });

  it("lets a universal copy that lost a Post Office branch's postcode take over its stored row", () => {
    const policy = sameInstantIdentityPolicy('unknown', { supportsScanMatching: true });
    const stored = { stage: 'accepted', description: 'Accepted at Parcelshop', location: 'Example Post Office [ZZ9 9ZZ]', providerCode: '' };
    expect(policy?.matches?.({ ...stored, location: 'Example Post Office' }, stored)).toBe(true);
    expect(policy?.matches?.({ ...stored, location: 'Other Post Office' }, stored)).toBe(false);
  });

  it('lets a universal copy that lost a "Country" label take over its stored row', () => {
    const policy = sameInstantIdentityPolicy('unknown', { supportsScanMatching: true });
    const stored = { stage: 'in_transit', description: 'Item in transfer - please wait', location: 'Country, EXAMPLELAND', providerCode: '' };
    expect(policy?.matches?.({ ...stored, location: 'EXAMPLELAND' }, stored)).toBe(true);
    expect(policy?.matches?.({ ...stored, location: 'OTHERLAND' }, stored)).toBe(false);
  });

  it('lets a J&T Australia scan whose sentence lost its closing courtesy take over its stored row', () => {
    const policy = sameInstantIdentityPolicy('j-and-t-au', { supportsScanMatching: true });
    const stored = { stage: 'delivered', description: 'Your parcel has been delivered.If you have any questions,please call. We look forward to serving you again.',
      location: '', providerCode: '' };
    expect(policy?.matches?.({ ...stored, description: 'Your parcel has been delivered.' }, stored)).toBe(true);
    expect(policy?.matches?.({ ...stored, description: 'Your parcel has been delivered.', stage: 'in_transit' }, stored)).toBe(false);
    expect(policy?.matches?.({ ...stored, description: 'Your parcel is out for delivery.' }, stored)).toBe(false);
  });

  it('lets a Vinted Go scan whose town lost a space before its comma take over its stored row', () => {
    const policy = sameInstantIdentityPolicy('vinted-go', { supportsScanMatching: true });
    const stored = { stage: 'in_transit', description: 'At sorting center in Example Town , FR', location: 'Example Town , FR', providerCode: 'delivery/in_transit' };
    expect(policy?.matches?.({ ...stored, location: 'Example Town, FR' }, stored)).toBe(true);
    expect(policy?.matches?.({ ...stored, location: 'Other Town, FR' }, stored)).toBe(false);
    expect(policy?.matches?.({ ...stored, location: 'Example Town, FR' }, { ...stored, location: 'Example Town, FR' })).toBe(false);
  });

  it('lets a universal copy that lost a status given as its location take over its stored row', () => {
    const policy = sameInstantIdentityPolicy('unknown', { supportsScanMatching: true });
    const stored = { stage: 'in_transit', description: '离开处理中心', location: 'Departure from【Example City】', providerCode: 'InTransit_Other' };
    expect(policy?.matches?.({ ...stored, location: 'Example City' }, stored)).toBe(true);
    expect(policy?.matches?.({ ...stored, location: 'Other City' }, stored)).toBe(false);
    const status = { ...stored, location: 'Out For Delivery' };
    expect(policy?.matches?.({ ...status, location: '' }, status)).toBe(true);
  });

  it('lets a universal copy that shows a China Post label in English take over the row stored in Chinese', () => {
    const policy = sameInstantIdentityPolicy('unknown', { supportsScanMatching: true });
    // A partner's scan abroad, its place cut off in the label and read from the location.
    const stored = { stage: 'out_for_delivery', description: '出门投递【ZZ Dispatching【Example Ci】', location: 'Dispatching【Example City X9X9X9】',
      providerCode: 'OutForDelivery_Other' };
    const incoming = { ...stored, description: 'Out for delivery', location: 'Example City' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.({ ...incoming, location: 'Example City' }, { ...stored, location: 'Example City' })).toBe(true);
    const label = { stage: 'in_transit', description: '飞机进港', location: '', providerCode: 'InTransit_Other' };
    expect(policy?.matches?.({ ...label, description: 'Plane has landed' }, label)).toBe(true);
    for (const different of [
      { ...stored, description: '邮件到达处理中心【ZZ Arriyal at Processin】' },
      { ...stored, location: 'Dispatching【Other City X9X9X9】' },
      { ...stored, providerCode: 'Delivered_Other' },
      { ...stored, description: '运输中' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.(stored, incoming)).toBe(false);
  });

  it('matches a Cainiao scan whose town has left its wording for its location', () => {
    expect(sameInstantIdentityPolicy('aliexpress')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('aliexpress', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['aliexpress'], requireProviderCode: false, matchEachScan: true });
    const stored = { stage: 'out_for_delivery', description: '[Example City] Out for delivery', location: '', providerCode: '' };
    const incoming = { ...stored, description: 'Out for  delivery', location: 'Example City' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(false);
    for (const different of [
      { ...stored, description: '[Another City] Out for delivery' },
      { ...stored, description: 'Out for delivery' },
      { ...stored, location: 'Example City' },
      { ...stored, stage: 'delivered' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    for (const stage of ['', 'unknown']) {
      expect(policy?.matches?.({ ...incoming, stage }, { ...stored, stage })).toBe(false);
    }
  });

  it('lets an LBC scan gain its town and drop a representative\'s name with its provider code', () => {
    expect(sameInstantIdentityPolicy('lbc-express')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('lbc-express', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['lbc-express'], requireProviderCode: true, matchEachScan: true });
    const stored = { stage: 'accepted', description: 'Shipment has been received at  EXAMPLE HUB.', location: '', providerCode: '0' };
    const incoming = { ...stored, stage: 'in_transit', description: 'Shipment has been received at EXAMPLE HUB.', location: 'EXAMPLE TOWN, EXAMPLE PROVINCE' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, incoming)).toBe(true);
    for (const different of [
      { ...stored, description: 'Shipment has been received at ANOTHER HUB.' },
      { ...stored, location: 'ANOTHER TOWN, EXAMPLE PROVINCE' },
      { ...stored, providerCode: '8810' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    const release = { stage: 'delivered', description: 'Released to authorized representative', location: 'EXAMPLE TOWN, EXAMPLE PROVINCE', providerCode: '5' };
    const named = { ...release, description: 'Released to authorized representative EXAMPLE PERSON 10/02/2026.', location: '' };
    expect(policy?.matches?.(release, named)).toBe(true);
    expect(policy?.matches?.(named, release)).toBe(false);
    expect(policy?.matches?.(release, { ...named, description: 'Released to EXAMPLE PERSON' })).toBe(false);
  });

  it('lets a Poste Italiane depot scan gain its town and province', () => {
    expect(sameInstantIdentityPolicy('poste-italiane')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('poste-italiane', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['poste-italiane'], requireProviderCode: false, matchEachScan: true });
    const stored = { stage: 'in_transit', description: 'la spedizione è in transito', location: '', providerCode: '' };
    const incoming = { ...stored, location: 'EXAMPLE TOWN (XX), IT' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, incoming)).toBe(true);
    // A row stored with the town and province alone gains the country.
    expect(policy?.matches?.(incoming, { ...stored, location: 'EXAMPLE TOWN (XX)' })).toBe(true);
    for (const different of [
      { ...stored, description: 'la spedizione è in consegna' },
      { ...stored, location: 'UFFICIO DI PROVA' },
      { ...stored, location: 'OTHER TOWN (XX)' },
      { ...stored, location: 'EXAMPLE TOWN (YY)' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, location: 'UFFICIO DI PROVA' }, stored)).toBe(false);
    expect(policy?.matches?.({ ...incoming, location: 'UFFICIO DI PROVA, IT' }, { ...stored, location: 'UFFICIO DI PROVA' })).toBe(false);
  });

  it('lets a DHL eCommerce scan stored with its country twice take the location with it once', () => {
    expect(sameInstantIdentityPolicy('dhl-ecommerce')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('dhl-ecommerce', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['dhl-ecommerce'], requireProviderCode: false, matchEachScan: true });
    const stored = { stage: 'in_transit', description: 'PROCESSED', location: 'Sampleton, IL, US, US', providerCode: '' };
    const incoming = { ...stored, location: 'Sampleton, IL, US' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    for (const different of [
      { ...stored, description: 'ARRIVED' },
      { ...stored, stage: 'out_for_delivery' },
      { ...stored, location: 'Otherton, IL, US, US' },
      { ...stored, location: 'Sampleton, IL, US' },
      { ...stored, location: '' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
  });

  it('lets a DHL Express record take over the row the other feed stored, by wall clock, place and wording', () => {
    expect(sameInstantIdentityPolicy('dhl-express')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('dhl-express', { supportsScanMatching: true });
    expect(policy).toMatchObject({
      sourceCarrierId: 'dhl-express', storedSources: ['dhl-express'], requireProviderCode: false, matchEachScan: true, matchWallClock: true,
    });
    expect(policy?.relabelledFrom).toBeUndefined();
    // The global portal's record carries DHL's code; the mobile API's has none, and its stage may differ.
    const stored = { stage: 'customs', description: 'Customs clearance status updated', location: 'EXAMPLE CITY - ITALY', providerCode: 'RR' };
    const incoming = { ...stored, stage: 'in_transit', description: ' customs clearance  status updated ', location: 'EXAMPLE CITY - ITALY ', providerCode: '' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(true);
    expect(policy?.matches?.(stored, stored)).toBe(true);
    for (const different of [
      { ...stored, description: 'Clearance processing complete at EXAMPLE CITY - ITALY' },
      { ...stored, location: 'ANOTHER CITY - ITALY' },
      { ...stored, location: '' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...stored, providerCode: 'SD' }, stored)).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
  });

  it('lets a scan a better deduced zone re-dates take over its row, for a carrier giving wall clocks in no stated zone', () => {
    expect(sameInstantIdentityPolicy('evri')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('evri', { supportsScanMatching: true });
    expect(policy).toMatchObject({
      sourceCarrierId: 'evri', storedSources: ['evri'], requireProviderCode: false, matchEachScan: true, matchWallClock: true,
    });
    const stored = { stage: 'in_transit', description: 'Your parcel has arrived at the airport', location: 'XYZ Airport', providerCode: '' };
    const incoming = { ...stored, description: ' your parcel has arrived  at the airport', location: 'XYZ Airport ' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(true);
    expect(policy?.matches?.({ ...incoming, providerCode: 'A1' }, stored)).toBe(true);
    for (const different of [
      { ...stored, description: 'Your parcel has left the airport' },
      { ...stored, location: 'Sample Hub' },
      { ...stored, location: '' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, providerCode: 'A1' }, { ...stored, providerCode: 'B2' })).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
    // A carrier whose scans carry their own offsets keeps no policy.
    expect(sameInstantIdentityPolicy('dhl-ecommerce-nl', { supportsScanMatching: true })).toBeUndefined();
  });

  it('lets a 4PX row its facility\'s offset re-dates take over the row stored under the partner\'s, by wall clock', () => {
    expect(sameInstantIdentityPolicy('four-px', { supportsScanMatching: true })).toMatchObject({ matchWallClock: true });
  });

  it('lets a DHL arrival notice shown without its partner link take over the row stored with it', () => {
    expect(sameInstantIdentityPolicy('dhl')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('dhl', { supportsScanMatching: true });
    // A scan abroad, now on its country's clock, takes over the row stored under Germany's offset.
    expect(policy).toMatchObject({ storedSources: ['dhl'], requireProviderCode: false, matchEachScan: true, matchWallClock: true });
    const notice = 'The shipment has arrived in the destination country and will be handed over to the delivery company.';
    const incoming = { stage: 'in_transit', description: notice, location: 'Example Country', providerCode: '' };
    for (const link of ['https://www.example.com/', '']) {
      const stored = { ...incoming, description: `${notice} (Homepage / online shipment tracking: ${link})` };
      expect(policy?.matches?.(incoming, stored)).toBe(true);
      expect(policy?.matches?.(stored, incoming)).toBe(false);
      expect(policy?.matches?.(incoming, { ...stored, location: 'Another Country' })).toBe(false);
      expect(policy?.matches?.({ ...incoming, description: 'Another notice' }, stored)).toBe(false);
    }
    expect(policy?.matches?.(incoming, incoming)).toBe(false);
  });

  it('lets a Posti scan whose status now ends with a full stop take over the row stored without it', () => {
    const policy = sameInstantIdentityPolicy('posti', { supportsScanMatching: true });
    const stored = { stage: 'in_transit', description: 'Item has been registered The item can be registered several times.', location: 'EXAMPLE CITY', providerCode: '' };
    const incoming = { ...stored, description: 'Item has been registered. The item can be registered several times.' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(false);
    for (const different of [
      { ...stored, stage: 'pending' },
      { ...stored, location: 'ANOTHER CITY' },
      { ...stored, description: 'Item has been sorted The item can be registered several times.' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: 'Item has been registered! The item can be registered several times.' }, stored)).toBe(false);
  });

  it('reads a Posti copy of an origin post\'s scan stored on Helsinki\'s clock at the wall clock it now carries, by wording', () => {
    const policy = sameInstantIdentityPolicy('posti', { supportsScanMatching: true });
    expect(policy).toMatchObject({ requireProviderCode: false, relabelledFrom: 'Europe/Helsinki' });
    const wall = (time: string, zone?: string) =>
      DateTime.fromISO(time, zone ? { zone } : { setZone: true }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
    expect(wall('2026-10-23T09:44:00Z', policy?.relabelledFrom)).toBe(wall('2026-10-23T12:44:00+02:00'));
    expect(wall('2026-01-12T09:00:00Z', policy?.relabelledFrom)).toBe(wall('2026-01-12T11:00:00+01:00'));
  });

  it('lets a Pitney Bowes import declaration shown without its country, and a clearance shown in words, take over their rows', () => {
    const policy = sameInstantIdentityPolicy('pitney-bowes', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['pitney-bowes'], requireProviderCode: false, matchEachScan: true, matchWallClock: true });
    const declaration = { stage: 'customs', description: 'Customs Clearance', location: '', providerCode: '' };
    expect(policy?.matches?.(declaration, declaration)).toBe(true);
    expect(policy?.matches?.(declaration, { ...declaration, location: 'ZZ' })).toBe(true);
    for (const stored of [{ ...declaration, location: 'Sample City, ZZ' }, { ...declaration, location: 'ZZ', stage: 'in_transit' }]) {
      expect(policy?.matches?.(declaration, stored)).toBe(false);
    }
    expect(policy?.matches?.({ ...declaration, description: 'Arrived Facility' }, { ...declaration, description: 'Arrived Facility', location: 'ZZ' })).toBe(false);
    const cleared = { stage: 'in_transit', description: 'Customs import cleared', location: 'ZZ', providerCode: 'B2C ClearanceStatus4' };
    const stored = { ...cleared, description: 'B2C ClearanceStatus4', providerCode: '' };
    expect(policy?.matches?.(cleared, stored)).toBe(true);
    expect(policy?.matches?.(stored, cleared)).toBe(false);
    for (const other of [{ ...stored, location: 'YY' }, { ...stored, description: 'B2C ClearanceStatus2' }]) {
      expect(policy?.matches?.(cleared, other)).toBe(false);
    }
    expect(policy?.matches?.({ ...cleared, providerCode: 'B2C ClearanceStatus2' }, stored)).toBe(false);
  });

  it.each(['aliexpress', 'imile'])('lets a %s scan Cainiao worded as "Carrier update" take over its row once worded as its step', (source) => {
    const policy = sameInstantIdentityPolicy(source, { supportsScanMatching: true });
    const stored = { stage: 'in_transit', description: 'Carrier update', location: '', providerCode: 'SC_TRANS_OUTBOUND_SUCCESS' };
    const incoming = { ...stored, description: 'Package left sorting center of transit' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.({ ...incoming, stage: 'unknown' }, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(false);
    for (const different of [
      { ...stored, providerCode: '' },
      { ...stored, providerCode: 'SC_TRANS_INBOUND_SUCCESS' },
      { ...stored, location: 'Example City' },
      { ...stored, description: 'Another scan' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, providerCode: '' }, { ...stored, providerCode: '' })).toBe(false);
  });

  it('keeps matching an iMile scan read twice by its evidence and wall clock', () => {
    const policy = sameInstantIdentityPolicy('imile', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['imile'], requireProviderCode: false, matchEachScan: true, matchWallClock: true });
    const stored = { stage: 'in_transit', description: 'Departed from sorting center', location: 'Example Hub', providerCode: 'SC_OUTBOUND_SUCCESS' };
    expect(policy?.matches?.({ ...stored, description: ' departed from  sorting center' }, stored)).toBe(true);
    expect(policy?.matches?.({ ...stored, providerCode: 'OTHER' }, stored)).toBe(false);
    // A row stored with iMile's brackets keeps its row once worded without them.
    const bracketed = { stage: 'in_transit', description: '【Example Hub】Arrived.', location: 'Example Hub', providerCode: '1002' };
    expect(policy?.matches?.({ ...bracketed, description: 'Arrived.' }, bracketed)).toBe(true);
    const away = { ...bracketed, description: '【<EXA>】 Clearance start.', location: '' };
    expect(policy?.matches?.({ ...away, description: 'EXA: Clearance start.' }, away)).toBe(true);
    expect(policy?.matches?.({ ...away, description: 'Clearance start.' }, away)).toBe(false);
  });

  it('lets a DHLink node stored with its row’s clock in its wording keep its row once worded without it', () => {
    const policy = sameInstantIdentityPolicy('dhlink', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['dhlink'], requireProviderCode: false, matchEachScan: true, matchWallClock: true });
    const stored = { stage: 'delivered', description: 'Shipment has delivered at 2026-01-02 03:04:05', location: 'Example City, KY, US', providerCode: '' };
    const incoming = { ...stored, description: 'Shipment has delivered' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, incoming)).toBe(true);
    for (const different of [
      { ...stored, location: 'Example Town, KY, US' },
      { ...stored, description: 'Shipment has delivered at the front door' },
      { ...stored, description: 'Shipment has arrived at 2026-01-02 03:04:05' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: ' at 2026-01-02 03:04:05' })).toBe(false);
  });

  it('lets a LinHan row read on Beijing time take over the row stored on its town’s zone, by wall clock, town and wording', () => {
    expect(sameInstantIdentityPolicy('linhan')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('linhan', { supportsScanMatching: true });
    expect(policy).toMatchObject({
      sourceCarrierId: 'linhan', storedSources: ['linhan'], requireProviderCode: false, matchEachScan: true, matchWallClock: true,
    });
    const stored = { stage: 'in_transit', description: 'Leaving the sorting center', location: 'Sample City', providerCode: '' };
    const incoming = { ...stored, description: ' leaving the  Sorting Center', location: 'Sample City ' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(true);
    for (const different of [
      { ...stored, description: 'Arrive at the sorting and distribution center' },
      { ...stored, location: 'Sample Town' },
      { ...stored, location: '' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
  });

  it('lets a CTTYEX row read on Beijing time take over the row stored from its wall clock, by wording and place, the place once in the wording', () => {
    expect(sameInstantIdentityPolicy('cttyex')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('cttyex', { supportsScanMatching: true });
    expect(policy).toMatchObject({
      sourceCarrierId: 'cttyex', storedSources: ['cttyex'], requireProviderCode: false, matchEachScan: true, matchWallClock: true,
    });
    const stored = { stage: 'in_transit', description: 'Arrive at the receiving point', location: '', providerCode: '' };
    const incoming = { ...stored, stage: 'accepted', description: ' arrive at the  Receiving Point' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(true);
    for (const different of [
      { ...stored, description: 'Arrive at the cross border receiving point' },
      { ...stored, location: 'Sample City' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
    // A row abroad stored with its town, state and ZIP code in the wording.
    const placed = { stage: 'in_transit', description: 'Leaving the sorting center', location: 'Sample City, Sample State', providerCode: '' };
    const worded = { ...placed, description: 'Sample City, Sample State, 00000 Leaving the sorting center', location: '' };
    expect(policy?.matches?.(placed, worded)).toBe(true);
    for (const different of [
      { ...worded, description: 'Other City, Sample State, 00000 Leaving the sorting center' },
      { ...worded, description: 'Sample City, Sample State, 00000 Arrive at the last mile sorting and distribution center' },
      { ...worded, location: 'Sample City' },
    ]) expect(policy?.matches?.(placed, different)).toBe(false);
    expect(policy?.matches?.(worded, placed)).toBe(false);
  });

  it.each([
    ['jrt', 'accepted', '到达收货点', 'Arrived at the receiving point', 'ARRIVAL'],
    ['jrt', 'registered', '货物电子信息已经收到', 'The electronic cargo information has been received', ''],
    ['thhy', 'in_transit', '货物离开操作中心', 'Goods leave the operation center', 'SHIPMENT'],
    ['thhy', 'customs', '送交出口', 'Presented to export customs', 'CO_C_CR'],
    ['yto', 'accepted', '业务员收件', 'Picked up', '310'],
    ['china-post', 'out_for_delivery', '派送中', 'Out for delivery', 'O_014'],
    ['china-post', 'in_transit', '邮件到达【示例市揽投部】', 'Arrival', '713'],
  ])('lets a %s row shown in English take over the row stored in the carrier’s Chinese, by place and code', (source, stage, chinese, english, code) => {
    expect(sameInstantIdentityPolicy(source)).toBeUndefined();
    const policy = sameInstantIdentityPolicy(source, { supportsScanMatching: true });
    expect(policy).toEqual({
      sourceCarrierId: source, storedSources: [source], requireProviderCode: false, matchEachScan: true, matches: expect.any(Function),
      // YTO and China Post date local clocks, which adds the wall-clock pass.
      ...(['yto', 'china-post'].includes(source) ? { matchWallClock: true } : {}),
    });
    const stored = { stage, description: chinese, location: 'Sample Town', providerCode: code };
    const incoming = { ...stored, description: ` ${english.toUpperCase()} `, location: 'Sample Town ' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    // The other way round, should a release show the carrier's wording again.
    expect(policy?.matches?.(stored, incoming)).toBe(true);
    for (const different of [
      { ...stored, description: '合成的记录' },
      { ...stored, location: 'Another Town' },
      { ...stored, location: '' },
      { ...stored, description: english },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, providerCode: 'CO_C_CR' }, { ...stored, providerCode: 'SYNTHETIC' })).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
  });

  it('lets a YunExpress row read on China’s clock take over the row stored on another zone, by wall clock, place and wording', () => {
    expect(sameInstantIdentityPolicy('yunexpress')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('yunexpress', { supportsScanMatching: true });
    expect(policy).toMatchObject({
      sourceCarrierId: 'yunexpress', storedSources: ['yunexpress'], requireProviderCode: false, matchEachScan: true, matchWallClock: true,
    });
    const stored = { stage: 'in_transit', description: 'International flight has departed', location: '', providerCode: '' };
    const incoming = { ...stored, description: ' international flight  has departed' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(true);
    for (const different of [
      { ...stored, description: 'Clearence processing completed - Export' },
      { ...stored, location: 'Mainland China, CN' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
  });

  it('lets a ZTO International scan read on Shanghai’s clock take over the row stored on another zone, by wall clock, place, wording and code', () => {
    expect(sameInstantIdentityPolicy('zto-international')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('zto-international', { supportsScanMatching: true });
    expect(policy).toMatchObject({
      sourceCarrierId: 'zto-international', storedSources: ['zto-international'], requireProviderCode: false, matchEachScan: true, matchWallClock: true,
    });
    const stored = { stage: 'in_transit', description: 'Arrival at inward office of exchange.', location: 'Sample City01', providerCode: '230' };
    const incoming = { ...stored, description: ' arrival at inward  office of exchange.', location: 'Sample City01 ' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(true);
    expect(policy?.matches?.({ ...incoming, providerCode: '' }, stored)).toBe(true);
    for (const different of [
      { ...stored, description: 'Shipment out for delivery.' },
      { ...stored, location: 'Sample City02' },
      { ...stored, location: '' },
      { ...stored, providerCode: '220' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
  });

  it('lets a CNE row read on Beijing time take over the row stored on its place’s zone, by wall clock, place, wording and code', () => {
    expect(sameInstantIdentityPolicy('cne')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('cne', { supportsScanMatching: true });
    expect(policy).toMatchObject({
      sourceCarrierId: 'cne', storedSources: ['cne'], requireProviderCode: false, matchEachScan: true, matchWallClock: true,
    });
    const stored = { stage: 'in_transit', description: 'Arrived at destination', location: 'EXAMPLELAND', providerCode: '2' };
    const incoming = { ...stored, description: ' arrived at  Destination', location: 'EXAMPLELAND ' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(true);
    expect(policy?.matches?.({ ...incoming, providerCode: '' }, stored)).toBe(true);
    for (const different of [
      { ...stored, description: 'Handled by local carrier' },
      { ...stored, location: 'Example City' },
      { ...stored, location: '' },
      { ...stored, providerCode: '3' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
  });

  it('lets an MRW hub scan gain its bracketed label', () => {
    expect(sameInstantIdentityPolicy('mrw')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('mrw', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['mrw'], requireProviderCode: false, matchEachScan: true });
    const stored = { stage: 'in_transit', description: 'En tránsito', location: '', providerCode: '' };
    const incoming = { ...stored, location: '00000 Example (Plataforma)' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, incoming)).toBe(true);
    for (const different of [
      { ...stored, description: 'Envío en reparto' },
      { ...stored, location: '00001 Example' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.({ ...incoming, location: '00000 Example' }, stored)).toBe(false);
  });

  it('lets a Correos Express scan stored as a neutral update take its recognized label', () => {
    expect(sameInstantIdentityPolicy('correos-express')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('correos-express', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['correos-express'], requireProviderCode: false, matchEachScan: true });
    const stored = { stage: 'in_transit', description: 'Tracking update', location: 'EXAMPLE TOWN', providerCode: '' };
    const incoming = { ...stored, stage: 'exception', description: 'EN GESTIÓN' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, incoming)).toBe(true);
    for (const different of [{ ...stored, location: 'ANOTHER TOWN' }, { ...stored, description: 'EN REPARTO' }]) {
      expect(policy?.matches?.(incoming, different)).toBe(false);
    }
    expect(policy?.matches?.({ ...incoming, description: 'NEW LABEL' }, stored)).toBe(false);
  });
  it('lets a FedEx scan from the API or the tracking page take over the row the other stored at its instant, by stage', () => {
    expect(sameInstantIdentityPolicy('fedex')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('fedex', { supportsScanMatching: true });
    expect(policy?.storedSources).toEqual(['fedex']);
    const page = { stage: 'in_transit', description: 'Departed FedEx location', location: 'KOELN, DE', providerCode: '' };
    expect(policy?.matches?.({ ...page, description: 'Left FedEx origin facility', location: 'KOELN, DE, DE' }, page)).toBe(true);
    expect(policy?.matches?.({ ...page, stage: 'delivered', description: 'Delivered' }, page)).toBe(false);
  });

  it('lets a USPS scan whose delivery window or transit forecast USPS rewrote take over its row, and a place-less one by wall clock', () => {
    expect(sameInstantIdentityPolicy('usps')).toBeUndefined();
    const policy = sameInstantIdentityPolicy('usps', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['usps'], matchEachScan: true, matchWallClock: true });
    const round = { stage: 'out_for_delivery', description: 'Out for Delivery, Expected Delivery by 9:00pm', location: 'EXAMPLE CITY, CA 00000', providerCode: '' };
    for (const description of ['Out for Delivery, Expected Delivery Between 1:15pm and 4:15pm', 'Out for Delivery']) {
      expect(policy?.matches?.({ ...round, description }, round)).toBe(true);
    }
    expect(policy?.matches?.({ ...round, location: 'OTHER CITY, CA 00000' }, round)).toBe(false);
    const step = { stage: 'in_transit', description: 'In Transit, Arriving On Time', location: '', providerCode: '' };
    expect(policy?.matches?.({ ...step, description: 'In Transit to Next Facility' }, step)).toBe(true);
    expect(policy?.matches?.({ ...step, description: 'In Transit, Arriving Late' }, step)).toBe(true);
    for (const description of ['Arrived at USPS Regional Facility', 'Departed USPS Facility', '']) {
      expect(policy?.matches?.({ ...step, description }, step)).toBe(false);
    }
  });

  it('keeps UPS disabled for apps that cannot check scan evidence', () => {
    expect(sameInstantIdentityPolicy('ups')).toBeUndefined();
    expect(sameInstantIdentityPolicy('ups', { supportsScanMatching: false })).toBeUndefined();
  });

  it.each([
    ['CC_IM_START', 'in_transit', 'customs'],
    ['CC_EX_START', 'in_transit', 'customs'],
    ['CC_HO_IN_SUCCESS', 'in_transit', 'customs'],
    ['PU_PICKUP_SUCCESS', 'in_transit', 'accepted'],
    ['GTMS_STA_SIGNED', 'out_for_delivery', 'ready_for_pickup'],
    ['GTMS_DO_DEPART', 'ready_for_pickup', 'out_for_delivery'],
  ])('reconciles Cainiao %s stage corrections only with matching scan evidence', (providerCode, oldStage, stage) => {
    const policy = sameInstantIdentityPolicy('aliexpress', { supportsScanMatching: true });
    const stored = { stage: oldStage, description: 'Synthetic scan', location: '', providerCode: providerCode };
    const incoming = { ...stored, stage: stage };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.({ ...incoming, location: 'Example City' }, {
      ...stored, description: '[Example City] Synthetic scan',
    })).toBe(true);
    for (const different of [
      { ...stored, providerCode: '' }, { ...stored, providerCode: 'NEW_CODE' },
      { ...stored, location: 'Another City' }, { ...stored, description: 'Different scan' },
      { ...stored, stage: 'delivered' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    expect(policy?.matches?.(stored, incoming)).toBe(false);
  });

  it('matches UPS location enrichment only with unchanged wording and a known stage', () => {
    const policy = sameInstantIdentityPolicy('ups', { supportsScanMatching: true });
    expect(policy?.storedSources).toEqual(['ups']);
    const stored = { stage: 'accepted', description: 'Package collected', location: '', providerCode: '' };
    const incoming = { ...stored, description: 'PACKAGE  COLLECTED', location: 'Example City, France' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(stored, incoming)).toBe(true);
    expect(policy?.matches?.(incoming, incoming)).toBe(true);
    for (const different of [
      { ...stored, description: 'Package departed' },
      { ...stored, stage: 'in_transit' },
      { ...stored, location: 'Another City, France' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    for (const stage of ['', 'unknown']) {
      expect(policy?.matches?.({ ...incoming, stage }, { ...stored, stage })).toBe(false);
    }
    expect(policy?.matches?.({ ...incoming, description: '' }, { ...stored, description: '' })).toBe(false);
  });

  it('matches a UPS scan stored escaped and staged by its wording, before its code was kept', () => {
    const policy = sameInstantIdentityPolicy('ups', { supportsScanMatching: true });
    const stored = {
      stage: 'exception', description: 'We&#39;re sorry this package may experience a temporary delay.',
      location: 'EXAMPLE CITY, US', providerCode: '',
    };
    const incoming = { ...stored, stage: 'in_transit', description: "We're sorry this package may experience a temporary delay.", providerCode: 'Q5' };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    expect(policy?.matches?.(incoming, { ...stored, providerCode: 'Q5' })).toBe(true);
    for (const different of [
      { ...stored, providerCode: 'AR' },
      { ...stored, description: 'We&#39;re sorry, the receiver was not available.' },
      { ...stored, location: 'ANOTHER CITY, US' },
    ]) expect(policy?.matches?.(incoming, different)).toBe(false);
    // Without a code on the new scan, its stage must still agree.
    expect(policy?.matches?.({ ...incoming, providerCode: '' }, stored)).toBe(false);
    expect(policy?.matches?.({ ...incoming, stage: 'unknown' }, stored)).toBe(false);
  });
});
