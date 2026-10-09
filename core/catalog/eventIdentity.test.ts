import { describe, expect, it } from 'vitest';
import { sameInstantIdentityPolicy } from '../../app.js';

describe('same-instant identity policies', () => {
  it('requires India Post scans to retain their provider code, and lets a scan abroad take its own offset', () => {
    expect(sameInstantIdentityPolicy('india-post')).toEqual({
      sourceCarrierId: 'india-post', storedSources: ['india-post'], requireProviderCode: true, relabelledFrom: 'Asia/Kolkata',
    });
  });

  it('requires Amazon Shipping scans to retain their event code', () => {
    expect(sameInstantIdentityPolicy('amazon-shipping')).toEqual({
      sourceCarrierId: 'amazon-shipping', storedSources: ['amazon-shipping'], requireProviderCode: true,
    });
  });

  it('keeps DPD postcode variants and universal copies eligible', () => {
    expect(sameInstantIdentityPolicy('dpd')).toEqual({
      sourceCarrierId: 'dpd', storedSources: ['dpd', 'unknown'], requireProviderCode: false,
    });
  });

  it.each(['dhl', 'la-poste', '', 'toString'])('does not opt in %s', (source) => {
    expect(sameInstantIdentityPolicy(source)).toBeUndefined();
    expect(sameInstantIdentityPolicy(source, { supportsScanMatching: true })).toBeUndefined();
  });

  it.each([
    ['austrian-post', 'in_transit', 'Sendung von Postbetreiber Zielland übernommen', 'PLZ DE', 'Synthetic exchange office'],
    ['austrian-post', 'out_for_delivery', 'Sendung in Zustellung', 'PLZ FR 1', 'Zustellbasis Beispielort'],
    ['chronopost', 'registered', "Colis en cours de préparation chez l'expéditeur", 'Web Services', 'CORBAS CHRONOPOST'],
    ['chronopost', 'in_transit', 'Destinataire informé par SMS ou mail', 'Service d’avisage', 'Example Town - DE (depot 0001)'],
    ['chronopost', 'in_transit', "Colis en cours d'acheminement", 'CHRONOPOST NETWORKS', 'Example Town - DE (depot 0001)'],
    ['dpd-fr', 'delivered', 'Votre colis est livré', 'Livré au destinataire', 'Agence DPD de Example Town (1)'],
    ['posti', 'in_transit', 'Item has been registered The item can be registered several times during delivery.', 'ULKOMAILLA', 'EXAMPLE CITY'],
    ['posti', 'delivered', 'Item delivered to the recipient.', 'ULKOMAILLA', 'EXAMPLE CITY'],
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
