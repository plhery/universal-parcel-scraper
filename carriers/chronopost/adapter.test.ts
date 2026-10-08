import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { sameInstantIdentityPolicy } from '../../app.js';
import { adapter, ChronopostTracker } from './adapter.js';
import { normalizeChronopostNumber, parseChronopostTrackingXml } from './parser.js';
import { chronopostStage } from './status.js';

const number = 'XT123456785TS';
const fixture = readFileSync(new URL('./fixtures/international.xml', import.meta.url), 'utf8');
const envelope = (body: string) => `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;
const empty = envelope(`<t:trackSkybillV2Response xmlns:t="http://cxf.tracking.soap.chronopost.fr/"><return><errorCode>0</errorCode><listEventInfoComp><skybillNumber>${number}</skybillNumber></listEventInfoComp></return></t:trackSkybillV2Response>`);
const scan = (code: string, date: string, label: string, infos: Record<string, string> = {}) => `<events><code>${code}</code>`
  + `<eventDate>${date}</eventDate><eventLabel>${label}</eventLabel><officeLabel>EXAMPLE HUB</officeLabel>`
  + Object.entries(infos).map(([name, value]) => `<infoCompList><name>${name}</name><value>${value}</value></infoCompList>`).join('')
  + '</events>';
const history = (...scans: string[]) => empty.replace('<skybillNumber>', scans.join('') + '<skybillNumber>');
const appointment = { 'Début créneau RDV': '27/06/2026 10:00', 'Fin créneau RDV': '27/06/2026 12:00' };
const prepared = scan('DC', '2026-06-26T18:00:00+02:00', "Colis en cours de préparation chez l'expéditeur", appointment);
const outForDelivery = scan('TA', '2026-06-27T07:05:43+02:00', 'Colis en cours de livraison par le livreur',
  { 'Début créneau RDV': '27/06/2026 10:00:00', 'Fin créneau RDV': '27/06/2026 12:00:00' });
const relay = { 'Type de retrait': 'Relais CHRONOPOST', 'Point de livraison': 'EXAMPLE RELAY - 1 EXAMPLE STREET - 00000 - EXAMPLE CITY - FR' };

describe('Chronopost direct tracking', () => {
  it('keeps the complete international history, precise clocks and a checked partner reference', () => {
    const result = parseChronopostTrackingXml(fixture, number);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_update: '2026-01-04T18:38:28+01:00', delivery_carrier: 'dpd-de',
      delivery_tracking_number: '12345678901234E', destination_country: 'DE' });
    expect(result.events).toHaveLength(7);
    expect(result.events?.map(event => event.provider_code)).toEqual(['SM', 'TP', 'O', 'TS', 'SC', 'DB', 'DC']);
    expect(result.events?.[1]).toMatchObject({ location: 'EXAMPLE DEPOT - DE (depot 0001)', time: '2026-01-04T18:09:18+01:00' });
    expect(result.events?.[5]).toMatchObject({ location: 'EXAMPLE TOWN, FR', stage: 'accepted' });
    expect(result.events?.[6]).toMatchObject({ location: '', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC SHOP|EXAMPLE STREET|00000|Point de livraison|Média utilisé|Rang/);
  });

  it('drops office labels that name a service, and the stored scan that had one keeps its row', () => {
    const office = (code: string, at: string, label: string, officeLabel: string) => `<events><code>${code}</code>`
      + `<eventDate>${at}</eventDate><eventLabel>${label}</eventLabel><officeLabel>${officeLabel}</officeLabel></events>`;
    const notice = 'Destinataire informé par SMS ou mail';
    const result = parseChronopostTrackingXml(history(
      office('DC', '2026-01-01T11:51:21+01:00', "Colis en cours de préparation chez l'expéditeur", 'Web Services'),
      office('TS', '2026-01-03T15:01:15+01:00', "Colis en cours d'acheminement", 'EXAMPLE HUB CHRONOPOST'),
      office('TP', '2026-01-04T18:09:18+01:00', "Colis en cours d'acheminement", 'CHRONOPOST NETWORKS'),
      office('SM', '2026-01-04T18:09:18+01:00', notice, "Service d'avisage"),
    ), number);
    const scans = (result.events ?? []).map(event => ({ time: event.time, stage: event.stage ?? '',
      description: event.description ?? '', location: event.location ?? '', providerCode: event.provider_code ?? '' }));
    expect(scans.map(event => [event.providerCode, event.location])).toEqual([
      ['SM', ''], ['TP', ''], ['TS', 'EXAMPLE HUB CHRONOPOST'], ['DC', ''],
    ]);
    // The rows an earlier release stored with the label; the hub's scan keeps its identity and is not asked.
    const labels: Record<string, string> = { SM: "Service d'avisage", TP: 'CHRONOPOST NETWORKS', DC: 'Web Services' };
    const stored = scans.filter(scan => labels[scan.providerCode]).map(scan => ({ ...scan, location: labels[scan.providerCode]! }));
    const policy = sameInstantIdentityPolicy('chronopost', { supportsScanMatching: true })!;
    // As the app matches: one row at the scan's instant, and that row matching no other scan of the batch.
    const takenOver = scans.filter(scan => labels[scan.providerCode]).map((scan) => {
      const rows = stored.filter(row => row.time === scan.time && policy.matches!(scan, row));
      const others = scans.filter(other => other.time === scan.time && rows[0] && policy.matches!(other, rows[0]));
      return rows.length === 1 && others.length === 1 ? rows[0]!.location : null;
    });
    expect(takenOver).toEqual(["Service d'avisage", 'CHRONOPOST NETWORKS', 'Web Services']);
  });

  it('keeps delivery when a later notification records activity', () => {
    const xml = fixture.replace('<code>TP </code>', '<code>DL </code>')
      .replace(/(<code>DL <\/code>[\s\S]*?<eventLabel>)[^<]+/, '$1Livraison effectuée');
    const result = parseChronopostTrackingXml(xml, number);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', stage_source: 'none' });
    expect(result.events?.[1]).toMatchObject({ stage: 'delivered', stage_source: 'wording:language' });
  });

  describe('redelivery day', () => {
    const scan = (code: string, at: string, label: string, extras = '') => `<events><code>${code}</code><eventDate>${at}</eventDate>`
      + `<eventLabel>${label}</eventLabel><officeLabel>EXAMPLE HUB CHRONOPOST</officeLabel>${extras}</events>`;
    const extra = (name: string, value: string) => `<infoCompList><name>${name}</name><value>${value}</value></infoCompList>`;
    const instruction = (day: string, at = '2026-01-05T10:00:00+01:00') => scan('CL ', at, 'Instruction de livraison reçue',
      extra('Origine', 'Client via page de suivi') + extra('Date de relivraison', day)
      + extra('Instruction choisie', 'Reprogrammation de la date de livraison'));
    const tracked = (...scans: string[]) => parseChronopostTrackingXml(fixture.replace('<skybillNumber>', `${scans.join('')}<skybillNumber>`), number);
    const sorting = (at: string) => scan('SD ', at, "Tri effectué dans l'agence de distribution");
    const round = (at: string) => scan('TA ', at, 'Colis en cours de livraison par le livreur');

    it('reads the day the recipient chose without projecting the instruction details', () => {
      const result = tracked(instruction('07/01/2026'), sorting('2026-01-07T05:40:00+01:00'), round('2026-01-07T07:50:00+01:00'));
      expect(result).toMatchObject({ status: 'out_for_delivery', expected_delivery: '2026-01-07' });
      expect(result.events?.[2]).toMatchObject({ description: 'Instruction de livraison reçue', provider_code: 'CL' });
      expect(JSON.stringify(result)).not.toMatch(/Client via page|Reprogrammation|07\/01\/2026/);
      expect(parseChronopostTrackingXml(fixture, number).expected_delivery).toBeNull();
    });

    it('uses only the newest instruction', () => {
      expect(tracked(instruction('07/01/2026'), instruction('09/01/2026', '2026-01-06T09:00:00+01:00')).expected_delivery).toBe('2026-01-09');
      for (const day of ['31/02/2026', '2026-01-09', 'Samedi']) {
        expect(tracked(instruction('07/01/2026'), instruction(day, '2026-01-06T09:00:00+01:00')).expected_delivery).toBeNull();
      }
    });

    it('ends the day after delivery, a failed attempt, a pickup point or a later scan', () => {
      const notice = scan('SM ', '2026-01-07T12:45:00+01:00', 'Destinataire informé par SMS ou mail', extra('Type du message', 'Echec de livraison'));
      expect(tracked(instruction('07/01/2026'), round('2026-01-07T07:50:00+01:00'), notice).expected_delivery).toBe('2026-01-07');
      for (const ending of [
        scan('D  ', '2026-01-07T10:55:00+01:00', 'Livraison effectuée'),
        scan('NA ', '2026-01-07T12:20:00+01:00', "Echec de livraison, en attente d'instructions pour nouvelle livraison"),
        scan('AB ', '2026-01-07T10:10:00+01:00', 'Colis mis à disposition au point de retrait'),
        sorting('2026-01-08T05:40:00+01:00'),
      ]) {
        expect(tracked(instruction('07/01/2026'), round('2026-01-07T07:50:00+01:00'), ending).expected_delivery).toBeNull();
      }
    });
  });

  it('does not let a relayed code override contradictory wording', () => {
    expect(chronopostStage('DC', 'Livraison effectuée')).toMatchObject({ stage: 'delivered', source: 'wording:language' });
    expect(chronopostStage('UNKNOWN', 'Unmapped carrier message')).toEqual({ stage: 'pending', source: 'none' });
  });

  it.each([
    ['T', "Entrée dans l'agence", 'in_transit'],
    ['TT', 'Colis remis par le relais Pickup au chauffeur', 'in_transit'],
    ['EI', 'Colis entré dans le pays de destination', 'in_transit'],
    ['A2', "Colis retardé à l'agence de distribution", 'in_transit'],
    ['IS', 'Livraison prévue lundi prochain', 'in_transit'],
    ['TA', 'Colis en cours de livraison', 'out_for_delivery'],
    ['RB', 'Colis en cours de livraison au point de retrait', 'in_transit'],
    ['AB', 'Colis mis à disposition au point de retrait', 'ready_for_pickup'],
    ['P', "Echec de livraison suite à l'absence du destinataire.", 'failed_attempt'],
    ['SK', "Colis en attente d'informations complémentaires de votre part", 'exception'],
  ])('maps the observed %s scan when its wording agrees', (code, label, stage) => {
    expect(chronopostStage(code, label)).toEqual({ stage, source: 'carrier_map' });
    expect(chronopostStage(code, 'Unmapped carrier message')).toEqual({ stage: 'pending', source: 'none' });
  });

  it('reads the newest appointment window or redelivery day until it passes or the parcel stops moving', () => {
    expect(parseChronopostTrackingXml(history(prepared), number)).toMatchObject({
      current_stage: 'registered', expected_delivery: '2026-06-27 10:00–12:00' });
    expect(parseChronopostTrackingXml(history(prepared, outForDelivery), number)).toMatchObject({
      current_stage: 'out_for_delivery', expected_delivery: '2026-06-27 10:00–12:00' });
    const failed = scan('P', '2026-06-27T11:02:54+02:00', "Echec de livraison suite à l'absence du destinataire.");
    expect(parseChronopostTrackingXml(history(prepared, outForDelivery, failed), number)).toMatchObject({
      status: 'exception', current_stage: 'failed_attempt', expected_delivery: null });
    const instruction = scan('CL', '2026-06-27T11:10:00+02:00', 'Instruction de livraison reçue',
      { ...appointment, 'Date de relivraison': '29/06/2026' });
    expect(parseChronopostTrackingXml(history(prepared, outForDelivery, failed, instruction), number)).toMatchObject({
      current_stage: 'in_transit', expected_delivery: '2026-06-29' });
    const delayed = scan('A2', '2026-06-30T09:00:00+02:00', "Colis retardé à l'agence de distribution");
    expect(parseChronopostTrackingXml(history(prepared, outForDelivery, failed, instruction, delayed), number))
      .toMatchObject({ current_stage: 'in_transit', expected_delivery: null });
    const invalid: Record<string, string>[] = [{ 'Début créneau RDV': '31/02/2026 10:00', 'Fin créneau RDV': '31/02/2026 12:00' },
      { 'Début créneau RDV': '27/06/2026 12:00', 'Fin créneau RDV': '27/06/2026 10:00' },
      { 'Début créneau RDV': '27/06/2026 10:00', 'Fin créneau RDV': '28/06/2026 12:00' }, { 'Date de relivraison': '2026-06-29' }];
    for (const infos of invalid) {
      const xml = history(scan('DC', '2026-06-26T18:00:00+02:00', "Colis en cours de préparation chez l'expéditeur", infos));
      expect(parseChronopostTrackingXml(xml, number).expected_delivery).toBeNull();
    }
  });

  it('names the pickup point and its address only while the parcel waits there, and dates the delivery', () => {
    const arrived = scan('AB', '2026-06-27T11:07:04+02:00', 'Colis mis à disposition au point de retrait', relay);
    const dropOff = scan('RB', '2026-06-27T11:08:00+02:00', 'Colis en cours de livraison au point de retrait',
      { 'Point de retrait': relay['Point de livraison'] });
    const waiting = parseChronopostTrackingXml(history(prepared, outForDelivery, arrived, dropOff), number);
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      pickup_point: 'EXAMPLE RELAY\n1 EXAMPLE STREET\n00000 EXAMPLE CITY', expected_delivery: null });
    expect(waiting.events?.[0]).toMatchObject({ provider_code: 'RB', stage: 'ready_for_pickup', stage_source: 'none' });
    expect(waiting.events?.map(event => event.location)).not.toContain(expect.stringMatching(/EXAMPLE STREET|00000/));
    const collected = scan('D', '2026-06-27T16:04:28+02:00', 'Livraison effectuée', relay);
    const notified = scan('SM', '2026-06-27T16:05:00+02:00', 'Destinataire informé par SMS ou mail');
    const delivered = parseChronopostTrackingXml(history(prepared, arrived, collected, notified), number);
    expect(delivered).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-06-27T16:04:28+02:00', expected_delivery: null });
    expect(delivered.pickup_point).toBeUndefined();
    // The pickup point can be named as such, without a collection type. An
    // address in another layout leaves the name alone.
    const named = (point: string) => parseChronopostTrackingXml(history(prepared, scan('AB', '2026-06-27T11:07:04+02:00',
      'Colis mis à disposition au point de retrait', { 'Point de retrait': point })), number).pickup_point;
    expect(named('EXAMPLE KIOSK - EXAMPLESTR. 1  - 00000 - EXAMPLE CITY - DE')).toBe('EXAMPLE KIOSK\nEXAMPLESTR. 1\n00000 EXAMPLE CITY');
    expect(named('EXAMPLE RELAY - EXAMPLE STREET - EXAMPLE CITY - FR')).toBe('EXAMPLE RELAY');
    expect(named('EXAMPLE RELAY - 1 EXAMPLE STREET - 00000 - FR')).toBe('EXAMPLE RELAY');
    // A home address or an unexpected layout never becomes a pickup point.
    const unnamed: Record<string, string>[] = [{ 'Point de livraison': relay['Point de livraison'] },
      { ...relay, 'Point de livraison': 'EXAMPLE RELAY - FR' }];
    for (const infos of unnamed) {
      const result = parseChronopostTrackingXml(history(scan('AB', '2026-06-27T11:07:04+02:00',
        'Colis mis à disposition au point de retrait', infos)), number);
      expect(result).toMatchObject({ current_stage: 'ready_for_pickup' });
      expect(result.pickup_point).toBeUndefined();
    }
  });

  it('stages the round, the courier on the way to a pickup point and its arrival there from the map', () => {
    const round = scan('TA', '2026-06-27T07:05:43+02:00', 'Colis en cours de livraison');
    const onTheWay = scan('RB', '2026-06-27T11:06:45+02:00', 'Colis en cours de livraison au point de retrait');
    const arrived = scan('AB', '2026-06-27T11:07:04+02:00', 'Colis mis à disposition au point de retrait', relay);
    const result = parseChronopostTrackingXml(history(prepared, round, onTheWay, arrived), number);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      pickup_point: 'EXAMPLE RELAY\n1 EXAMPLE STREET\n00000 EXAMPLE CITY' });
    expect(result.events?.slice(0, 3)).toMatchObject([
      { provider_code: 'AB', stage: 'ready_for_pickup', stage_source: 'carrier_map' },
      { provider_code: 'RB', stage: 'in_transit', stage_source: 'carrier_map' },
      { provider_code: 'TA', stage: 'out_for_delivery', stage_source: 'carrier_map' }]);
  });

  it('preserves local and invalid clocks without inventing instants', () => {
    const xml = fixture.replaceAll('+01:00', '').replace('2026-01-04T18:38:28', '2026-02-30T18:38:28+99:00');
    const result = resolveResult(parseChronopostTrackingXml(xml, number));
    expect(result.last_update).toBeNull();
    expect(result.events[0]).toMatchObject({ provider_time_text: '2026-02-30T18:38:28+99:00', instant: null });
    expect(result.events[1]).toMatchObject({ local_time: '2026-01-04T18:09:18', instant: null });
    expect(result.events.every(event => !event.time)).toBe(true);
  });

  it('sorts verified instants, including different offsets, before choosing the status', () => {
    const xml = fixture.replace('2026-01-04T18:09:18+01:00', '2026-01-05T01:09:18+09:00')
      .replace('2026-01-04T18:38:28+01:00', '2026-01-04T16:38:28Z');
    const result = parseChronopostTrackingXml(xml, number);
    expect(result.events?.map(event => event.provider_code).slice(0, 2)).toEqual(['SM', 'TP']);
  });

  it.each([
    ['GEO/12345678901234A', 'DE'], ['12345678901234E', 'DE'], ['GEO/12345678901234E', 'GB'],
  ])('does not assign the German network from %s and %s alone', (reference, country) => {
    const result = parseChronopostTrackingXml(fixture.replace('GEO/12345678901234E', reference)
      .replace('EXAMPLE CITY - DE', `EXAMPLE CITY - ${country}`), number);
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBe(reference.replace('GEO/', ''));
  });

  it('drops the reference that repeats the skybill, and keeps a partner reference beside it', () => {
    const own = '<infoCompList><name>Numéro partenaire</name><value>GEO/XT123456785248R</value></infoCompList>';
    for (const reference of ['GEO/XT123456785248R', `GEO/${number}`]) {
      const result = parseChronopostTrackingXml(fixture.replace('GEO/12345678901234E', reference), number);
      expect(result.delivery_tracking_number).toBeUndefined();
      expect(result.delivery_carrier).toBeUndefined();
    }
    expect(parseChronopostTrackingXml(fixture.replace('<infoCompList><name>Rang</name>', `${own}<infoCompList><name>Rang</name>`), number))
      .toMatchObject({ delivery_carrier: 'dpd-de', delivery_tracking_number: '12345678901234E' });
  });

  it('refuses conflicting partner references and destination countries', () => {
    const xml = fixture.replace('<infoCompList><name>Rang</name>',
      '<infoCompList><name>Numéro partenaire</name><value>GEO/OTHER12345</value></infoCompList>'
      + '<infoCompList><name>Point de livraison</name><value>EXAMPLE CITY - CH</value></infoCompList><infoCompList><name>Rang</name>');
    const result = parseChronopostTrackingXml(xml, number);
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.destination_country).toBeUndefined();
  });

  it('recognizes only a bound empty history as not-found', () => {
    expect(() => parseChronopostTrackingXml(empty, number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const xml of [empty.replace(number, 'XY123456785FR'), empty.replace('<errorCode>0', '<errorCode>9'),
      empty.replace(/<listEventInfoComp>.*?<\/listEventInfoComp>/, ''), '']) {
      expect(() => parseChronopostTrackingXml(xml, number)).toThrow(expect.objectContaining({ kind: expect.stringMatching(/schema|indeterminate/) }));
    }
  });

  it.each([
    fixture.replace(number, number + 'ABCD'),
    fixture.replace(`<skybillNumber>${number}</skybillNumber>`, `<skybillNumber>${number}</skybillNumber><skybillNumber>${number}</skybillNumber>`),
    fixture.replace('<errorCode>0</errorCode>', '<errorCode><value>0</value></errorCode>'),
    fixture.replace('<eventLabel>', '<eventLabel><value>').replace('</eventLabel>', '</value></eventLabel>'),
    fixture.replace('http://cxf.tracking.soap.chronopost.fr/', 'https://example.invalid/'),
    fixture.replace('<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE soap:Envelope [<!ENTITY test "invalid">]>'),
    fixture.replace('</soap:Body>', '<return/></soap:Body>'),
    fixture.slice(0, -40),
  ])('rejects malformed, ambiguous or mismatched replies', xml => {
    expect(() => parseChronopostTrackingXml(xml, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('bounds the XML body and event count', () => {
    expect(() => parseChronopostTrackingXml(' '.repeat(2_000_001), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const scan = '<events><eventLabel>Colis en cours d\'acheminement</eventLabel></events>';
    expect(() => parseChronopostTrackingXml(empty.replace('<skybillNumber>', scan.repeat(501) + '<skybillNumber>'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('distinguishes SOAP faults and blocked HTML from missing parcels', () => {
    expect(() => parseChronopostTrackingXml(envelope('<s:Fault><faultstring>Unavailable</faultstring></s:Fault>'), number))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseChronopostTrackingXml('<html><title>Just a moment...</title></html>', number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('shares the whole-number validation, claims its own prefixes and asks Chronopost for a generic postal number over HTTP', async () => {
    expect(normalizeChronopostNumber('xt 123456785 ts')).toBe(number);
    expect(normalizeChronopostNumber('12345678901234E')).toBe('12345678901234E');
    for (const invalid of ['12345678901234A', '6A00000000000', '12345678901234', number + '<tag>']) {
      expect(() => normalizeChronopostNumber(invalid)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chronopost', confidence: 'high' });
    expect(recognitionCandidates('RA123456785DE').map(candidate => candidate.carrier)).toContain('chronopost');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!(number)).resolves.toMatchObject({ known: true, lastActivityAt: '2026-01-04T17:38:28.000Z' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('uses the supplied transport, user agent, signal and remaining budget and records one lookup', async () => {
    const steps: unknown[] = [];
    const lookups: unknown[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(fixture));
    const tracker = new ChronopostTracker({ fetcher, userAgent: 'Synthetic host/1.0',
      recorder: { step: step => steps.push(step), lookup: lookup => lookups.push(lookup) } });
    await tracker.fetch(number, { signal: new AbortController().signal, budgetMs: 900 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS');
    expect(init).toMatchObject({ method: 'POST', headers: { 'User-Agent': 'Synthetic host/1.0' }, cache: 'no-store', signal: expect.any(AbortSignal) });
    expect(init!.body).toContain(`<skybillNumber>${number}</skybillNumber>`);
    expect(steps).toHaveLength(1);
    expect(lookups).toHaveLength(1);
  });

  it.each([404, 410, 429, 500])('preserves a rejected HTTP %i as an upstream failure', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(status === 500
      ? envelope('<s:Fault/>') : '<html>Unavailable</html>', { status, headers: { 'Retry-After': '30' } }));
    await expect(new ChronopostTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: status === 429 ? 'rate_limited' : 'indeterminate' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not accept an empty success-shaped body on HTTP 500 as not-found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(empty, { status: 500 }));
    await expect(new ChronopostTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
  });

  it('returns negative recognition only for invalid inputs or the bound unknown reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(empty));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!('123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(number)).resolves.toEqual({ known: false });
    fetcher.mockImplementation(async () => new Response(empty.replace(number, 'XY123456785FR')));
    await expect(instance.recognize!(number)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('does not make a request after caller cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const reason = new Error('cancelled');
    await expect(new ChronopostTracker({ fetcher }).fetch(number, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([true, false])('routes the checked foreign reference to its own adapter, confirmed=%s', async known => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(fixture));
    const partner = vi.fn().mockImplementation(async () => {
      if (!known) throw new NotFoundError('DPD Germany');
      return { status: 'in_transit', events: [{ time: '2026-01-04T18:09:18+01:00',
        description: 'Your parcel is on its way', stage: 'in_transit' }] };
    });
    const registry = new AdapterRegistry({ factories: { chronopost: adapter,
      'dpd-de': () => ({ id: 'dpd-de', steps: ['direct'], track: partner }) },
    carriers: { chronopost: 'chronopost', 'dpd-de': 'dpd-de' } },
    { fetcher, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null, env: {} });
    const response = await createTracker({ registry, providers: [] }).track({ number, carrier: 'chronopost' });
    expect(response).toMatchObject({ carrier: 'chronopost', source: 'chronopost', handoff: {
      carrier: 'dpd-de', number: '12345678901234E', confirmed: known }, attempts: [
      { source: 'chronopost', kind: 'ok' }, { source: 'dpd-de', kind: known ? 'ok' : 'not_found' },
    ] });
    expect(response.result.events).toHaveLength(7);
    expect(Boolean(response.handoff?.result)).toBe(known);
    expect(partner).toHaveBeenCalledWith({ number: '12345678901234E' },
      expect.objectContaining({ signal: expect.any(AbortSignal), budgetMs: expect.any(Number) }));
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
